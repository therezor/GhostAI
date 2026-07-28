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
 *  - **A cancelled tool call still gets a `tool` message.** Providers reject an
 *    `assistant` turn whose `tool_calls` were never answered, so stopping mid-
 *    tool without writing a result would make the *next* turn fail on history
 *    the user cannot see — the failure surfaces long after the Ctrl-C that
 *    caused it. A *denied* call is the same case: no execution, still a result.
 *  - **Approval is checked between the `tool.call` event and execution**, which
 *    is the only place it can be checked once for every transport. What the
 *    loop decides is whether to ask; what the answer is, and how long it holds,
 *    belong to the gate. See `approval.ts`.
 *
 * The signal threads from the caller through the provider request, tool
 * execution and any child process. There is one cancellation mechanism, and
 * this is it.
 */

import { randomUUID } from 'node:crypto';

import {
  DEFAULT_MAX_TOOL_RESULT_CHARS,
  DEFAULT_WORKSPACE_ID,
  GhostError,
  assistantMessage,
  isAbortError,
  silentLogger,
  systemClock,
  systemMessage,
  textOf,
  toGhostError,
  truncateHeadTail,
  userMessage,
  type ChatMessageInput,
  type Clock,
  type ErrorKind,
  type Logger,
  type SessionStore,
  type TimerHandle,
} from '@ghostai/core';
import {
  AgentDefaultsSchema,
  type AgentDefaults,
  type ContentPart,
  type ErrorCode,
  type ParsedMentions,
  type StopReason,
  type ToolCall,
  type ToolRisk,
  type ToolsConfig,
  type Usage,
} from '@ghostai/protocol';
import {
  emptyUsage,
  type ChatProvider,
  type ChatRequest,
  type ChatResult,
} from '@ghostai/providers';
import {
  createToolOutputNonce,
  describeInjectionFindings,
  systemRandom,
  wrapToolOutput,
  type JailResolver,
  type RandomSource,
} from '@ghostai/security';
import {
  DEFAULT_TOOLS_CONFIG,
  type ToolContext,
  type ToolExecution,
  type ToolRegistry,
} from '@ghostai/tools';

import {
  deniedNotice,
  deniedToolResult,
  type ApprovalGate,
  type ApprovalRequest,
  type DenialReason,
} from './approval.js';
import type { AgentEvent } from './events.js';
import {
  buildRuntimeBlock,
  buildStaticPrompt,
  composeSystemPrompt,
  type ContextContributor,
  type StaticPromptContext,
} from './prompt.js';
import { SteeringQueue, steeringText } from './steering.js';

/**
 * How often a running tool reports that it is still running.
 *
 * Long enough that a normal tool call never emits one, short enough that a UI
 * showing a spinner is never left guessing whether the process died. The tools
 * this exists for — a build under `exec`, a slow MCP server — produce no output
 * at all until they finish, so the loop is the only thing that can say.
 */
export const TOOL_HEARTBEAT_MS = 15_000;

/** What a cancelled call records, so the `assistant` turn stays answered. */
export const CANCELLED_TOOL_RESULT = 'Cancelled: the turn was stopped before this tool finished.';

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

/**
 * The model's arguments, as the UI should see them.
 *
 * Parsing is best-effort on purpose: malformed JSON from a model is common
 * enough that it must not break the event stream, and the registry is the thing
 * that turns it into a typed tool error the model can recover from. Here it is
 * only being displayed.
 */
function parseToolArgs(argumentsJson: string): unknown {
  if (argumentsJson.trim() === '') return {};
  try {
    return JSON.parse(argumentsJson) as unknown;
  } catch {
    return argumentsJson;
  }
}

function sumOptional(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return a + b;
}

