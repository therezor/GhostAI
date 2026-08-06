/**
 * The tool half of a turn: authorise, run, answer.
 *
 * `loop.ts` owns the turn — the prompt, the provider, the stream, the caps —
 * and hands each assistant message that asked for tools to `dispatch`. What
 * comes back is the events the operator sees and the messages the turn should
 * append. The store is not this file's to write.
 *
 * Two invariants live here rather than upstairs, because this is the only place
 * that can hold them:
 *
 *  - **Every tool call gets a `tool` message.** Providers reject an `assistant`
 *    turn whose `tool_calls` were never answered, so a call that was cancelled,
 *    denied, or arrived on an agent with tools switched off still produces a
 *    result — no execution, still an answer. Stopping mid-tool without writing
 *    one would make the *next* turn fail on history the user cannot see, long
 *    after the Ctrl-C that caused it. That is also why `dispatch` returns the
 *    whole batch: one `appendMany` upstairs, never a partial write.
 *  - **Permission is checked between the `tool.call` event and execution**,
 *    which is the only place it can be checked once for every transport. A
 *    transport that gated it for itself would be one `if` away from an ungated
 *    one. The answer comes from the scope — `tools.permissionFor(name)` —
 *    because the scope is what knows whether a name resolved to a built-in or
 *    to a program in this agent's toolbox. What this file decides is whether to
 *    ask; what the answer is, and how long it holds, belong to the gate. See
 *    `approval.ts`.
 *
 * A subagent call is authorised here too, on the same path, and then handed
 * back to the loop through `SubagentDelegate` — delegation needs the loop
 * resolver, the store and the lineage, none of which belong to a dispatcher.
 *
 * Nothing here falls back to a default. Every collaborator is resolved by
 * `AgentLoop` and passed in, so there is no branch in this file that a turn
 * does not take.
 */

import {
  isAbortError,
  onAbort,
  toGhostError,
  truncateHeadTail,
  type AbortSubscription,
  type ChatMessageInput,
  type Clock,
  type Logger,
  type TimerHandle,
} from '@ghostai/core';
import type { ToolCall, ToolRisk, ToolsConfig } from '@ghostai/protocol';
import type { ChatResult } from '@ghostai/providers';
import { describeInjectionFindings, wrapToolOutput } from '@ghostai/security';
import type { ToolContext, ToolExecution, ToolScope } from '@ghostai/tools';

import {
  deniedNotice,
  deniedToolResult,
  type ApprovalGate,
  type ApprovalRequest,
  type DenialReason,
} from './approval.js';
import type { AgentEvent } from './events.js';
import type { SubagentBinding } from './subagent.js';

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
export const CANCELLED_TOOL_RESULT =
  'Cancelled: the turn was stopped before this tool finished.';

/**
 * The model's arguments, as the UI should see them.
 *
 * Parsing is best-effort on purpose: malformed JSON from a model is common
 * enough that it must not break the event stream, and the registry is the thing
 * that turns it into a typed tool error the model can recover from. Here it is
 * only being displayed.
 */
