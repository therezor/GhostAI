/**
 * What a turn emits.
 *
 * One discriminated union, and every member is a `ServerMessage` from
 * `@ghostbot/protocol` minus the fields the transport owns. The WebSocket hub in
 * Phase 2 forwards an event by stamping a `seq` on it — there is no mapping
 * table, no per-event translation function, and therefore no place for the two
 * shapes to drift. `events.test.ts` asserts that literally: every event here,
 * plus a `seq`, parses as a `ServerMessage`.
 *
 * The transport owns exactly two things:
 *
 *  - **`seq`**, because sequencing is per *connection state*, not per turn. The
 *    loop does not know what else the session has emitted, and a counter it
 *    kept would restart on every turn.
 *  - **`sessionKey`** on the events that carry one. The loop is handed a session
 *    key and puts it on `turn.start`, where a client learns which conversation
 *    the turn belongs to; the per-delta events identify themselves by `turnId`
 *    alone, which is what keeps a streaming event small.
 *
 * The names are the protocol's dotted names rather than a local convention. A
 * CLI renderer and a WebSocket client then switch on the same strings, and the
 * 1:1 property stays visible at every call site instead of living in a comment.
 */

import type {
  ErrorCode,
  NoticeKind,
  StopReason,
  ToolRisk,
  Usage,
} from '@ghostbot/protocol';

export interface TurnStartEvent {
  readonly type: 'turn.start';
  readonly sessionKey: string;
  readonly turnId: string;
  /** Which agent is running the turn. `default` on an install that named none. */
  readonly agentId: string;
  readonly model: string;
  readonly provider: string;
  /** The user message that started it — see the protocol schema. */
  readonly firstSeq?: number;
}

/** A chunk of the answer. Consumers append; the loop never resends. */
export interface AssistantDeltaEvent {
  readonly type: 'assistant.delta';
  readonly turnId: string;
  readonly text: string;
}

export interface ReasoningDeltaEvent {
  readonly type: 'reasoning.delta';
  readonly turnId: string;
  readonly text: string;
}

export interface ToolCallEvent {
  readonly type: 'tool.call';
  readonly turnId: string;
  readonly callId: string;
  readonly name: string;
  /** Parsed arguments when the model emitted valid JSON; the raw string otherwise. */
  readonly args: unknown;
  readonly risk: ToolRisk;
}

/**
 * Liveness while a tool runs.
 *
 * Emitted on a fixed cadence rather than on tool progress, because the tools
 * that need it — an `exec` running a build, an MCP call to a slow server —
 * report nothing until they finish. A UI showing a spinner needs to know the
 * difference between "still working" and "the loop died", and only the loop can
 * tell it that.
 */
export interface ToolProgressEvent {
  readonly type: 'tool.progress';
  readonly turnId: string;
  readonly callId: string;
  readonly elapsedMs: number;
  readonly message?: string;
}

/**
 * A call is waiting for a decision, and nothing has run yet.
 *
 * Emitted only where the policy for the tool's risk band is `ask` *and* a gate
 * is installed, so a transport that never answers one will never see one. The
 * loop enforces `expiresAtMs` itself rather than trusting the gate to — the
 * deadline exists precisely for the case where nothing answers.
 */
export interface ToolApprovalRequestEvent {
  readonly type: 'tool.approvalRequest';
  readonly turnId: string;
  readonly callId: string;
  readonly name: string;
  /** Parsed arguments when the model emitted valid JSON; the raw string otherwise. */
  readonly args: unknown;
  readonly risk: ToolRisk;
  /** Wall clock, not elapsed: a reconnecting client has to render the same deadline. */
  readonly expiresAtMs: number;
}

/**
 * The outcome of one call.
 *
 * `content` is the tool's own output — truncated, but *not* wrapped in the
 * turn's delimiter. The envelope exists to tell a language model which region
 * of its context is inert data; showing it to a human in a tool card would be
 * displaying a defence mechanism as though it were part of the answer. The
 * wrapped form is what goes to history and to the model.
 */
export interface ToolResultEvent {
  readonly type: 'tool.result';
  readonly turnId: string;
  readonly callId: string;
  readonly ok: boolean;
  readonly content: string;
  readonly truncated: boolean;
  readonly durationMs: number;
}

/**
 * Advisory. Never a reason for the loop to change what it does.
 *
 * `prompt_injection` is the one that has to stay advisory: the detection is
 * non-destructive by design, so a finding raises a badge and the tool output
 * reaches the model byte-for-byte. Acting on a finding — dropping the result,
 * rewriting it — is how a security feature becomes a way to blind the agent to
 * any document that discusses prompt injection.
 */
export interface NoticeEvent {
  readonly type: 'notice';
  readonly kind: NoticeKind;
  readonly message: string;
  readonly turnId?: string;
  readonly callId?: string;
}

/**
 * The turn failed.
 *
 * Distinct from `turn.end` with `stopReason: 'error'`, which still follows:
 * this carries what went wrong, and `turn.end` closes the turn exactly once
 * however it ended. A consumer that only tracks turn lifecycle can ignore this
 * event entirely.
 */
interface AgentErrorEvent {
  readonly type: 'error';
  readonly code: ErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly turnId?: string;
}

export interface TurnEndEvent {
  readonly type: 'turn.end';
  readonly turnId: string;
  readonly stopReason: StopReason;
  readonly usage?: Usage;
  readonly iterations: number;
  /** Wall time across the whole turn — the divisor behind a tokens/s figure. */
  readonly elapsedMs?: number;
  /**
   * The seqs this turn spans in storage.
   *
   * `firstSeq` is the user message that started it, which is what a regenerate
   * re-runs from and what a branch forks at — reporting it here is what lets a
   * client offer those actions on a message it just watched being sent, rather
   * than after a refetch.
   */
  readonly firstSeq?: number;
  readonly lastSeq?: number;
}

/**
 * Everything a turn emits on its own behalf.
 *
 * Named separately from `AgentEvent` because it is what a *subagent's* events
 * are wrapped around: a subagent produces these, and the loop above it turns
 * each one into a `SubagentEvent`. Excluding the wrapper from its own payload is
 * what keeps the protocol schema non-recursive — see `SubagentEvent`.
 */
export type NestedAgentEvent =
  | TurnStartEvent
  | AssistantDeltaEvent
  | ReasoningDeltaEvent
  | ToolCallEvent
  | ToolProgressEvent
  | ToolApprovalRequestEvent
  | ToolResultEvent
  | NoticeEvent
  | AgentErrorEvent
  | TurnEndEvent;

/**
 * One event from a subagent's turn, addressed to the card it belongs under.
 *
 * The reasoning for the shape — why a wrapper rather than an optional field on
 * every event, why `parentSessionKey` is part of the address, and why depth
 * beyond one level is forwarding rather than nesting — is on
 * `SubagentEventSchema` in `@ghostbot/protocol`, which this must stay 1:1 with.
 *
 * The one thing worth restating here, because it is the loop's job rather than
 * the schema's: **`turnId` is the root turn, not the subagent's own.** The
 * subagent's turn id is on the inner event, where it belongs; this field is what
 * a transcript uses to find the turn a person is reading.
 */
export interface SubagentEvent {
  readonly type: 'subagent.event';
  readonly turnId: string;
  readonly parentSessionKey: string;
  readonly parentCallId: string;
  readonly agentId: string;
  readonly label: string;
  readonly sessionKey: string;
  /** 1 for a subagent of the session's own agent. */
  readonly depth: number;
  readonly event: NestedAgentEvent;
}

export type AgentEvent = NestedAgentEvent | SubagentEvent;

export type AgentEventType = AgentEvent['type'];