/** Adds one request's usage to the turn's running total. */
function accumulateUsage(total: Usage, next: Usage): Usage {
  const cachedTokens = sumOptional(total.cachedTokens, next.cachedTokens);
  const reasoningTokens = sumOptional(total.reasoningTokens, next.reasoningTokens);
  return {
    promptTokens: total.promptTokens + next.promptTokens,
    completionTokens: total.completionTokens + next.completionTokens,
    totalTokens: total.totalTokens + next.totalTokens,
    ...(cachedTokens === undefined ? {} : { cachedTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
  };
}

function cancelledExecution(name: string): ToolExecution {
  return {
    name,
    content: CANCELLED_TOOL_RESULT,
    isError: true,
    truncated: false,
    durationMs: 0,
    errorKind: 'aborted',
  };
}

/** A call that was refused. `durationMs` is zero because nothing ran. */
function deniedExecution(name: string, reason: DenialReason): ToolExecution {
  return {
    name,
    content: deniedToolResult(name, reason),
    isError: true,
    truncated: false,
    durationMs: 0,
    errorKind: 'permission_denied',
  };
}

/** How an awaited approval ended. */
type ApprovalOutcome = 'approved' | 'aborted' | DenialReason;

/** A promise that settles when a signal fires, and a way to stop listening. */
interface AbortWatch {
  readonly promise: Promise<'aborted'>;
  dispose(): void;
}

function watchAbort(signal: AbortSignal): AbortWatch {
  // A second controller purely to remove the listener: a turn making dozens of
  // approved calls would otherwise leave one listener per call attached to a
  // signal that lives as long as the turn.
  const listening = new AbortController();
  const promise = new Promise<'aborted'>((resolve) => {
    // An `abort` listener added to a signal that has *already* fired is never
    // called, so a watcher without this line waits out the full approval
    // deadline on a turn that was cancelled a moment earlier.
    if (signal.aborted) {
      resolve('aborted');
      return;
    }
    signal.addEventListener(
      'abort',
      () => {
        resolve('aborted');
      },
      { once: true, signal: listening.signal },
    );
  });
  return {
    promise,
    dispose: () => {
      listening.abort();
    },
  };
}

export interface AgentLoopOptions {
  /** Already wrapped in `withResilience` by `createProvider`. */
  readonly provider: ChatProvider;
  readonly tools: ToolRegistry;
  readonly store: SessionStore;
  /**
   * Supplies the jail for a turn, keyed by its session's workspace.
   *
   * A resolver rather than one jail, because a session records which workspace
   * it belongs to and two sessions in one process can be in different ones.
   * `singleJail(jail)` is the adapter for a caller that has only one.
   */
  readonly jails: JailResolver;
  /** Defaults to the schema's defaults, so a caller without a config file works. */
  readonly config?: AgentDefaults;
  readonly toolsConfig?: ToolsConfig;
  /** Overrides `config.model`. One of the two must be non-empty. */
  readonly model?: string;
  readonly contributors?: readonly ContextContributor[];
  /**
   * Who to ask before a tool whose risk band is set to `ask` runs.
   *
   * Absent means nobody is there to ask, and an `ask` policy then runs the tool
   * — today's behaviour, and what keeps a terminal session unchanged. A `deny`
   * policy is enforced with or without a gate. Any transport that exposes this
   * agent to something other than its operator's own keyboard should install
   * one.
   */
  readonly approvals?: ApprovalGate;
  readonly steering?: SteeringQueue;
  readonly clock?: Clock;
  readonly logger?: Logger;
  /** The nonce source. Never pin this outside a test — see `@ghostai/security`. */
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
  readonly profileId?: string;
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
   * `@kb:`, `@mcp:` and `@skill:` mentions found in the message.
   *
   * Parsed by the transport rather than here, and by exactly one transport: the
   * hub does it for every channel, so a mention means the same thing typed into
   * a browser and typed into a chat app. The loop only carries it — it reaches
   * `runtimeSection`, which is where the contributors that act on it arrive in
   * Phase 3, and nothing in this package reads it.
   */
  readonly mentions?: ParsedMentions;
}

/** What the context inspector knows about the session it is inspecting. */
export interface PromptPreviewInput {
  readonly sessionKey: string;
  /** Defaults to `web`: nothing previews a prompt from a terminal. */
  readonly channel?: string;
  readonly profileId?: string;
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

/** A timer that can be abandoned without leaving the clock holding a callback. */
interface Tick {
  readonly promise: Promise<null>;
  cancel(): void;
}

export class AgentLoop {
  readonly #provider: ChatProvider;
  readonly #tools: ToolRegistry;
  readonly #store: SessionStore;
  readonly #jails: JailResolver;
  readonly #config: AgentDefaults;
  readonly #toolsConfig: ToolsConfig;
  readonly #model: string;
  readonly #contributors: readonly ContextContributor[];
  readonly #approvals: ApprovalGate | undefined;
  readonly #steering: SteeringQueue;
  readonly #clock: Clock;
  readonly #logger: Logger;
  readonly #random: RandomSource;
  readonly #newId: () => string;
  readonly #env: Readonly<Record<string, string | undefined>>;
  readonly #heartbeatMs: number;
  readonly #maxToolResultChars: number;

  constructor(options: AgentLoopOptions) {
    this.#provider = options.provider;
    this.#tools = options.tools;
    this.#store = options.store;
    this.#jails = options.jails;
    this.#config = options.config ?? AgentDefaultsSchema.parse({});
    this.#toolsConfig = options.toolsConfig ?? DEFAULT_TOOLS_CONFIG;
    this.#contributors = options.contributors ?? [];
    this.#approvals = options.approvals;
    this.#steering =
      options.steering ?? new SteeringQueue({ logger: options.logger ?? silentLogger });
    this.#clock = options.clock ?? systemClock;
    this.#logger = options.logger ?? silentLogger;
    this.#random = options.random ?? systemRandom;
    this.#newId = options.newId ?? randomUUID;
    this.#env = options.env ?? process.env;
    this.#heartbeatMs = options.toolHeartbeatMs ?? TOOL_HEARTBEAT_MS;
    this.#maxToolResultChars = options.maxToolResultChars ?? DEFAULT_MAX_TOOL_RESULT_CHARS;

    const model = options.model ?? this.#config.model;
    if (model === '') {
      throw new GhostError('config', 'No model configured for the agent loop', {
        details: { provider: this.#provider.id },
      });
    }
    this.#model = model;
  }

  get model(): string {
    return this.#model;
  }

  /** The provider a turn on this loop would reach. Reported by `GET /api/status`. */
  get provider(): string {
    return this.#provider.id;
  }

  /** The queue this loop drains. Exposed so a transport can push into it. */
  get steering(): SteeringQueue {
    return this.#steering;
  }

  /**
   * The system prompt a turn on `sessionKey` would be sent, without running one.
   *
   * This exists so the context inspector shows the prompt the agent actually
   * uses rather than a second assembly of it. Composing the two halves outside
   * the loop would work today and quietly lie later: memory, skills and profiles
   * arrive as `ContextContributor`s attached to *this* object, and a reimplementation
   * elsewhere cannot see them.
   *
   * The runtime half is built at iteration 1 with a throwaway nonce. Both are
   * per-turn values with no meaning outside a turn, and the alternative —
   * reporting the nonce of some other turn — would be worse than reporting one
   * that was never used.
   */
  async previewPrompt(input: PromptPreviewInput): Promise<string> {
    // The stored session decides, exactly as it does in `run`. A preview that
    // reported the default workspace's root for a session bound to another one
    // would describe a prompt no turn on it will ever carry.
    const stored = this.#store.getSession(input.sessionKey);
    const workspaceId = stored?.workspaceId ?? DEFAULT_WORKSPACE_ID;
    const jail = stored === undefined ? this.#jails.default : this.#jails.forWorkspace(workspaceId);

    const context: StaticPromptContext = {
      workspaceRoot: jail.root,
      workspaceId,
      sessionKey: input.sessionKey,
      profileId: input.profileId,
      channel: input.channel ?? 'web',
    };

    const staticPrompt = await buildStaticPrompt({
      context,
      contributors: this.#contributors,
    });
    const runtimeBlock = buildRuntimeBlock({
      context: {
        ...context,
        iteration: 1,
        maxIterations: this.#config.maxToolIterations,
        nowMs: this.#clock.now(),
      },
      nonce: createToolOutputNonce(this.#random),
      contributors: this.#contributors,
    });

    return composeSystemPrompt(staticPrompt, runtimeBlock);
  }

  /** Queues a correction for the turn currently running on `sessionKey`. */
  steer(sessionKey: string, content: string): void {
    this.#steering.push(sessionKey, content, this.#clock.now());
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
    const turnId = input.turnId ?? this.#newId();
    const channel = input.channel ?? 'cli';
    // A signal that never fires, so every path below reads `signal.aborted`
    // rather than re-deriving what "no cancellation" means.
    const signal = input.signal ?? new AbortController().signal;

    const maxIterations = this.#config.maxToolIterations;
    const wallTimeoutMs = this.#config.loopWallTimeoutMs;

    // Once per turn, both of them: see the module header.
    const nonce = createToolOutputNonce(this.#random);
    const toolDefinitions = this.#tools.definitions();

    // Ensure first, then read what came back. `input.workspaceId` can only ever
    // *create* a session in a workspace — `ensureSession` ignores it for a row
    // that already exists — so the workspace a turn runs in is the one the
    // conversation was born in, never the one this request happens to claim.
    // That is what makes switching workspaces in the UI safe while a turn is
    // running, and what stops a crafted frame from pointing an existing
    // session's tools at another workspace's files.
    const session = this.#store.ensureSession(sessionKey, {
      origin: channel,
      ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
      ...(input.profileId === undefined ? {} : { profileId: input.profileId }),
    });
    // Captured once, for the life of the turn: every tool call below closes
    // over this jail, so a workspace switch mid-turn cannot move it.
    const jail = this.#jails.forWorkspace(session.workspaceId);

    const promptContext: StaticPromptContext = {
      workspaceRoot: jail.root,
      workspaceId: session.workspaceId,
      sessionKey,
      profileId: input.profileId,
      channel,
    };

    this.#store.append(sessionKey, userMessage(input.content), { turnId });

    const staticPrompt = await buildStaticPrompt({
      context: promptContext,
      contributors: this.#contributors,
    });

    const toolContext: ToolContext = {
      jail,
      signal,
      config: this.#toolsConfig,
      clock: this.#clock,
      logger: this.#logger,
      env: this.#env,
    };

    const startedAt = this.#clock.monotonic();
    let iteration = 0;
    let elapsedMs = 0;
    let stopReason: StopReason | undefined;
    let finalText = '';
    let usage: Usage = emptyUsage();

    try {
      // Inside the `try`, so a caller that abandons the iterator before the
      // first iteration still runs the cleanup below.
      yield {
        type: 'turn.start',
        sessionKey,
        turnId,
        model: this.#model,
        provider: this.#provider.id,
      };

      while (iteration < maxIterations) {
        for (const message of this.#steering.drain(sessionKey)) {
          this.#store.append(sessionKey, userMessage(steeringText(message)), { turnId });
        }

        if (signal.aborted) {
          stopReason = 'aborted';
          break;
        }

        elapsedMs = this.#clock.monotonic() - startedAt;
        if (wallTimeoutMs > 0 && elapsedMs >= wallTimeoutMs) {
          this.#logger.warn({ sessionKey, turnId, elapsedMs, wallTimeoutMs }, 'turn wall timeout');
          stopReason = 'wall_timeout';
          break;
        }

        iteration += 1;

        const runtimeBlock = buildRuntimeBlock({
          context: {
            ...promptContext,
            iteration,
            maxIterations,
            nowMs: this.#clock.now(),
            // Turn-scoped, so it belongs to the half of the prompt that is
            // rebuilt every iteration and never to the cached prefix.
            ...(input.mentions === undefined ? {} : { mentions: input.mentions }),
          },
          nonce,
          contributors: this.#contributors,
        });

        const request: ChatRequest = {
          model: this.#model,
          messages: [
            systemMessage(composeSystemPrompt(staticPrompt, runtimeBlock)),
            // Re-read every iteration: the tool results this turn just wrote are
            // part of the next request, and reading them back from the store is
            // what keeps history and the request identical rather than merely
            // similar.
            ...this.#store.history(sessionKey, { maxToolResultChars: 0 }),
          ],
          ...(toolDefinitions.length === 0 ? {} : { tools: toolDefinitions }),
          maxTokens: this.#config.maxTokens,
          temperature: this.#config.temperature,
          reasoningEffort: this.#config.reasoningEffort,
          signal,
        };

        let result: ChatResult | undefined;
        try {
          for await (const event of this.#provider.stream(request)) {
            if (event.type === 'text') {
              if (event.text !== '') yield { type: 'assistant.delta', turnId, text: event.text };
            } else if (event.type === 'reasoning') {
              if (event.text !== '') yield { type: 'reasoning.delta', turnId, text: event.text };
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
          this.#logger.error(
            { sessionKey, turnId, iteration, kind: ghost.kind, err: ghost.message },
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
          break;
        }

        if (result === undefined) {
          // A stream that ends without its `done` event has not reported tool
          // calls, usage or a finish reason. Treating that as an empty answer
          // would silently end the turn on a transport bug.
          yield {
            type: 'error',
            code: 'provider_error',
            message: 'The provider ended the stream without a result.',
            retryable: true,
            turnId,
          };
          stopReason = 'error';
          break;
        }

        usage = accumulateUsage(usage, result.usage);

        if (result.message.toolCalls.length === 0) {
          this.#store.append(sessionKey, result.message, { turnId });
          finalText = textOf(result.message);
          // The correction arrived while this answer was being composed. Keep
          // going so it is answered, rather than ending a turn the user has
          // already asked to change.
          if (this.#steering.hasPending(sessionKey)) continue;
          stopReason = 'complete';
          break;
        }

        const cancelled = yield* this.#runToolCalls(result, {
          sessionKey,
          turnId,
          nonce,
          signal,
          toolContext,
        });
        if (cancelled) {
          stopReason = 'aborted';
          break;
        }
      }
    } finally {
      // Whatever ended the turn — completion, a cap, an abandoned iterator —
      // nothing queued for it may leak into the next one.
      this.#steering.clear(sessionKey);
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
      this.#store.append(sessionKey, assistantMessage(finalText), { turnId });
      yield { type: 'assistant.delta', turnId, text: finalText };
    }

    yield { type: 'turn.end', turnId, stopReason, usage, iterations: iteration };

    return { turnId, stopReason, iterations: iteration, usage, text: finalText };
  }

  /**
   * Runs every tool the model asked for. Returns whether the turn was cancelled.
   *
   * The assistant message and all of its results are appended in one
   * transaction at the end, because a partial write is exactly the orphaned
   * tool result that `findLegalStart` then has to repair on every later
   * request. Once cancelled, the remaining calls are not executed — but each
   * still gets a result, so the `assistant` turn is never left with an
   * unanswered `tool_call`.
   */
  async *#runToolCalls(
    result: ChatResult,
    turn: {
      sessionKey: string;
      turnId: string;
      nonce: string;
      signal: AbortSignal;
      toolContext: ToolContext;
    },
  ): AsyncGenerator<AgentEvent, boolean> {
    const pending: ChatMessageInput[] = [result.message];
    let cancelled = turn.signal.aborted;

    for (const call of result.message.toolCalls) {
      const risk = this.#riskOf(call.name);
      yield {
        type: 'tool.call',
        turnId: turn.turnId,
        callId: call.id,
        name: call.name,
        args: parseToolArgs(call.argumentsJson),
        risk,
      };

      let execution: ToolExecution;
      if (cancelled) {
        execution = cancelledExecution(call.name);
      } else {
        // Between the event and the execution, and nowhere else: a transport
        // that gated it for itself would be one `if` away from an ungated one.
        const refusal = yield* this.#authorize(call, risk, turn);
        execution =
          refusal ?? (yield* this.#executeWithHeartbeat(call, turn.toolContext, turn.turnId));
      }

      if (execution.errorKind === 'aborted') cancelled = true;

      // Truncate first, wrap second. The other order cuts the closing delimiter
      // off the envelope, and a tool result the model cannot see the end of is
      // a tool result it reads as continuing into the conversation.
      const truncation = truncateHeadTail(execution.content, this.#maxToolResultChars);
      const wrapped = wrapToolOutput(truncation.text, { toolName: call.name, nonce: turn.nonce });
      const truncated = truncation.truncated || execution.truncated;

      pending.push({
        role: 'tool',
        toolCallId: call.id,
        name: call.name,
        content: wrapped.text,
        isError: execution.isError,
        truncated,
      });

      yield {
        type: 'tool.result',
        turnId: turn.turnId,
        callId: call.id,
        ok: !execution.isError,
        content: truncation.text,
        truncated,
        // Whole milliseconds, because this event *is* a `ServerMessage` and the
        // protocol says `z.number().int()`. `monotonic()` is `performance.now()`,
        // which returns fractions — and a client that validates its frames drops
        // the one that says the call finished, leaving a tool card spinning
        // forever over a tool that returned in a millisecond.
        durationMs: Math.round(execution.durationMs),
      };

      if (wrapped.findings.length > 0) {
        this.#logger.warn(
          { tool: call.name, signals: wrapped.findings.map((finding) => finding.signal) },
          'prompt injection signals in tool output',
        );
        yield {
          type: 'notice',
          kind: 'prompt_injection',
          message: describeInjectionFindings(wrapped.findings),
          turnId: turn.turnId,
          callId: call.id,
        };
      }
    }

    this.#store.appendMany(turn.sessionKey, pending, { turnId: turn.turnId });
    return cancelled;
  }

  /**
   * Whether this call may run — and, if not, the result that says so.
   *
   * Returning `undefined` means proceed. Anything else is a `ToolExecution`
   * that never executed, which is what keeps the "every tool call gets a `tool`
   * message" rule true for a call the user refused: a denial the model cannot
   * see is an unanswered `tool_call`, and that is a provider 400 on the next
   * turn rather than a refusal it can work around.
   *
   * An abort during an approval is a cancellation, not a denial. The difference
   * matters to the caller: a denial lets the turn continue so the model can
   * respond to it, while a cancellation stops the turn and the remaining calls.
   */
  async *#authorize(
    call: ToolCall,
    risk: ToolRisk,
    turn: { sessionKey: string; turnId: string; signal: AbortSignal },
  ): AsyncGenerator<AgentEvent, ToolExecution | undefined> {
    const approvals = this.#toolsConfig.approvals;
    const policy = approvals[risk];
    if (policy === 'allow') return undefined;

    let denial: DenialReason;
    if (policy === 'deny') {
      denial = 'policy';
    } else {
      const gate = this.#approvals;
      // `ask` with nobody to ask. Denying here would make the default config
      // refuse every `exec` in a terminal session, where the operator asking
      // for the command *is* the approval.
      if (gate === undefined) return undefined;

      const expiresAtMs = this.#clock.now() + approvals.timeoutMs;
      const request: ApprovalRequest = {
        sessionKey: turn.sessionKey,
        turnId: turn.turnId,
        callId: call.id,
        name: call.name,
        args: parseToolArgs(call.argumentsJson),
        risk,
        expiresAtMs,
        signal: turn.signal,
      };

      yield {
        type: 'tool.approvalRequest',
        turnId: turn.turnId,
        callId: call.id,
        name: call.name,
        args: request.args,
        risk,
        expiresAtMs,
      };

      const outcome = await this.#decide(gate, request, approvals.timeoutMs);
      if (outcome === 'approved') return undefined;
      if (outcome === 'aborted') return cancelledExecution(call.name);
      denial = outcome;
    }

    this.#logger.warn(
      { sessionKey: turn.sessionKey, turnId: turn.turnId, tool: call.name, risk, policy, denial },
      'tool call denied',
    );
    yield {
      type: 'notice',
      kind: 'approval_denied',
      message: deniedNotice(call.name, denial),
      turnId: turn.turnId,
      callId: call.id,
    };
    return deniedExecution(call.name, denial);
  }

  /**
   * Waits for a decision, a deadline, or the turn ending — whichever is first.
   *
   * The deadline is enforced here rather than left to the gate because the case
   * it exists for is a gate that never answers: a browser tab closed on an open
   * prompt, or a channel that has no way to render one. The timer is on the
   * injected clock, so a test advances time instead of waiting five minutes.
   *
   * A gate that throws denies. There is no failure mode of an approval
   * mechanism where the safe reading is "go ahead".
   */
  async #decide(
    gate: ApprovalGate,
    request: ApprovalRequest,
    timeoutMs: number,
  ): Promise<ApprovalOutcome> {
    const deadline = this.#tick(timeoutMs);
    const abort = watchAbort(request.signal);
    try {
      return await Promise.race<ApprovalOutcome>([
        gate.request(request).then(
          (decision) => {
            this.#logger.info(
              { tool: request.name, approved: decision.approved, scope: decision.scope },
              'approval decision',
            );
            return decision.approved ? 'approved' : 'declined';
          },
          (error: unknown) => {
            if (isAbortError(error)) return 'aborted';
            this.#logger.error(
              { tool: request.name, err: toGhostError(error, 'internal').message },
              'approval gate failed',
            );
            return 'declined';
          },
        ),
        deadline.promise.then((): ApprovalOutcome => 'timeout'),
        abort.promise,
      ]);
    } finally {
      deadline.cancel();
      abort.dispose();
    }
  }

  /**
   * One tool call, with a liveness event on a fixed cadence while it runs.
   *
   * The heartbeat is driven by the injected clock and raced against the call,
   * so a test advances fake timers instead of waiting 15 real seconds. The
   * timeout itself is not enforced here — `ToolRegistry` owns it, and owning it
   * in two places is how a call ends up with two different deadlines.
   */
  async *#executeWithHeartbeat(
    call: ToolCall,
    context: ToolContext,
    turnId: string,
  ): AsyncGenerator<AgentEvent, ToolExecution> {
    const started = this.#clock.monotonic();
    const running = this.#tools.execute(call, context).then((execution) => ({ execution }));

    if (this.#heartbeatMs <= 0) return (await running).execution;

    for (;;) {
      const beat = this.#tick(this.#heartbeatMs);
      const outcome = await Promise.race([running, beat.promise]);
      beat.cancel();
      if (outcome !== null) return outcome.execution;
      yield {
        type: 'tool.progress',
        turnId,
        callId: call.id,
        // Whole milliseconds — see `tool.result` above for why a fraction here
        // is a frame the client throws away rather than a rounding detail.
        elapsedMs: Math.round(this.#clock.monotonic() - started),
        message: `${call.name} is still running`,
      };
    }
  }

  #riskOf(name: string): ToolRisk {
    return this.#tools.get(name)?.risk ?? 'safe';
  }

  /**
   * A promise that resolves once the clock advances, and a way to stop waiting.
   *
   * Cancelling matters more than it looks: one turn can make dozens of tool
   * calls, and a timer left armed on a real clock keeps the event loop alive
   * after the turn that created it has ended.
   */
  #tick(delayMs: number): Tick {
    let handle: TimerHandle | undefined;
    const promise = new Promise<null>((resolve) => {
      handle = this.#clock.setTimeout(() => {
        resolve(null);
      }, delayMs);
    });
    return {
      promise,
      cancel: () => {
        if (handle !== undefined) this.#clock.clearTimeout(handle);
      },
    };
  }
}
