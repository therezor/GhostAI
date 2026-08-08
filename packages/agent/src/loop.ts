/**
 * The agent loop.
 *
 * One turn is: append what the user said, then repeat — assemble a request from
 * history, stream the model's answer, run whatever tools it asked for, append
 * the results — until the model answers without calling a tool, or a cap stops
 * it. The loop is an async generator, so a caller drives it with `for await` and
 * gets cancellation for free: abandoning the iterator unwinds the turn through
 * the same `finally` a completed turn runs.
 *
 * Everything here is either a cost decision or a correctness decision, and the
 * ones that look like details are the ones that matter:
 *
 *  - **The nonce and the tool definitions are computed once per turn**, not per
 *    iteration. Both sit in the part of the prompt providers cache; regenerating
 *    them mid-turn would rewrite the prefix and throw the cache away five times
 *    over for no semantic change.
 *  - **The caps are checked at the top of the iteration.** Checking after the
 *    provider call lets a turn exceed its wall-clock cap by one full request
 *    plus its tool calls, which on a slow local model is minutes.
 *  - **Steering is drained before the caps are checked**, so a correction that
 *    arrives during the last legal iteration is still in history when that
 *    iteration builds its request.
 *  - **A steering message arriving while the model composes its final answer
 *    makes the loop `continue`, not `break`.** Ending the turn there discards
 *    the correction, and from the outside a discarded correction is
 *    indistinguishable from an ignored one.
 *  - **An error response is never appended to history.** A provider 400 written
 *    into the transcript is replayed on every subsequent request in that
 *    session, so one malformed turn becomes a permanently poisoned session.
 *  - **The results of one assistant turn are appended in one transaction.** A
 *    partial write is an orphaned tool result, and `findLegalStart` then has to
 *    repair it on every later request.
 *
 * Running the tools themselves lives in `dispatch.ts` — authorisation, the
 * approval gate, the heartbeat, truncation and the envelope — along with the
 * two invariants that only that file can hold: every call gets an answer, and
 * permission is checked in exactly one place.
 *
 * The signal threads from the caller through the provider request, tool
 * execution and any child process. There is one cancellation mechanism, and
 * this is it.
 */

import {
  DEFAULT_AGENT_ID,
  DEFAULT_MAX_TOOL_RESULT_CHARS,
  DEFAULT_WORKSPACE_ID,
  GhostError,
  abortedError,
  assistantMessage,
  deriveSessionTitle,
  isAbortError,
  silentLogger,
  systemClock,
  systemMessage,
  textOf,
  toGhostError,
  userMessage,
  type Clock,
  type ErrorKind,
  type Logger,
  type SessionStore,
  type TurnStatsRecord,
} from '@ghostbot/core';
import {
  AgentDefaultsSchema,
  SUBAGENT_METADATA_KEY,
  SUBAGENT_ORIGIN,
  newUuid,
  withSubagentRun,
  type AgentDefaults,
  type AgentToolbox,
  type ContentPart,
  type ErrorCode,
  type StopReason,
  type SubagentLineage,
  type SubagentRunRef,
  applyToolPrompts,
  type ToolCall,
  type ToolDefinition,
  type ToolPromptOverrides,
  type ToolsConfig,
  type Usage,
} from '@ghostbot/protocol';
import {
  emptyUsage,
  type ChatProvider,
  type ChatRequest,
  type ChatResult,
} from '@ghostbot/providers';
import {
  createToolOutputNonce,
  systemRandom,
  type JailResolver,
  type RandomSource,
} from '@ghostbot/security';
import {
  DEFAULT_TOOLS_CONFIG,
  type AutomationResolver,
  type RunnerResolver,
  type ToolboxRequest,
  type ToolContext,
  type ToolExecution,
  type ToolScope,
} from '@ghostbot/tools';

import type { ApprovalGate } from './approval.js';
import { materialiseAttachments, type AttachmentCache } from './attachments.js';
import {
  TOOL_HEARTBEAT_MS,
  ToolDispatcher,
  parseToolArgs,
  type TurnScope,
} from './dispatch.js';
import type { AgentEvent } from './events.js';
import {
  buildRawPrompt,
  buildRuntimeBlock,
  buildStaticPrompt,
  type PromptToolbox,
  type PromptTools,
  contributorSections,
  runtimeReminder,
  type ContextContributor,
  type PromptAgent,
  type RuntimePromptContext,
  type StaticPromptContext,
} from './prompt.js';
import { SteeringQueue, steeringText } from './steering.js';
import {
  refuseDelegation,
  refusedExecution,
  parseTask,
  subagentDefinition,
  subagentResult,
  subagentSessionKey,
  type SubagentBinding,
} from './subagent.js';
import { textToolCallCorrection, textToolCallName } from './text-tool-call.js';

function maxIterationsText(maxIterations: number): string {
  return (
    `I stopped after ${String(maxIterations)} tool iterations without finishing. ` +
    `Tell me which part to focus on, or break the task into smaller steps.`
  );
}

function wallTimeoutText(elapsedMs: number, capMs: number): string {
  return (
    `I ran out of time for this turn — ${String(Math.round(elapsedMs / 1000))}s against a ` +
    `${String(Math.round(capMs / 1000))}s cap. Ask me to continue, or narrow the task.`
  );
}

/**
 * Core error kinds → the wire's error codes.
 *
 * A mapping table rather than a chain of conditionals, so a kind added to the
 * taxonomy without a code here lands on `internal` rather than on whichever
 * branch happened to be last.
 */
const ERROR_CODES: Partial<Record<ErrorKind, ErrorCode>> = {
  invalid_input: 'bad_request',
  not_found: 'not_found',
  conflict: 'bad_request',
  permission_denied: 'unauthorized',
  jail_escape: 'unauthorized',
  network: 'provider_error',
  provider: 'provider_error',
  tool: 'tool_error',
  timeout: 'provider_error',
  rate_limited: 'rate_limited',
  config: 'config_invalid',
};

function errorCodeFor(kind: ErrorKind): ErrorCode {
  return ERROR_CODES[kind] ?? 'internal';
}

function sumOptional(
  a: number | undefined,
  b: number | undefined,
): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return a + b;
}