export function parseToolArgs(argumentsJson: string): unknown {
  if (argumentsJson.trim() === '') return {};
  try {
    return JSON.parse(argumentsJson) as unknown;
  } catch {
    return argumentsJson;
  }
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

/**
 * A call that arrived on an agent whose tools are switched off.
 *
 * `config` rather than `permission_denied`: nothing was denied. The agent's
 * permission map is untouched and still says `allow`; this model was simply
 * never sent a tool list, so the call is one it invented. The wording says the
 * tool did not run, because the alternative reading — that it ran and the
 * output was lost — is the one that has a model retry the same command.
 */
function toolsDisabledExecution(name: string): ToolExecution {
  return {
    name,
    content:
      `Refused: tool calling is switched off for this model, so "${name}" did not run and ` +
      `nothing happened. No tools are available on this turn — answer from the conversation, ` +
      `or tell the user what you would need to do and why you cannot.`,
    isError: true,
    truncated: false,
    durationMs: 0,
    errorKind: 'config',
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
  // Resolves rather than rejects: this races an approval, and a cancellation is
  // an outcome the race reports rather than an error it throws. `onAbort` owns
  // the two parts that are the same everywhere — firing for a signal that has
  // already aborted, and coming back off a signal that outlives this call.
  let subscription: AbortSubscription | undefined;
  const promise = new Promise<'aborted'>((resolve) => {
    subscription = onAbort(signal, () => {
      resolve('aborted');
    });
  });
  return {
    promise,
    dispose: () => {
      subscription?.dispose();
    },
  };
}

/** A timer that can be abandoned without leaving the clock holding a callback. */
interface Tick {
  readonly promise: Promise<null>;
  cancel(): void;
}

/**
 * What the tool half of a turn needs from the half above it.
 *
 * Named rather than inlined because it grew past the point where an inline
 * object literal in two signatures is one shape: `dispatch` and the loop's
 * `#runSubagent` must agree about it, and a subagent needs the workspace and the
 * chain that `#authorize` does not.
 */
export interface TurnScope {
  readonly sessionKey: string;
  readonly turnId: string;
  readonly nonce: string;
  readonly signal: AbortSignal;
  readonly toolContext: ToolContext;
  /** The session's, so a subagent works in the folder its caller does. */
  readonly workspaceId: string;
  /** Ancestor agent ids, oldest first. See `refuseDelegation`. */
  readonly chain: readonly string[];
  /** The conversation a person is watching. See `ApprovalRequest`. */
  readonly rootSessionKey: string;
}

/**
 * One delegated task, run by the loop.
 *
 * Delegation stays in `AgentLoop` because a subagent's turn is a real turn on a
 * real loop — it needs the loop resolver, the store and the lineage. The
 * dispatcher only needs to know that a call may be answered by one.
 */
type SubagentDelegate = (
  call: ToolCall,
  binding: SubagentBinding,
  turn: TurnScope,
) => AsyncGenerator<AgentEvent, ToolExecution>;

interface ToolDispatcherOptions {
  readonly tools: ToolScope;
  readonly subagents: ReadonlyMap<string, SubagentBinding>;
  /**
   * Required and nullable rather than optional: `exactOptionalPropertyTypes`
   * makes `approvals?: ApprovalGate` reject an `ApprovalGate | undefined`, and
   * the spread that works around it would put a branch here that no test can
   * reach both sides of.
   */
  readonly approvals: ApprovalGate | undefined;
  readonly toolsConfig: ToolsConfig;
  readonly toolsEnabled: boolean;
  readonly maxToolResultChars: number;
  readonly heartbeatMs: number;
  readonly agentId: string;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly delegate: SubagentDelegate;
}

/** What one assistant turn's tool calls produced. */
interface ToolCallOutcome {
  readonly cancelled: boolean;
  /**
   * The assistant message and one `tool` message per call, in the order the
   * model asked. The caller appends them — in one transaction, because a
   * partial write is exactly the orphaned tool result `findLegalStart` then
   * has to repair on every later request.
   */
  readonly pending: readonly ChatMessageInput[];
}

/**
 * Runs the tools one assistant turn asked for.
 *
 * Every default is resolved by `AgentLoop` before it gets here — nothing in the
 * constructor falls back, so there is no branch in this file that a turn does
 * not take.
 */
export class ToolDispatcher {
  private readonly tools: ToolScope;
  private readonly subagents: ReadonlyMap<string, SubagentBinding>;
  private readonly approvals: ApprovalGate | undefined;
  private readonly toolsConfig: ToolsConfig;
  private readonly toolsEnabled: boolean;
  private readonly maxToolResultChars: number;
  private readonly heartbeatMs: number;
  private readonly agentId: string;
  private readonly clock: Clock;
  private readonly logger: Logger;
  private readonly delegate: SubagentDelegate;

  constructor(options: ToolDispatcherOptions) {
    this.tools = options.tools;
    this.subagents = options.subagents;
    this.approvals = options.approvals;
    this.toolsConfig = options.toolsConfig;
    this.toolsEnabled = options.toolsEnabled;
    this.maxToolResultChars = options.maxToolResultChars;
    this.heartbeatMs = options.heartbeatMs;
    this.agentId = options.agentId;
    this.clock = options.clock;
    this.logger = options.logger;
    this.delegate = options.delegate;
  }

  /** The binding for a call, or `undefined` when a registered tool wins. */
  private subagentFor(name: string): SubagentBinding | undefined {
    const binding = this.subagents.get(name);
    if (binding === undefined) return undefined;
    // The same precedence `AgentLoop.toolDefinitions` applies, asked the same
    // way — so a shadowed subagent is not advertised *and* is not reachable,
    // rather than being invisible to the model and callable by a lucky guess.
    return this.tools.get(name) === undefined ? binding : undefined;
  }

  /**
   * Runs every tool the model asked for.
   *
   * Returns the messages to append rather than appending them: the store is the
   * turn's to write, and handing back one array is what keeps "the assistant
   * message and all of its results land in one transaction" a property of the
   * shape rather than a rule to remember. Once cancelled, the remaining calls
   * are not executed — but each still gets a result, so the `assistant` turn is
   * never left with an unanswered `tool_call`.
   */
  async *dispatch(
    result: ChatResult,
    turn: TurnScope,
  ): AsyncGenerator<AgentEvent, ToolCallOutcome> {
    const pending: ChatMessageInput[] = [result.message];
    let cancelled = turn.signal.aborted;

    for (const call of result.message.toolCalls) {
      const risk = this.riskOf(call.name);
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
        // A subagent is authorised here too — its binding carries a permission
        // exactly as the scope carries a tool's, so `ask` gets the same prompt.
        const refusal = yield* this.authorize(call, risk, turn);
        const binding = this.subagentFor(call.name);
        execution =
          refusal ??
          (binding === undefined
            ? yield* this.executeWithHeartbeat(
                call,
                turn.toolContext,
                turn.turnId,
              )
            : yield* this.delegate(call, binding, turn));
      }

      if (execution.errorKind === 'aborted') cancelled = true;

      // Truncate first, wrap second. The other order cuts the closing delimiter
      // off the envelope, and a tool result the model cannot see the end of is
      // a tool result it reads as continuing into the conversation.
      const truncation = truncateHeadTail(
        execution.content,
        this.maxToolResultChars,
      );
      const wrapped = wrapToolOutput(truncation.text, {
        toolName: call.name,
        nonce: turn.nonce,
      });
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
        this.logger.warn(
          {
            tool: call.name,
            signals: wrapped.findings.map((finding) => finding.signal),
          },
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

    return { cancelled, pending };
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
  private async *authorize(
    call: ToolCall,
    risk: ToolRisk,
    turn: {
      sessionKey: string;
      rootSessionKey: string;
      turnId: string;
      signal: AbortSignal;
    },
  ): AsyncGenerator<AgentEvent, ToolExecution | undefined> {
    // Before the permission lookup, and deliberately not expressed as one: the
    // agent's map is untouched and still says `allow`, so asking it would run
    // the call. The request carried no `tools` at all, which makes anything
    // arriving here a name the model invented — and this is the one enforcement
    // point every call passes through, including a subagent's, so gating it
    // here is what makes "nothing executes" true rather than mostly true.
    //
    // A refusal rather than a silent drop, because every `tool_call` must be
    // answered by a `tool` message: an unanswered one is a dangling call the
    // model waits on and a provider 400 on the next request.
    if (!this.toolsEnabled) {
      this.logger.warn(
        {
          sessionKey: turn.sessionKey,
          turnId: turn.turnId,
          tool: call.name,
          risk,
        },
        'tool call refused: tools are switched off for this model',
      );
      yield {
        type: 'notice',
        kind: 'tools_disabled',
        message: `Refused "${call.name}": tool calling is off for this model, so nothing ran.`,
        turnId: turn.turnId,
        callId: call.id,
      };
      return toolsDisabledExecution(call.name);
    }

    // The binding first, and only when the registry has no such name — the same
    // precedence `#subagentFor` and `toolDefinitions` apply, asked once here so
    // a shadowed subagent is gated as the registered tool it actually is.
    const permission =
      this.subagentFor(call.name)?.permission ??
      this.tools.permissionFor(call.name);
    if (permission === 'allow') return undefined;

    let denial: DenialReason;
    if (permission === 'deny') {
      // Belt and braces. A denied tool is not in the definitions the model was
      // sent and `execute` would report it as `not_found`, so reaching here
      // means something advertised a tool this scope does not permit — which is
      // exactly the case an enforcement point exists to catch.
      denial = 'policy';
    } else {
      const gate = this.approvals;
      // `ask` with nobody to ask. Denying here would make the default config
      // refuse every `exec` in a terminal session, where the operator asking
      // for the command *is* the approval.
      if (gate === undefined) return undefined;

      const timeoutMs = this.toolsConfig.approvalTimeoutMs;
      const expiresAtMs = this.clock.now() + timeoutMs;
      const request: ApprovalRequest = {
        sessionKey: turn.sessionKey,
        rootSessionKey: turn.rootSessionKey,
        agentId: this.agentId,
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

      const outcome = await this.decide(gate, request, timeoutMs);
      if (outcome === 'approved') return undefined;
      if (outcome === 'aborted') return cancelledExecution(call.name);
      denial = outcome;
    }

    this.logger.warn(
      {
        sessionKey: turn.sessionKey,
        turnId: turn.turnId,
        tool: call.name,
        risk,
        permission,
        denial,
      },
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
  private async decide(
    gate: ApprovalGate,
    request: ApprovalRequest,
    timeoutMs: number,
  ): Promise<ApprovalOutcome> {
    const deadline = this.tick(timeoutMs);
    const abort = watchAbort(request.signal);
    try {
      return await Promise.race<ApprovalOutcome>([
        gate.request(request).then(
          (decision) => {
            this.logger.info(
              {
                tool: request.name,
                approved: decision.approved,
                scope: decision.scope,
              },
              'approval decision',
            );
            return decision.approved ? 'approved' : 'declined';
          },
          (error: unknown) => {
            if (isAbortError(error)) return 'aborted';
            this.logger.error(
              {
                tool: request.name,
                err: toGhostError(error, 'internal').message,
              },
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
  private async *executeWithHeartbeat(
    call: ToolCall,
    context: ToolContext,
    turnId: string,
  ): AsyncGenerator<AgentEvent, ToolExecution> {
    const started = this.clock.monotonic();
    const running = this.tools
      .execute(call, context)
      .then((execution) => ({ execution }));

    if (this.heartbeatMs <= 0) return (await running).execution;

    for (;;) {
      const beat = this.tick(this.heartbeatMs);
      const outcome = await Promise.race([running, beat.promise]);
      beat.cancel();
      if (outcome !== null) return outcome.execution;
      yield {
        type: 'tool.progress',
        turnId,
        callId: call.id,
        // Whole milliseconds — see `tool.result` above for why a fraction here
        // is a frame the client throws away rather than a rounding detail.
        elapsedMs: Math.round(this.clock.monotonic() - started),
        message: `${call.name} is still running`,
      };
    }
  }

  private riskOf(name: string): ToolRisk {
    return this.tools.get(name)?.risk ?? 'safe';
  }

  /**
   * A promise that resolves once the clock advances, and a way to stop waiting.
   *
   * Cancelling matters more than it looks: one turn can make dozens of tool
   * calls, and a timer left armed on a real clock keeps the event loop alive
   * after the turn that created it has ended.
   */
  private tick(delayMs: number): Tick {
    let handle: TimerHandle | undefined;
    const promise = new Promise<null>((resolve) => {
      handle = this.clock.setTimeout(() => {
        resolve(null);
      }, delayMs);
    });
    return {
      promise,
      cancel: () => {
        if (handle !== undefined) this.clock.clearTimeout(handle);
      },
    };
  }
}
