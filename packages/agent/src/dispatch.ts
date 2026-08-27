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
 *  - **Adjacent read-only calls run together; everything else runs in order.**
 *    A model asks for six files in one message and they used to be fetched one
 *    after another for no reason but the shape of the loop. Grouping is
 *    *adjacent* runs only, which is the safety property rather than a
 *    simplification: `read, read, write, read` becomes `[read‖read]`, `write`,
 *    `read`, so a write is never reordered past a read. A delegation and a call
 *    that would prompt are both excluded — see `isParallelEligible`.
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
} from '@ghostwire/core';
import type { ToolCall, ToolRisk, ToolsConfig } from '@ghostwire/protocol';
import type { ChatResult } from '@ghostwire/providers';
import { describeInjectionFindings, wrapToolOutput } from '@ghostwire/security';
import type { ToolContext, ToolExecution, ToolScope } from '@ghostwire/tools';

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

/**
 * How many read-only calls may be in flight at once.
 *
 * A bound rather than a tuning knob, which is why it is here and not in
 * `ToolsConfig`: the calls it governs are read-only by definition, so there is
 * no contention story an operator would need to tune against — no GPU, no
 * shared container, no lock. What it stops is a model asking for two hundred
 * files at once and opening two hundred file handles to answer.
 *
 * Eight, because the batches models actually emit are three to six.
 */
export const MAX_PARALLEL_TOOL_CALLS = 8;

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

/** What one parallel group produced. Ordered as the model asked. */
interface GroupOutcome {
  readonly cancelled: boolean;
  readonly messages: readonly ChatMessageInput[];
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

    for (const group of this.groupCalls(result.message.toolCalls)) {
      // A group of one is the whole of the path that existed before
      // parallelism, and it is the common case: no timer, no queue, nothing
      // allocated that a single call did not allocate before.
      const solo = group.length === 1 ? group[0] : undefined;
      if (solo !== undefined) {
        yield this.callEvent(solo, turn.turnId);

        let execution: ToolExecution;
        if (cancelled) {
          execution = cancelledExecution(solo.name);
        } else {
          // Between the event and the execution, and nowhere else: a transport
          // that gated it for itself would be one `if` away from an ungated one.
          // A subagent is authorised here too — its binding carries a permission
          // exactly as the scope carries a tool's, so `ask` gets the same prompt.
          const refusal = yield* this.authorize(
            solo,
            this.riskOf(solo.name),
            turn,
          );
          const binding = this.subagentFor(solo.name);
          execution =
            refusal ??
            (binding === undefined
              ? yield* this.executeWithHeartbeat(
                  solo,
                  turn.toolContext,
                  turn.turnId,
                )
              : yield* this.delegate(solo, binding, turn));
        }

        if (execution.errorKind === 'aborted') cancelled = true;
        pending.push(yield* this.finish(solo, execution, turn));
        continue;
      }

      // Cancelled before the group started. Nothing runs, and every member
      // still gets its `tool` message — the same rule the sequential path
      // follows, applied to the whole run at once.
      if (cancelled) {
        for (const call of group) {
          yield this.callEvent(call, turn.turnId);
          pending.push(
            yield* this.finish(call, cancelledExecution(call.name), turn),
          );
        }
        continue;
      }

      const outcome = yield* this.runParallel(group, turn);
      if (outcome.cancelled) cancelled = true;
      pending.push(...outcome.messages);
    }