/** Adds one request's usage to the turn's running total. */
function accumulateUsage(total: Usage, next: Usage): Usage {
  const cachedTokens = sumOptional(total.cachedTokens, next.cachedTokens);
  const reasoningTokens = sumOptional(
    total.reasoningTokens,
    next.reasoningTokens,
  );
  return {
    promptTokens: total.promptTokens + next.promptTokens,
    completionTokens: total.completionTokens + next.completionTokens,
    totalTokens: total.totalTokens + next.totalTokens,
    ...(cachedTokens === undefined ? {} : { cachedTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
  };
}

/**
 * The agent a loop belongs to, as the loop needs it.
 *
 * `PromptAgent` plus the id, which is what `turn.start` reports and what the
 * turn's stats row records. Deliberately not the whole `EffectiveAgent`: the
 * model, the tools and the approvals have already been turned into the
 * collaborators around this loop by the time it is constructed, and carrying
 * them again would invite something below here to read the copy instead.
 */
/**
 * What a turn works out once and reuses on every iteration.
 *
 * Exactly one of the two is populated, decided by `promptMode`. A discriminated
 * union would be tidier to read and worse to use: both fields are consumed by
 * one `#composePrompt` that already branches on the mode, and a second
 * discriminant would have to be kept in step with it.
 */
interface PromptPreamble {
  /** Template mode: the cached static half, built once. Empty in raw mode. */
  readonly staticPrompt: string;
  /** Raw mode: the contributor sections, which may have done I/O. Empty otherwise. */
  readonly staticSections: readonly string[];
}

interface LoopAgent extends PromptAgent {
  readonly id: string;
  /**
   * This agent's replacements for what its tools say about themselves.
   *
   * Beside the prompt templates rather than passed alongside the registry,
   * because it is the same kind of thing: text the operator owns, scoped to one
   * agent. The registry's definitions are memoised across every agent in the
   * process, so this cannot be applied there.
   */
  readonly toolPrompts?: ToolPromptOverrides;
  /**
   * The operator's wording for the three sections that describe tools.
   *
   * Here rather than on `PromptAgent` because an agent always has an identity
   * and does not always have tools: the prompt layer receives these as
   * `PromptTools`, which it is handed or is not. Keeping them on the resolved
   * agent — where the config puts them — and routing them across that boundary
   * is the loop's job, and is the only thing that knows whether this turn has
   * tools at all.
   */
  readonly platformPrompt?: string;
  readonly toolboxPrompt?: string;
  readonly toolPolicyPrompt?: string;
}

export interface AgentLoopOptions {
  /** Already wrapped in `withResilience` by `createProvider`. */
  readonly provider: ChatProvider;
  /**
   * What this loop may call.
   *
   * A `ToolScope` rather than the registry itself, so an agent restricted to a
   * subset is not a special case anywhere below here — `ToolRegistry` satisfies
   * it, and `registry.select(...)` returns a view that also does.
   */
  readonly tools: ToolScope;
  readonly store: SessionStore;
  /**
   * Supplies the jail for a turn, keyed by its session's workspace.
   *
   * A resolver rather than one jail, because a session records which workspace
   * it belongs to and two sessions in one process can be in different ones.
   * `singleJail(jail)` is the adapter for a caller that has only one.
   */
  readonly jails: JailResolver;
  /**
   * Supplies the container a turn's `exec` runs in, keyed the same way.
   *
   * Absent — or returning `undefined` — means the host, which is what `exec`
   * has always done. A resolver rather than one runner for the same reason as
   * `jails`: two sessions in one process can be bound to different agents, and
   * therefore to different sandboxes.
   */
  readonly runners?: RunnerResolver;
  /**
   * Supplies the scheduler a turn's `automation` tool writes through, keyed the
   * same way and for the same reason: the port is scoped to the agent and the
   * session, so a job records who asked for it and an agent cannot reach
   * another's.
   *
   * Absent means this build has no scheduler, and the tool says so.
   */
  readonly automation?: AutomationResolver;
  /** Which toolbox this agent works in. Defaults to the host. */
  readonly toolbox?: AgentToolbox;
  /** The toolbox's declared contents, injected into the static prompt. */
  readonly toolboxPrompt?: PromptToolbox;
  /** Defaults to the schema's defaults, so a caller without a config file works. */
  readonly config?: AgentDefaults;
  readonly toolsConfig?: ToolsConfig;
  /** Overrides `config.model`. One of the two must be non-empty. */
  readonly model?: string;
  /**
   * Which agent this loop is. Absent is the unnamed default.
   *
   * Constructor-bound, like the model and the tools, because it is the same
   * kind of decision: a loop *is* one agent. The composition root builds one
   * per agent rather than making every turn re-resolve who it belongs to, and
   * a turn already running therefore keeps the agent it started under.
   */
  readonly agent?: LoopAgent;
  /**
   * The zone the prompt's clock is printed in — the install's `ui.timezone`.
   *
   * A thunk rather than a value, because it is read once per turn and an
   * operator who changes it in settings should not have to restart to be
   * believed. Absent means the host zone, which keeps a caller that has no
   * config working exactly as before.
   *
   * This is the same zone the `automation` tool's cron expressions are read in,
   * and that is the whole point of threading it this far: the tool tells the
   * model to write the hour it sees on the clock beside it, which is only true
   * if the clock and the scheduler agree.
   */
  readonly timeZone?: () => string;
  readonly contributors?: readonly ContextContributor[];
  /**
   * Who to ask before a tool whose permission is `ask` runs.
   *
   * Absent means nobody is there to ask, and `ask` then runs the tool — today's
   * behaviour, and what keeps a terminal session unchanged. `deny` is enforced
   * with or without a gate. Any transport that exposes this agent to something
   * other than its operator's own keyboard should install one.
   */
  readonly approvals?: ApprovalGate;
  /**
   * The agents this one may delegate to, keyed by the tool name each is called
   * by. Built with `subagentMap`.
   *
   * One map, not two, for the reason `#createLoop` builds one `ToolPermissions`:
   * the definitions the model is shown and the permission `#authorize` reads
   * both come from here, so a subagent cannot be advertised and then refused.
   */
  readonly subagents?: ReadonlyMap<string, SubagentBinding>;
  /**
   * Resolves the loop for a subagent. `Runtime.loopFor` satisfies it.
   *
   * A resolver rather than a map of loops, because loops are built lazily and
   * cached with an LRU — handing this one a set of them at construction would
   * build every subagent's provider whether or not it was ever used, and pin
   * the ones that were not.
   *
   * `null` means that agent cannot run, which is a refusal the model is told
   * about rather than an error.
   */
  readonly resolveLoop?: (agentId: string) => AgentLoop | null;
  readonly steering?: SteeringQueue;
  readonly clock?: Clock;
  readonly logger?: Logger;
  /** The nonce source. Never pin this outside a test — see `@ghostbot/security`. */
  readonly random?: RandomSource;
  /** Turn ids. Injected so a test asserts on stable values. */
  readonly newId?: () => string;
  /** Source for the exec env allow-list. Defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** `0` disables the heartbeat. */
  readonly toolHeartbeatMs?: number;
  /** Head+tail budget for one tool result before it enters history. */
  readonly maxToolResultChars?: number;
}

export interface TurnInput {
  readonly sessionKey: string;
  /** A string for the common case; parts for an image the user attached. */
  readonly content: string | readonly ContentPart[];
  /** The turn's cancellation. Threads to the provider, the tools and their children. */
  readonly signal?: AbortSignal;
  /** Where the message came from. Recorded as the session's origin. */
  readonly channel?: string;
  readonly agentId?: string;
  /**
   * The workspace to create the session in, if it does not exist yet.
   *
   * Ignored for a session that already exists — see `run`. A transport that
   * mints a session key passes what the user picked; the loop never trusts it
   * over the stored row.
   */
  readonly workspaceId?: string;
  /** Supplied by the caller when it has already told a client the id. */
  readonly turnId?: string;
  /**
   * The agents already running above this turn, oldest first.
   *
   * Empty for a turn a person started. Carried on the input rather than held on
   * the loop because loops are one per agent and shared through an LRU cache —
   * anything depth-shaped stored on the object would be wrong the moment the
   * same agent appeared at two depths. See `refuseDelegation`.
   */
  readonly chain?: readonly string[];
  /**
   * The session a person is looking at, when this turn is a subagent's.
   *
   * Absent means this turn *is* that session. It reaches `ApprovalRequest`, and
   * nothing else reads it — see `ApprovalRequest.rootSessionKey` for why an
   * answer scoped to "this session" has to mean the conversation rather than
   * the delegation.
   */
  readonly rootSessionKey?: string;
}

/** What the context inspector knows about the session it is inspecting. */
export interface PromptPreviewInput {
  readonly sessionKey: string;
  /** Defaults to `web`. The CLI's `/context` passes `cli`. */
  readonly channel?: string;
  readonly agentId?: string;
}

/**
 * The prompt as two messages at two ends of the request, kept apart.
 *
 * They are billed differently and that is the reason they are separate here:
 * `staticPrompt` is the system message and the provider's cached prefix, while
 * `runtimeBlock` is the trailing turn re-read at full price on every iteration.
 * Joining them would hand the inspector a single figure whose whole purpose is
 * to be broken in two.
 *
 * In `raw` mode `runtimeBlock` is empty — the operator's template is one blob
 * placed entirely in the system message, which is the cost that mode chooses.
 */
export interface PromptPreview {
  readonly staticPrompt: string;
  readonly runtimeBlock: string;
}

export interface TurnResult {
  readonly turnId: string;
  readonly stopReason: StopReason;
  /** Provider requests made. Never more than `config.maxToolIterations`. */
  readonly iterations: number;
  readonly usage: Usage;
  /** The final answer, or the explanation of why there is none. */
  readonly text: string;
}

export class AgentLoop {
  private readonly chatProvider: ChatProvider;
  private readonly tools: ToolScope;
  private readonly agent: LoopAgent | undefined;
  private readonly agentId: string;
  private readonly store: SessionStore;
  private readonly jails: JailResolver;
  private readonly runners: RunnerResolver | undefined;
  private readonly automation: AutomationResolver | undefined;
  private readonly toolbox: AgentToolbox;
  private readonly toolboxPrompt: PromptToolbox | undefined;
  private readonly config: AgentDefaults;
  private readonly toolsConfig: ToolsConfig;
  private readonly modelId: string;
  private readonly contributors: readonly ContextContributor[];
  private readonly timeZone: (() => string) | undefined;
  private readonly approvals: ApprovalGate | undefined;
  private readonly subagents: ReadonlyMap<string, SubagentBinding>;
  private readonly resolveLoop:
    ((agentId: string) => AgentLoop | null) | undefined;
  private readonly steeringQueue: SteeringQueue;
  private readonly clock: Clock;
  private readonly logger: Logger;
  private readonly random: RandomSource;
  private readonly newId: () => string;
  private readonly env: Readonly<Record<string, string | undefined>>;
  private readonly heartbeatMs: number;
  private readonly maxToolResultChars: number;
  private readonly dispatcher: ToolDispatcher;

  constructor(options: AgentLoopOptions) {
    this.chatProvider = options.provider;
    this.tools = options.tools;
    this.store = options.store;
    this.jails = options.jails;
    this.runners = options.runners;
    this.automation = options.automation;
    this.toolbox = options.toolbox ?? {
      name: '',
      network: { mode: 'none', allow: [] },
    };
    this.toolboxPrompt = options.toolboxPrompt;
    this.config = options.config ?? AgentDefaultsSchema.parse({});
    this.toolsConfig = options.toolsConfig ?? DEFAULT_TOOLS_CONFIG;
    this.agent = options.agent;
    this.agentId = options.agent?.id ?? DEFAULT_AGENT_ID;
    this.contributors = options.contributors ?? [];
    this.timeZone = options.timeZone;
    this.approvals = options.approvals;
    this.subagents = options.subagents ?? new Map();
    this.resolveLoop = options.resolveLoop;
    this.steeringQueue =
      options.steering ??
      new SteeringQueue({ logger: options.logger ?? silentLogger });
    this.clock = options.clock ?? systemClock;
    this.logger = options.logger ?? silentLogger;
    this.random = options.random ?? systemRandom;
    this.newId = options.newId ?? newUuid;
    this.env = options.env ?? process.env;
    this.heartbeatMs = options.toolHeartbeatMs ?? TOOL_HEARTBEAT_MS;
    this.maxToolResultChars =
      options.maxToolResultChars ?? DEFAULT_MAX_TOOL_RESULT_CHARS;

    const model = options.model ?? this.config.model;
    if (model === '') {
      throw new GhostError('config', 'No model configured for the agent loop', {
        details: { provider: this.chatProvider.id },
      });
    }
    this.modelId = model;

    // Last, so a loop that refused to construct never has one. Every value
    // here is already resolved above — the dispatcher defaults nothing itself,
    // which is what keeps it free of branches no turn takes. The delegate is an
    // arrow rather than the method: a bare `this.runSubagent` typechecks and
    // then cannot read its own private fields at the first delegation.
    this.dispatcher = new ToolDispatcher({
      tools: this.tools,
      subagents: this.subagents,
      approvals: this.approvals,
      toolsConfig: this.toolsConfig,
      toolsEnabled: this.config.toolsEnabled,
      maxToolResultChars: this.maxToolResultChars,
      heartbeatMs: this.heartbeatMs,
      agentId: this.agentId,
      clock: this.clock,
      logger: this.logger,
      delegate: (call, binding, turn) => this.runSubagent(call, binding, turn),
    });
  }

  get model(): string {
    return this.modelId;
  }

  /** The provider a turn on this loop would reach. Reported by `GET /api/status`. */
  get provider(): string {
    return this.chatProvider.id;
  }

  /** The queue this loop drains. Exposed so a transport can push into it. */
  get steering(): SteeringQueue {
    return this.steeringQueue;
  }

  /**
   * The tool definitions a turn on this loop would send.
   *
   * Exposed for the same reason `previewPrompt` is: describing what a turn would
   * carry has to come from the object that carries it. The context inspector used
   * to rebuild the list from the registry instead — `tools.select(agent.tools)` —
   * which is the built-ins narrowed by the agent's allow-list and nothing else. A
   * toolboxed agent's `search`, `fetch` and the rest are composed on *top* of that
   * scope by `withToolboxTools`, so they were missing from the panel and, worse,
   * missing from its token count: seven entries the model is really sent, absent
   * from the one screen whose job is to say what the model is sent.
   *
   * `toolsEnabled: false` empties it here rather than at the request, and that
   * placement is the point: every consumer — the request, the text-tool-call
   * correction, the context inspector's count — then agrees on the same answer
   * without any of them learning about the setting. A gate at the request would
   * leave the panel listing tools the model was never offered.
   */
  get toolDefinitions(): readonly ToolDefinition[] {
    if (!this.config.toolsEnabled) return [];

    const tools = this.tools.definitions();

    // Appended rather than merged and re-sorted. The registry's list is already
    // sorted, and keeping the subagents in the operator's configured order at
    // the end is both the order they were written in and a block a reader can
    // see as one thing.
    const registered = new Set(tools.map((tool) => tool.name));
    const subagents: ToolDefinition[] = [];
    for (const binding of this.subagents.values()) {
      // The registry wins. A name can only collide with one an MCP server or a
      // extension registered — no built-in starts with the subagent prefix — and
      // silently shadowing it would take a tool away from the model with
      // nothing anywhere saying so.
      if (registered.has(binding.toolName)) {
        this.logger.warn(
          { tool: binding.toolName, agentId: binding.agentId },
          'subagent hidden by a registered tool of the same name',
        );
        continue;
      }
      subagents.push(subagentDefinition(binding));
    }

    return this.withToolPrompts(
      subagents.length === 0 ? tools : [...tools, ...subagents],
    );
  }

  /**
   * The tool-shaped prompt inputs for this turn, or nothing when there are none.
   *
   * Where `toolsEnabled` crosses into prompt assembly, and it crosses as
   * presence rather than as a flag: off, the prompt layer is handed no
   * `PromptTools` at all and therefore has no toolbox, no policy wording and no
   * command wording to render from. Nothing downstream is told why, and nothing
   * downstream needs a branch to find out.
   *
   * It is read in one other place, and not here: the composition root reads it
   * to decide whether the skills and memory contributors exist at all. Those are
   * sections a *contributor* owns, and this loop deliberately knows nothing
   * about where a section came from — so the branch belongs where the list is
   * built. See `runtime.ts`.
   */
  private get promptTools(): PromptTools | undefined {
    if (!this.config.toolsEnabled) return undefined;

    return {
      toolbox: this.toolboxPrompt,
      toolboxPrompt: this.agent?.toolboxPrompt,
      policyPrompt: this.agent?.toolPolicyPrompt,
      platformPrompt: this.agent?.platformPrompt,
    };
  }

  /**
   * The operator's wording in place of the compiled one.
   *
   * Last, and after the subagents are appended, so one pass covers built-ins,
   * toolbox programs, MCP and extension tools and `ask_<id>` alike — and so an
   * override for a subagent tool beats `subagents[].prompt`, being the more
   * specific of the two. Doing it in the registry instead would have to happen
   * before the subagents exist, and would put per-agent text into a list that is
   * memoised across every agent.
   *
   * A miss is logged rather than thrown. `assertBuildable` already warned the
   * operator at save time; this is the backstop for a tool that left the list
   * afterwards, because a toolbox was uninstalled or `exec` was switched off.
   */
  private withToolPrompts(
    definitions: readonly ToolDefinition[],
  ): readonly ToolDefinition[] {
    const overrides = this.agent?.toolPrompts;
    if (overrides === undefined) return definitions;

    const applied = applyToolPrompts(definitions, overrides);
    if (applied.unknownTools.length > 0 || applied.unknownFields.length > 0) {
      this.logger.warn(
        { tools: applied.unknownTools, fields: applied.unknownFields },
        'tool prompt override names something this agent does not advertise',
      );
    }
    return applied.definitions;
  }

  /**
   * The prompt a turn on `sessionKey` would be sent, without running one.
   *
   * This exists so the context inspector shows the prompt the agent actually
   * uses rather than a second assembly of it. Composing the two halves outside
   * the loop would work today and quietly lie later: memory and skills
   * arrive as `ContextContributor`s attached to *this* object, and a reimplementation
   * elsewhere cannot see them.
   *
   * **Both halves, separately.** They are two different messages at two ends of
   * the request and they are billed differently — the static half is the cached
   * prefix and the runtime half is the tail re-read at full price on every
   * iteration. Returning one joined string would report a number the inspector
   * exists to break apart.
   *
   * The runtime half is built at iteration 1 with a throwaway nonce. Both are
   * per-turn values with no meaning outside a turn, and the alternative —
   * reporting the nonce of some other turn — would be worse than reporting one
   * that was never used.
   */
  async previewPrompt(input: PromptPreviewInput): Promise<PromptPreview> {
    // The stored session decides, exactly as it does in `run`. A preview that
    // reported the default workspace's root for a session bound to another one
    // would describe a prompt no turn on it will ever carry.
    const stored = this.store.getSession(input.sessionKey);
    const workspaceId = stored?.workspaceId ?? DEFAULT_WORKSPACE_ID;
    const jail =
      stored === undefined
        ? this.jails.default
        : this.jails.forWorkspace(workspaceId);

    const context: StaticPromptContext = {
      workspaceRoot: jail.root,
      workspaceId,
      sessionKey: input.sessionKey,
      agentId: input.agentId,
      channel: input.channel ?? 'web',
    };

    return this.composePrompt(
      await this.preamble(context),
      {
        ...context,
        iteration: 1,
        maxIterations: this.config.maxToolIterations,
        nowMs: this.clock.now(),
      },
      createToolOutputNonce(this.random),
    );
  }

  /**
   * The once-per-turn half, in whichever form this agent's mode needs it.
   *
   * Both modes have the same obligation and it is the reason this is separate
   * from `#composePrompt`: `ContextContributor.staticSection` may do I/O, so it
   * runs once per turn and never per iteration. Template mode wants the finished
   * static prompt; raw mode wants the contributor sections on their own, because
   * a raw template places them itself through `{{contributors}}`.
   */
  private async preamble(
    context: StaticPromptContext,
  ): Promise<PromptPreamble> {
    if (this.agent?.promptMode === 'raw') {
      return {
        staticPrompt: '',
        staticSections: await contributorSections(this.contributors, context),
      };
    }

    const tools = this.promptTools;
    return {
      staticPrompt: await buildStaticPrompt({
        context,
        ...(tools === undefined ? {} : { tools }),
        ...(this.agent === undefined ? {} : { agent: this.agent }),
        contributors: this.contributors,
      }),
      staticSections: [],
    };
  }

  /** The prompt for one iteration. One function, so the preview cannot drift from the turn. */
  private composePrompt(
    preamble: PromptPreamble,
    context: RuntimePromptContext,
    nonce: string,
    correction?: string,
  ): PromptPreview {
    const agent = this.agent;
    const tools = this.promptTools;

    if (agent?.promptMode === 'raw') {
      // One blob, and it stays in the system message. There is no cached prefix
      // to protect here — the operator's template places everything itself, so
      // splitting it across two messages would move text they positioned.
      return {
        staticPrompt: buildRawPrompt({
          context,
          nonce,
          agent,
          staticSections: preamble.staticSections,
          contributors: this.contributors,
          ...(tools === undefined ? {} : { tools }),
          ...(correction === undefined ? {} : { correction }),
        }),
        runtimeBlock: '',
      };
    }

    return {
      staticPrompt: preamble.staticPrompt,
      runtimeBlock: buildRuntimeBlock({
        context,
        nonce,
        contributors: this.contributors,
        ...(this.timeZone === undefined ? {} : { timeZone: this.timeZone() }),
        ...(agent?.livePrompt === undefined
          ? {}
          : { livePrompt: agent.livePrompt }),
        ...(agent?.wrapUpPrompt === undefined
          ? {}
          : { wrapUpPrompt: agent.wrapUpPrompt }),
        ...(tools === undefined ? {} : { tools }),
        ...(correction === undefined ? {} : { correction }),
      }),
    };
  }

  /** Queues a correction for the turn currently running on `sessionKey`. */
  steer(sessionKey: string, content: string): void {
    this.steeringQueue.push(sessionKey, content, this.clock.now());
  }

  /**
   * Records what the turn cost, and never lets that fail the turn.
   *
   * The only defensive write in this file, and the asymmetry is the point: an
   * append is load-bearing — a missing one is a provider 400 on the next
   * request — whereas a stats row is a number on an info popover. Throwing here
   * would take down a turn that has already completed and already been
   * persisted, which is strictly worse than a conversation with one gap in its
   * accounting.
   *
   * An abandoned iterator records nothing, and also yields no `turn.end`. The
   * two agree, and neither is a turn that finished.
   */
  private recordStats(stats: TurnStatsRecord): void {
    try {
      this.store.recordTurnStats(stats);
    } catch (error) {
      this.logger.warn(
        { err: error, sessionKey: stats.sessionKey, turnId: stats.turnId },
        'failed to record turn stats',
      );
    }
  }

  /**
   * Runs one turn, emitting events as they happen.
   *
   * The generator's return value carries the outcome; the events carry
   * everything a UI needs to render it. A caller that only wants the answer can
   * ignore the events, and one that only wants to render can ignore the return.
   */
  async *run(input: TurnInput): AsyncGenerator<AgentEvent, TurnResult> {
    const { sessionKey } = input;
    const turnId = input.turnId ?? this.newId();
    const channel = input.channel ?? 'cli';
    const chain = input.chain ?? [];
    const rootSessionKey = input.rootSessionKey ?? sessionKey;
    // A signal that never fires, so every path below reads `signal.aborted`
    // rather than re-deriving what "no cancellation" means.
    const signal = input.signal ?? new AbortController().signal;

    const maxIterations = this.config.maxToolIterations;
    const wallTimeoutMs = this.config.loopWallTimeoutMs;

    // Once per turn, both of them: see the module header.
    const nonce = createToolOutputNonce(this.random);
    const toolDefinitions = this.toolDefinitions;

    // Ensure first, then read what came back. `input.workspaceId` can only ever
    // *create* a session in a workspace — `ensureSession` ignores it for a row
    // that already exists — so the workspace a turn runs in is the one stored
    // on the session, never the one this request happens to claim. That is what
    // makes switching workspaces in the UI safe while a turn is running, and
    // what stops a crafted frame from pointing an existing session's tools at
    // another workspace's files.
    //
    // A session *can* be moved, but only through `updateSession`, which is
    // reached by `PATCH /api/sessions/:key` and nothing else. The move lands
    // here on the next turn, because the read below is what resolves the jail.
    const session = this.store.ensureSession(sessionKey, {
      origin: channel,
      ...(input.workspaceId === undefined
        ? {}
        : { workspaceId: input.workspaceId }),
      ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
    });
    // Captured once, for the life of the turn: every tool call below closes
    // over this jail, so a workspace switch mid-turn cannot move it.
    const jail = this.jails.forWorkspace(session.workspaceId);

    // Attachments are read from disk on every iteration, because the request is
    // rebuilt on every iteration. Scoped to the turn and discarded with it, so
    // a six-tool turn reads one image once rather than six times.
    const attachments: AttachmentCache = new Map();

    // The stored row wins, for the same reason the workspace does: a history
    // built under one agent's prompt and tools must not silently continue under
    // another's. `input.agentId` can only ever *create* a session's binding;
    // moving an existing one is an explicit update, not a frame.
    const promptContext: StaticPromptContext = {
      workspaceRoot: jail.root,
      workspaceId: session.workspaceId,
      sessionKey,
      agentId: session.agentId,
      channel,
    };

    const opening = this.store.append(sessionKey, userMessage(input.content), {
      turnId,
    });
    const firstSeq = opening.seq;
    let lastSeq = opening.seq;

    // A conversation nobody has named yet takes its name from the first thing
    // said in it. Guarded on the *stored* title, so this can only ever fire
    // once: a session that has one — derived here on an earlier turn, or typed
    // by a user through the rename route — never re-enters the branch. That
    // makes "a manual rename is never clobbered" a property of the code rather
    // than a convention someone has to remember.
    //
    // Here rather than in the hub because the hub is the web's door only. The
    // CLI and every channel run this same loop, and a title derived in one of
    // them is a title all of them show.
    if (session.title === '') {
      const title = deriveSessionTitle(textOf(userMessage(input.content)));
      if (title !== '') this.store.updateSession(sessionKey, { title });
    }

    const startedAt = this.clock.monotonic();
    // Both clocks, deliberately. The monotonic one caps the wall timeout and
    // must stay monotonic — an NTP step backwards through a `now()`-based cap
    // would end a turn that had barely started. This one is what a human reads,
    // and is only ever subtracted from another reading of itself.
    const startedAtMs = this.clock.now();
    let iteration = 0;
    let elapsedMs = 0;
    let stopReason: StopReason | undefined;
    /**
     * Why the turn failed, set alongside every `stopReason = 'error'`.
     *
     * Recorded on the stats row rather than appended to history: everything in
     * `messages` is replayed into every later provider request, so an error
     * written there would fail its way into the prompt forever. This is the only
     * durable copy — the `error` event carrying the same words is unsequenced
     * and gone the moment it is delivered.
     */
    let errorMessage: string | undefined;
    let finalText = '';
    let usage: Usage = emptyUsage();
    /** Set for exactly one iteration, then cleared. See `text-tool-call.ts`. */
    let correction: string | undefined;
    let correctedOnce = false;

    try {
      // Inside the `try`, so a caller that abandons the iterator before the
      // first iteration still runs the cleanup below.
      //
      // And *first* inside it, above every fallible step below. Building the
      // preamble awaits, and resolving the sandbox reaches a container daemon
      // that may be down — either can throw. Opening the turn after them meant
      // a failure there unwound before the turn existed, so the error named a
      // `turnId` no client had seen start, the transcript invented an orphan
      // turn with no `firstSeq`, and the one thing the reader wanted — a
      // Regenerate button — was the one thing there was no address for.
      yield {
        type: 'turn.start',
        sessionKey,
        turnId,
        agentId: this.agentId,
        model: this.modelId,
        provider: this.chatProvider.id,
        // Here as well as on `turn.end`: a turn that throws never reaches its
        // end, and a failed turn with no seq is a failed turn nothing can
        // re-run.
        firstSeq,
      };

      const preamble = await this.preamble(promptContext);

      // Resolved once per turn, beside the jail and for the same reason: a
      // sandbox is a property of (agent, workspace, session), and re-deriving it
      // per tool call would let a mid-turn config change move it.
      const sandbox: ToolboxRequest = {
        agentId: session.agentId ?? DEFAULT_AGENT_ID,
        workspaceId: session.workspaceId,
        sessionKey,
        toolbox: this.toolbox.name,
        network: this.toolbox.network,
        workspaceRoot: jail.root,
      };
      const runner = this.runners?.forTurn(sandbox);
      // Beside the runner and off the same request, for the same reason: which
      // agent and which session is a property of the turn, and re-deriving it per
      // tool call would let a mid-turn change move it.
      const automation = this.automation?.forTurn(sandbox);

      const toolContext: ToolContext = {
        jail,
        signal,
        config: this.toolsConfig,
        clock: this.clock,
        logger: this.logger,
        env: this.env,
        ...(runner === undefined ? {} : { runner, sandboxed: true }),
        ...(automation === undefined ? {} : { automation }),
      };

      while (iteration < maxIterations) {
        for (const message of this.steeringQueue.drain(sessionKey)) {
          this.store.append(sessionKey, userMessage(steeringText(message)), {
            turnId,
          });
        }

        if (signal.aborted) {
          stopReason = 'aborted';
          break;
        }

        elapsedMs = this.clock.monotonic() - startedAt;
        if (wallTimeoutMs > 0 && elapsedMs >= wallTimeoutMs) {
          this.logger.warn(
            { sessionKey, turnId, elapsedMs, wallTimeoutMs },
            'turn wall timeout',
          );
          stopReason = 'wall_timeout';
          break;
        }

        iteration += 1;

        const prompt = this.composePrompt(
          preamble,
          {
            ...promptContext,
            iteration,
            maxIterations,
            nowMs: this.clock.now(),
          },
          nonce,
          correction,
        );
        // Consumed, not left standing: it describes what the *previous* iteration
        // did, and a correction that persisted would be scolding the model for
        // something it has already stopped doing.
        correction = undefined;

        const request: ChatRequest = {
          model: this.modelId,
          messages: [
            systemMessage(prompt.staticPrompt),
            // Re-read every iteration: the tool results this turn just wrote are
            // part of the next request, and reading them back from the store is
            // what keeps history and the request identical rather than merely
            // similar.
            //
            // Attachments become readable here and nowhere else. Storage holds
            // a path; a provider needs bytes or characters, and only this scope
            // has the jail that resolves one to the other. Doing it before
            // `#chatProvider` — which is already wrapped in `withResilience` — is
            // also what keeps `stripImages` looking at real image parts rather
            // than at references it would delete without reading.
            ...materialiseAttachments(
              this.store.history(sessionKey, { maxToolResultChars: 0 }),
              jail,
              // Constant for the life of the turn, which is what makes it safe
              // against the `attachments` cache beside it: that key is path,
              // size and mtime, and does not know about this.
              { images: this.config.visionEnabled },
              attachments,
            ),
            // The volatile half, after the history rather than before it. A
            // provider's cache ends at the first byte that differs from the last
            // request, so a clock or an iteration counter placed ahead of the
            // conversation re-prices the whole conversation on every iteration.
            // Sent, never stored: the store is the conversation, and this is
            // scaffolding for one request.
            ...(prompt.runtimeBlock === ''
              ? []
              : [userMessage(runtimeReminder(prompt.runtimeBlock))]),
          ],
          ...(toolDefinitions.length === 0 ? {} : { tools: toolDefinitions }),
          // Keyed on the session so every request in a conversation lands on the
          // same cache shard. Providers that do not know the field ignore it, and
          // the one that rejects it is handled by the degradation ladder.
          cacheKey: sessionKey,
          maxTokens: this.config.maxTokens,
          // Both omitted rather than sent as `undefined` when unset: an adapter
          // that spreads the request into a JSON body would otherwise emit
          // `"temperature": null`, which is not the same as saying nothing, and
          // is rejected by the providers that accept no temperature at all.
          ...(this.config.temperature === undefined
            ? {}
            : { temperature: this.config.temperature }),
          ...(this.config.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: this.config.reasoningEffort }),
          signal,
        };

        let result: ChatResult | undefined;
        try {
          for await (const event of this.chatProvider.stream(request)) {
            if (event.type === 'text') {
              if (event.text !== '') {
                yield { type: 'assistant.delta', turnId, text: event.text };
              }
            } else if (event.type === 'reasoning') {
              if (event.text !== '') {
                yield { type: 'reasoning.delta', turnId, text: event.text };
              }
            } else {
              result = event.result;
            }
          }
        } catch (error) {
          const ghost = toGhostError(error, 'provider');
          if (isAbortError(error) || ghost.kind === 'aborted') {
            stopReason = 'aborted';
            break;
          }
          this.logger.error(
            {
              sessionKey,
              turnId,
              iteration,
              kind: ghost.kind,
              err: ghost.message,
            },
            'provider request failed',
          );
          yield {
            type: 'error',
            code: errorCodeFor(ghost.kind),
            message: ghost.message,
            retryable: ghost.retryable,
            turnId,
          };
          stopReason = 'error';
          errorMessage = ghost.message;
          break;
        }

        if (result === undefined) {
          // A stream that ends without its `done` event has not reported tool
          // calls, usage or a finish reason. Treating that as an empty answer
          // would silently end the turn on a transport bug.
          const message = 'The provider ended the stream without a result.';
          yield {
            type: 'error',
            code: 'provider_error',
            message,
            retryable: true,
            turnId,
          };
          stopReason = 'error';
          errorMessage = message;
          break;
        }

        usage = accumulateUsage(usage, result.usage);

        if (result.message.toolCalls.length === 0) {
          lastSeq = this.store.append(sessionKey, result.message, {
            turnId,
          }).seq;
          finalText = textOf(result.message);

          // A call the model wrote out instead of making. Left alone, this ends
          // the turn `complete` with a JSON blob as the answer and no sign
          // anywhere that the model tried to act — see `text-tool-call.ts` for the
          // transcript that motivates it. One correction per turn: a model that
          // gets it wrong twice is not going to be talked round, and a loop of
          // corrections would burn the iteration budget saying the same thing.
          const attempted = correctedOnce
            ? undefined
            : textToolCallName(
                finalText,
                toolDefinitions.map((definition) => definition.name),
              );
          if (attempted !== undefined) {
            correctedOnce = true;
            correction = textToolCallCorrection(attempted);
            this.logger.warn(
              { sessionKey, turnId, iteration, tool: attempted },
              'model wrote a tool call as text; correcting it',
            );
            yield {
              type: 'notice',
              kind: 'degraded',
              message: `The model wrote a call to \`${attempted}\` as text instead of calling it. Asking it again.`,
              turnId,
            };
            continue;
          }

          if (finalText === '') {
            // Not an error, and deliberately not retried: the provider answered,
            // the model simply wrote nothing outside its reasoning channel. Small
            // local models do this, and a low `maxTokens` makes any reasoning
            // model do it. Logged because the turn is otherwise indistinguishable
            // from a successful one in every record it leaves — the UI derives
            // the same conclusion from the transcript and says so on the turn.
            this.logger.warn(
              {
                sessionKey,
                turnId,
                iteration,
                reasoningChars: (result.message.reasoning ?? '').length,
              },
              'model produced neither an answer nor a tool call',
            );
          }
          // The correction arrived while this answer was being composed. Keep
          // going so it is answered, rather than ending a turn the user has
          // already asked to change.
          if (this.steeringQueue.hasPending(sessionKey)) continue;
          stopReason = 'complete';
          break;
        }

        const tools = yield* this.dispatcher.dispatch(result, {
          sessionKey,
          turnId,
          nonce,
          signal,
          toolContext,
          workspaceId: session.workspaceId,
          chain,
          rootSessionKey,
        });
        // One transaction, and the store stays the turn's to write. A partial
        // write is exactly the orphaned tool result `findLegalStart` then has
        // to repair on every later request.
        const written = this.store.appendMany(sessionKey, tools.pending, {
          turnId,
        });
        lastSeq = written.at(-1)?.seq ?? 0;
        if (tools.cancelled) {
          stopReason = 'aborted';
          break;
        }
      }
    } finally {
      // Whatever ended the turn — completion, a cap, an abandoned iterator —
      // nothing queued for it may leak into the next one.
      this.steeringQueue.clear(sessionKey);
    }

    stopReason ??= 'max_iterations';

    if (stopReason === 'max_iterations' || stopReason === 'wall_timeout') {
      // Unlike an error, this is persisted: the next turn's history has to
      // explain why the task stopped half-done, or the model reads its own
      // truncated work as complete.
      finalText =
        stopReason === 'max_iterations'
          ? maxIterationsText(maxIterations)
          : wallTimeoutText(elapsedMs, wallTimeoutMs);
      lastSeq = this.store.append(sessionKey, assistantMessage(finalText), {
        turnId,
      }).seq;
      yield { type: 'assistant.delta', turnId, text: finalText };
    }

    const endedAtMs = this.clock.now();
    this.recordStats({
      turnId,
      sessionKey,
      agentId: session.agentId ?? '',
      // The workspace this turn actually ran in, read off the row the jail was
      // resolved from at the top of the turn. Recorded rather than derived
      // later: the session can be moved afterwards, and then nothing else could
      // say which files this turn was able to reach.
      workspaceId: session.workspaceId,
      provider: this.chatProvider.id,
      model: this.modelId,
      startedAtMs,
      endedAtMs,
      iterations: iteration,
      stopReason,
      usage,
      ...(errorMessage === undefined ? {} : { error: errorMessage }),
    });

    yield {
      type: 'turn.end',
      turnId,
      stopReason,
      usage,
      iterations: iteration,
      elapsedMs: endedAtMs - startedAtMs,
      firstSeq,
      lastSeq,
    };

    return {
      turnId,
      stopReason,
      iterations: iteration,
      usage,
      text: finalText,
    };
  }

  /**
   * One delegated task: a whole turn on another agent's loop, awaited.
   *
   * The shape is `yield*` over the child's generator, which is what makes every
   * event it produces reach the operator as it happens rather than as a
   * paragraph at the end. Everything the child does — its tool calls, its
   * approvals, its abort — runs on the machinery that already exists, because
   * it is a real turn and not a simulation of one.
   *
   * Four decisions carry the weight:
   *
   *  - **The child gets a session of its own, in the caller's workspace.** Its
   *    own, because context isolation is the feature: a subagent that inherited
   *    the conversation would put the detour back in the window this exists to
   *    keep clear. The caller's *workspace*, because a researcher that could not
   *    read the files being discussed would be useless — the folder belongs to
   *    the session, and a delegation does not leave it.
   *  - **The pointer is written to the parent before the run, not after.** A
   *    turn that is abandoned mid-delegation still leaves a child session, and a
   *    child session nothing points at is one nothing can show or delete.
   *  - **`subagentTimeoutMs` is the *caller's*.** The delegator caps its
   *    delegate; an agent cannot grant itself more time by being called.
   *  - **A timeout aborts the child and not the turn.** The combined signal is
   *    the child's alone, so the caller gets a tool result saying the subagent
   *    was cut short and can carry on — which is what the cap is for.
   */
  private async *runSubagent(
    call: ToolCall,
    binding: SubagentBinding,
    turn: TurnScope,
  ): AsyncGenerator<AgentEvent, ToolExecution> {
    const refusal = refuseDelegation(turn.chain, binding.agentId);
    if (refusal !== undefined) {
      this.logger.warn(
        {
          tool: call.name,
          agentId: binding.agentId,
          chain: turn.chain,
          refusal,
        },
        'delegation refused',
      );
      return refusedExecution(refusal, binding, turn.chain);
    }

    const child = this.resolveLoop?.(binding.agentId) ?? null;
    if (child === null) {
      this.logger.warn(
        { tool: call.name, agentId: binding.agentId },
        'delegation refused: the subagent cannot run',
      );
      return refusedExecution('unconfigured', binding, turn.chain);
    }

    const task = parseTask(parseToolArgs(call.argumentsJson));
    if (task === undefined) {
      return {
        name: call.name,
        content:
          `Invalid arguments for ${call.name}: "task" must be a non-empty string ` +
          `describing what the subagent should do.`,
        isError: true,
        truncated: false,
        durationMs: 0,
        errorKind: 'invalid_input',
      };
    }

    const depth = turn.chain.length + 1;
    const sessionKey = subagentSessionKey(this.newId);
    this.store.ensureSession(sessionKey, {
      origin: SUBAGENT_ORIGIN,
      workspaceId: turn.workspaceId,
      agentId: binding.agentId,
      metadata: {
        [SUBAGENT_METADATA_KEY]: {
          parentSessionKey: turn.sessionKey,
          parentTurnId: turn.turnId,
          parentCallId: call.id,
          agentId: binding.agentId,
          depth,
        } satisfies SubagentLineage,
      },
    });
    this.rememberSubagentRun(turn.sessionKey, call.id, {
      sessionKey,
      agentId: binding.agentId,
      // The label too, so a reloaded transcript can name the card before the
      // fetch that fills it in resolves.
      label: binding.label,
    });

    const timeout = this.subagentTimeout(turn.signal);
    const started = this.clock.monotonic();
    try {
      const run = child.run({
        sessionKey,
        content: task.task,
        signal: timeout.signal,
        channel: SUBAGENT_ORIGIN,
        agentId: binding.agentId,
        workspaceId: turn.workspaceId,
        chain: [...turn.chain, this.agentId],
        rootSessionKey: turn.rootSessionKey,
      });

      // Hand-driven rather than `yield*`, because the return value is the tool
      // result and `yield*` on a generator whose events need rewriting on the
      // way past would need a wrapper generator anyway.
      let next = await run.next();
      while (next.done !== true) {
        yield this.wrapSubagentEvent(
          turn,
          call.id,
          binding,
          sessionKey,
          depth,
          next.value,
        );
        next = await run.next();
      }

      return subagentResult(
        binding,
        next.value,
        this.clock.monotonic() - started,
      );
    } finally {
      timeout.dispose();
    }
  }

  /**
   * One event from a subagent, addressed to the card it belongs under.
   *
   * A `subagent.event` from *the child's own* subagent is forwarded rather than
   * wrapped again: only `turnId` is rewritten to this turn's, because the rest
   * of its address already names the grandchild's delegating call. That is what
   * keeps the payload non-recursive at any depth — see `SubagentEventSchema`.
   */
  private wrapSubagentEvent(
    turn: TurnScope,
    callId: string,
    binding: SubagentBinding,
    sessionKey: string,
    depth: number,
    event: AgentEvent,
  ): AgentEvent {
    if (event.type === 'subagent.event') {
      return { ...event, turnId: turn.turnId };
    }
    return {
      type: 'subagent.event',
      turnId: turn.turnId,
      parentSessionKey: turn.sessionKey,
      parentCallId: callId,
      agentId: binding.agentId,
      label: binding.label,
      sessionKey,
      depth,
      event,
    };
  }

  /**
   * Records which call produced which child session, on the parent.
   *
   * Defensive for the same reason `#recordStats` is, and no more: this is how a
   * reloaded transcript finds the run again, which is worth a write and is not
   * worth failing a turn that has otherwise worked.
   */
  private rememberSubagentRun(
    parentSessionKey: string,
    callId: string,
    run: SubagentRunRef,
  ): void {
    try {
      const parent = this.store.getSession(parentSessionKey);
      if (parent === undefined) return;
      this.store.updateSession(parentSessionKey, {
        metadata: withSubagentRun(parent.metadata, callId, run),
      });
    } catch (error) {
      this.logger.warn(
        { err: error, sessionKey: parentSessionKey, callId },
        'failed to record the subagent session pointer',
      );
    }
  }

  /**
   * The child's signal: the turn's, plus this agent's cap on a delegation.
   *
   * `AbortSignal.any` rather than a listener, so the composed signal is dropped
   * with the timer and nothing stays attached to a turn signal that outlives
   * dozens of calls.
   */
  private subagentTimeout(parent: AbortSignal): {
    signal: AbortSignal;
    dispose(): void;
  } {
    const capMs = this.config.subagentTimeoutMs;
    if (capMs <= 0) return { signal: parent, dispose: () => undefined };

    const cap = new AbortController();
    const handle = this.clock.setTimeout(() => {
      cap.abort(abortedError(`the ${this.agentId} agent's delegation cap`));
    }, capMs);

    return {
      signal: AbortSignal.any([parent, cap.signal]),
      dispose: () => {
        this.clock.clearTimeout(handle);
      },
    };
  }
}