    return { cancelled, pending };
  }

  /** The `tool.call` event a call announces itself with. */
  private callEvent(call: ToolCall, turnId: string): AgentEvent {
    return {
      type: 'tool.call',
      turnId,
      callId: call.id,
      name: call.name,
      args: parseToolArgs(call.argumentsJson),
      risk: this.riskOf(call.name),
    };
  }

  /**
   * Turns one finished execution into its `tool` message and the events that
   * report it.
   *
   * Shared by both paths so there is one place that truncates, wraps and
   * reports. The alternative is two copies of the truncate-then-wrap order, and
   * getting that order wrong in one of them fails silently.
   */
  private *finish(
    call: ToolCall,
    execution: ToolExecution,
    turn: TurnScope,
  ): Generator<AgentEvent, ChatMessageInput> {
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

    return {
      role: 'tool',
      toolCallId: call.id,
      name: call.name,
      content: wrapped.text,
      isError: execution.isError,
      truncated,
    };
  }

  /**
   * Whether this call may run beside its neighbours.
   *
   * `risk === 'safe'` is the whole predicate, and reusing it rather than adding
   * a second field is deliberate: it already means "read-only, as declared by
   * the tool or its server", and `bridge.ts` already trusts an MCP server's
   * `readOnlyHint` to set that tool's *approval* bar — a strictly
   * higher-stakes use of the same claim than setting a scheduling one. A second
   * vocabulary for one fact is two things to keep in step.
   *
   * The lookup is `tools.get`, not `riskOf`, because `riskOf` answers `'safe'`
   * for a name it cannot resolve. An invented name has to stay sequential and
   * take its `not_found` on the ordinary path.
   *
   * `allow` is required, and that is what makes an approval prompt impossible
   * inside a group — so there is no question of whose prompt appears first, and
   * no ordering to get wrong. A `safe` tool an operator set to `ask` simply runs
   * on its own, which is right: if every read is prompted, the prompts are the
   * latency.
   */
  private isParallelEligible(call: ToolCall): boolean {
    if (!this.toolsEnabled) return false;
    // A delegation is a whole turn on another loop, not a tool call. Two of them
    // at once is background agents, which this deliberately is not.
    if (this.subagentFor(call.name) !== undefined) return false;
    if (this.tools.get(call.name)?.risk !== 'safe') return false;
    return this.tools.permissionFor(call.name) === 'allow';
  }

  /**
   * Splits the batch into runs that may execute together.
   *
   * **Adjacent runs only.** See the header: a write must never be reordered
   * past a read, and gathering every eligible call regardless of position would
   * do exactly that.
   */
  private groupCalls(calls: readonly ToolCall[]): ToolCall[][] {
    const groups: ToolCall[][] = [];
    let run: ToolCall[] = [];
    const flush = (): void => {
      if (run.length > 0) {
        groups.push(run);
        run = [];
      }
    };

    for (const call of calls) {
      if (!this.isParallelEligible(call)) {
        flush();
        groups.push([call]);
        continue;
      }
      run.push(call);
      if (run.length === MAX_PARALLEL_TOOL_CALLS) flush();
    }
    flush();
    return groups;
  }

  /**
   * One group, in flight together.
   *
   * **One heartbeat for the group, not one per call.** `executeWithHeartbeat`
   * yields nothing but `tool.progress`, and `authorize` and `delegate` are both
   * excluded by `isParallelEligible` — so a group produces no concurrent event
   * *streams* to interleave, only a liveness tick. That is what keeps this a
   * loop over a completion queue rather than a generator-merging combinator.
   *
   * **Results are reported as they land, not gathered at the end.** A card
   * resolving on its own is the behaviour every renderer already shows for a
   * delegation; `Promise.all` here would leave a fast read spinning until the
   * slowest member of its group finished.
   *
   * **The messages come back in the order the model asked**, whatever order
   * they finished in, because the batch is a single `appendMany` upstairs and a
   * `tool` message that does not follow its `tool_call` is a provider 400.
   */
  private async *runParallel(
    group: readonly ToolCall[],
    turn: TurnScope,
  ): AsyncGenerator<AgentEvent, GroupOutcome> {
    for (const call of group) {
      yield this.callEvent(call, turn.turnId);
    }

    const startedAt = this.clock.monotonic();
    const running = new Map<number, ToolCall>();
    const done: Array<{
      index: number;
      call: ToolCall;
      execution: ToolExecution;
    }> = [];
    const finished: Array<{ index: number; message: ChatMessageInput }> = [];
    let failure: { error: unknown } | undefined;
    let wake: (() => void) | undefined;

    group.forEach((call, index) => {
      running.set(index, call);
      void this.tools.execute(call, turn.toolContext).then(
        (execution) => {
          done.push({ index, call, execution });
          running.delete(index);
          wake?.();
        },
        // `ToolRegistry.execute` says "never throws" and means it, so this is
        // the seam a scope from somewhere else would come through. It is not
        // the sequential path's `await`, where a rejection unwinds the turn:
        // a rejection with no handler here is an *unhandled* one, which under
        // Node's default takes the process down. Held, then rethrown below, so
        // the turn fails exactly the way it does today.
        (error: unknown) => {
          failure ??= { error };
          running.delete(index);
          wake?.();
        },
      );
    });

    let cancelled = false;
    for (;;) {
      for (const entry of done.splice(0, done.length)) {
        if (entry.execution.errorKind === 'aborted') cancelled = true;
        finished.push({
          index: entry.index,
          message: yield* this.finish(entry.call, entry.execution, turn),
        });
      }
      if (failure !== undefined) throw failure.error;
      if (running.size === 0) break;

      // Armed before the check below, so a call that finishes between the two
      // resolves this promise rather than being missed until the next beat.
      const settled = new Promise<void>((resolve) => {
        wake = resolve;
      });
      if (done.length === 0) {
        if (this.heartbeatMs > 0) {
          const beat = this.tick(this.heartbeatMs);
          const woke = await Promise.race([
            settled.then(() => 'settled' as const),
            beat.promise.then(() => 'beat' as const),
          ]);
          beat.cancel();
          if (woke === 'beat') {
            const elapsedMs = Math.round(this.clock.monotonic() - startedAt);
            for (const call of running.values()) {
              yield {
                type: 'tool.progress',
                turnId: turn.turnId,
                callId: call.id,
                elapsedMs,
                message: `${call.name} is still running`,
              };
            }
          }
        } else {
          await settled;
        }
      }
      wake = undefined;
    }

    finished.sort((left, right) => left.index - right.index);
    return { cancelled, messages: finished.map((entry) => entry.message) };
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
