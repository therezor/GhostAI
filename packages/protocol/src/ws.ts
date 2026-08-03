/**
 * The WebSocket protocol.
 *
 * Both directions are discriminated unions on `type`, so a handler is an
 * exhaustive switch and adding a message without handling it is a type error.
 * Event names are spelled out rather than abbreviated: a wire format that
 * re-derives shapes from single-letter keys inline saves bytes that the
 * WebSocket layer's compression would have saved anyway, and costs the
 * discriminator.
 *
 * ## Sequencing
 *
 * Every server event that belongs to a turn carries a monotonic `seq`, unique
 * per session and never reused. A reconnecting tab sends
 * `session.resume { lastSeq }` and the server replays everything after it from
 * the ring buffer (`server.replayBufferSize`), so a page refresh mid-stream
 * rebuilds the in-flight turn instead of losing it. Session-scoped rather than
 * turn-scoped because the client needs one cursor, not one per turn.
 *
 * Connection-level events (`connected`, `pong`, `error`) carry no `seq` — they
 * are not part of any session's replayable history.
 *
 * ## Who accumulates
 *
 * The server emits deltas and the client accumulates them. The server never
 * holds a running copy of the response text, because a server-side buffer that
 * has to be reset at the right moment makes the server stateful about what each
 * client has rendered. The only server-side state is the replay buffer, which is
 * append-only.
 */

import { z } from 'zod';

import {
  ApprovalScopeSchema,
  ToolDefinitionSchema,
  ToolRiskSchema,
} from './tools.js';
import {
  FilePartSchema,
  ImagePartSchema,
  StopReasonSchema,
  StoredMessageSchema,
  UsageSchema,
} from './messages.js';

/** Version of the wire protocol. Bumped on any breaking envelope change. */
export const PROTOCOL_VERSION = 2 as const;
export type ProtocolVersion = typeof PROTOCOL_VERSION;

// ---------------------------------------------------------------------------
// Client → server
// ---------------------------------------------------------------------------

/**
 * An upload attached to a message: a file in the workspace, named by its path.
 *
 * The path, and only the path. The field this replaces was "signed URL *or*
 * workspace-relative path", and that ambiguity is what broke attachments: the
 * web sent a signed URL, the server put it where a provider would try to fetch
 * it, and `/api/media/<token>` means nothing outside this origin — and expires
 * ten minutes later even here. A path is stable, resolvable by the file tools,
 * and signable on demand when a browser needs to draw it.
 */
export const AttachmentSchema = z.object({
  mimeType: z.string().min(1),
  /** Workspace-relative, as returned by `POST /api/files/upload`. */
  path: z.string().min(1),
  name: z.string().optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
});
export type Attachment = z.infer<typeof AttachmentSchema>;

/**
 * The most files one message may carry.
 *
 * A bound on the *count*, which the upload route's byte limit is not: every
 * attachment is read and inlined into the provider request on every iteration
 * of the turn, so a frame naming one small image a few thousand times costs
 * nothing to send and expands to thousands of base64 blocks in one body. Twenty
 * is far past what a person attaches to a message and far short of what hurts.
 */
export const MAX_ATTACHMENTS = 20;

const AttachmentsSchema = z
  .array(AttachmentSchema)
  .max(MAX_ATTACHMENTS)
  .default([]);

export const PingMessageSchema = z.object({
  type: z.literal('ping'),
});

export const UserMessageRequestSchema = z.object({
  type: z.literal('user.message'),
  sessionKey: z.string().min(1),
  content: z.string(),
  attachments: AttachmentsSchema,
  agentId: z.string().optional(),
  /**
   * Client-generated idempotency key. Lets a retry after a dropped socket avoid
   * appending the same user turn twice.
   */
  clientMessageId: z.string().optional(),
});

/**
 * Stop the in-flight turn. Threads through to the single `AbortSignal` that
 * reaches the provider fetch, the running tool and the child process. One
 * cancellation mechanism, so there is no path where the loop stops but the
 * `exec` child keeps running.
 */
export const StopTurnMessageSchema = z.object({
  type: z.literal('turn.stop'),
  sessionKey: z.string().min(1),
});

export const NewSessionMessageSchema = z.object({
  type: z.literal('session.new'),
  /** Server generates one when absent. */
  sessionKey: z.string().optional(),
  /**
   * Which workspace to create the conversation in. Defaults to `default`.
   *
   * Only ever *creates*: a session that already exists keeps the workspace it
   * was born in, whatever this says.
   */
  workspaceId: z.string().min(1).optional(),
  agentId: z.string().optional(),
});

/**
 * Deliberately carries no workspace.
 *
 * Switching to an existing session moves you to *its* workspace, and the hub
 * reports which one on the `session.status` that follows. Letting a client name
 * one here would let the UI's idea of the current workspace and the session's
 * own disagree, with the files on screen belonging to neither.
 */
export const SwitchSessionMessageSchema = z.object({
  type: z.literal('session.switch'),
  sessionKey: z.string().min(1),
});

/** Reconnect handshake: replay everything after `lastSeq`. */
export const ResumeSessionMessageSchema = z.object({
  type: z.literal('session.resume'),
  sessionKey: z.string().min(1),
  lastSeq: z.number().int().nonnegative(),
});

/** Answer to a `tool.approvalRequest`. */
export const ToolApproveMessageSchema = z.object({
  type: z.literal('tool.approve'),
  callId: z.string().min(1),
  approved: z.boolean(),
  scope: ApprovalScopeSchema.default('once'),
});

export const TranscribeMessageSchema = z.object({
  type: z.literal('audio.transcribe'),
  /** base64-encoded audio. */
  audio: z.string().min(1),
  mimeType: z.string().min(1),
});

/**
 * Mid-turn steering. The loop drains the steer queue and *continues* rather
 * than breaking, so guidance that arrives while the model is composing its
 * final answer still lands on the next iteration instead of being dropped.
 */
export const SteerMessageSchema = z.object({
  type: z.literal('turn.steer'),
  sessionKey: z.string().min(1),
  content: z.string().min(1),
});

/**
 * Re-run a turn, discarding the answer it produced.
 *
 * Over the socket rather than REST because it *starts a turn*, and every turn
 * goes through the hub so that the one-at-a-time rule, the FIFO queue, the
 * approval gate and the event stream all apply. A REST endpoint that started a
 * turn would be a second door into the loop, and would have to return before
 * anything it started had streamed.
 */
export const RegenerateMessageSchema = z.object({
  type: z.literal('turn.regenerate'),
  sessionKey: z.string().min(1),
  /** The user message to re-run from. Absent means the most recent turn. */
  seq: z.number().int().positive().optional(),
  /**
   * Here for the same reason it is on `user.edit`: re-running deletes the
   * question and the loop writes it back, so the client has to put the bubble
   * up itself meanwhile. This is the id the `message.ack` echoes, and without it
   * that bubble has nothing to reconcile against and sits on "Sending…".
   */
  clientMessageId: z.string().optional(),
});

/**
 * Replace a message and re-run from it.
 *
 * One frame rather than a truncate call followed by `user.message`: the two
 * halves are a single user intent, and splitting them leaves a window in which
 * another tab's queued message lands in the gap between them.
 */
export const EditMessageSchema = z.object({
  type: z.literal('user.edit'),
  sessionKey: z.string().min(1),
  /** Must address a `user` message; the hub refuses anything else. */
  seq: z.number().int().positive(),
  content: z.string(),
  attachments: AttachmentsSchema,
  agentId: z.string().optional(),
  clientMessageId: z.string().optional(),
});

export const ClientMessageSchema = z.discriminatedUnion('type', [
  PingMessageSchema,
  UserMessageRequestSchema,
  RegenerateMessageSchema,
  EditMessageSchema,
  StopTurnMessageSchema,
  NewSessionMessageSchema,
  SwitchSessionMessageSchema,
  ResumeSessionMessageSchema,
  ToolApproveMessageSchema,
  TranscribeMessageSchema,
  SteerMessageSchema,
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;
export type ClientMessageType = ClientMessage['type'];

// ---------------------------------------------------------------------------
// Server → client
// ---------------------------------------------------------------------------

/** Sequence number carried by every session-scoped server event. */
const seq = z.number().int().nonnegative();

export const ConnectedEventSchema = z.object({
  type: z.literal('connected'),
  protocolVersion: z.literal(PROTOCOL_VERSION),
  sessionKey: z.string(),
  serverTimeMs: z.number().int().nonnegative(),
  /** Last `seq` the server has emitted, so a fresh client knows where it is. */
  lastSeq: seq,
  /**
   * The workspace this connection landed in.
   *
   * Here so a reconnecting tab — or one opening a link to someone else's
   * session — learns which workspace it is looking at without a REST round
   * trip, and can move its own switcher to match.
   */
  workspaceId: z.string().min(1).default('default'),
});

export const PongEventSchema = z.object({
  type: z.literal('pong'),
  serverTimeMs: z.number().int().nonnegative(),
});

/**
 * Typed error codes, never substring-sniffed. Deriving a code by searching
 * response *content* for "429" or "overloaded" means a model that legitimately
 * writes about rate limiting triggers a retry.
 */
export const ErrorCodeSchema = z.enum([
  'unauthorized',
  'bad_request',
  'not_found',
  'rate_limited',
  'provider_error',
  'tool_error',
  'config_invalid',
  /**
   * No provider and model are configured, so no turn can run.
   *
   * Distinct from `config_invalid`: nothing is wrong with the settings, they
   * are merely incomplete, and the client's response is to offer setup rather
   * than to report a fault. Every other route works in this state.
   */
  'not_configured',
  'session_busy',
  'internal',
]);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const ErrorEventSchema = z.object({
  type: z.literal('error'),
  code: ErrorCodeSchema,
  message: z.string(),
  retryable: z.boolean().default(false),
  /** Present when the error is scoped to a turn rather than the connection. */
  turnId: z.string().optional(),
});

export const MessageAckEventSchema = z.object({
  type: z.literal('message.ack'),
  seq,
  sessionKey: z.string().min(1),
  messageId: z.string().min(1),
  clientMessageId: z.string().optional(),
});

/** The session was mid-turn; the message runs when the current one finishes. */
export const MessageQueuedEventSchema = z.object({
  type: z.literal('message.queued'),
  seq,
  sessionKey: z.string().min(1),
  queueDepth: z.number().int().positive(),
});

export const TurnStartEventSchema = z.object({
  type: z.literal('turn.start'),
  seq,
  sessionKey: z.string().min(1),
  turnId: z.string().min(1),
  /**
   * The `seq` of the user message that started this turn.
   *
   * Also on `turn.end`, and reported *here* because a turn that fails never
   * reaches its end. Without it a failed turn had no storage address, so the
   * client could offer no way to re-run it — the failure line said "sending the
   * message again may work" and gave the reader nothing to press. Known by the
   * time this event is emitted, since the user message is appended first.
   */
  firstSeq: z.number().int().positive().optional(),
  /**
   * Which agent is running the turn.
   *
   * Reported per turn rather than looked up from the session, for the same
   * reason `model` and `provider` are: a session can be moved to another agent,
   * and a transcript that relabelled its history would be describing turns that
   * never happened.
   */
  agentId: z.string(),
  model: z.string(),
  provider: z.string(),
});

/** A chunk of the assistant's answer. Clients append; the server never resends. */
export const AssistantDeltaEventSchema = z.object({
  type: z.literal('assistant.delta'),
  seq,
  turnId: z.string().min(1),
  text: z.string(),
});

/** Reasoning/thinking stream, rendered in its own collapsible block. */
export const ReasoningDeltaEventSchema = z.object({
  type: z.literal('reasoning.delta'),
  seq,
  turnId: z.string().min(1),
  text: z.string(),
});

export const ToolCallEventSchema = z.object({
  type: z.literal('tool.call'),
  seq,
  turnId: z.string().min(1),
  callId: z.string().min(1),
  name: z.string().min(1),
  /** Parsed args when valid JSON; the raw string otherwise. */
  args: z.unknown(),
  risk: ToolRiskSchema,
});

/**
 * Liveness for a long-running tool, emitted every 15 s while it runs so the UI
 * can show that a slow `exec` hasn't hung.
 */
export const ToolProgressEventSchema = z.object({
  type: z.literal('tool.progress'),
  seq,
  turnId: z.string().min(1),
  callId: z.string().min(1),
  elapsedMs: z.number().int().nonnegative(),
  message: z.string().optional(),
});

export const ToolResultEventSchema = z.object({
  type: z.literal('tool.result'),
  seq,
  turnId: z.string().min(1),
  callId: z.string().min(1),
  ok: z.boolean(),
  content: z.string(),
  truncated: z.boolean().default(false),
  durationMs: z.number().int().nonnegative(),
});

/** Blocks the call until a matching `tool.approve` arrives or the policy times out. */
export const ToolApprovalRequestEventSchema = z.object({
  type: z.literal('tool.approvalRequest'),
  seq,
  turnId: z.string().min(1),
  callId: z.string().min(1),
  name: z.string().min(1),
  args: z.unknown(),
  risk: ToolRiskSchema,
  expiresAtMs: z.number().int().nonnegative(),
});

/**
 * Advisory notices. `prompt_injection` is the important one: detection is
 * **non-destructive**. Replacing a matched tool result with a warning banner
 * means reading this project's own security documentation silently wipes the
 * output and leaves the model hallucinating around the hole. The content passes
 * through intact, the nonce delimiters do the actual defending, and this event
 * raises a badge in the UI.
 */
export const NoticeKindSchema = z.enum([
  'prompt_injection',
  'degraded',
  'truncated_history',
  'provider_fallback',
  'approval_denied',
  /**
   * The session is bound to an agent that no longer resolves, so the turn ran
   * on `default` instead.
   *
   * A notice rather than an error because the turn *happened*: an agent id is
   * user-authored and can be deleted at any moment, and refusing every
   * conversation that named one would make a config edit break work that has
   * nothing to do with it. The binding is deliberately left alone, so
   * re-creating the agent silently restores every conversation waiting for it —
   * which is why this repeats each turn rather than firing once.
   *
   * Worth stating plainly, because the notice is the only thing that says it:
   * `default` may allow tools the departed agent did not, so this widens what
   * the turn could do rather than narrowing it.
   */
  'agent_fallback',
  /**
   * The model called a tool on an agent whose `toolsEnabled` is off.
   *
   * Separate from `approval_denied`, which it would otherwise be filed under,
   * because nothing was denied: the agent's permission map still says `allow`
   * and would run the call the moment this agent is pointed at a model that can
   * take a tool list. What happened is that the model invented a call it was
   * never offered — the request carried no `tools` at all — so the notice is
   * about a capability, not about a decision anyone made.
   */
  'tools_disabled',
]);
export type NoticeKind = z.infer<typeof NoticeKindSchema>;

export const NoticeEventSchema = z.object({
  type: z.literal('notice'),
  seq,
  kind: NoticeKindSchema,
  message: z.string(),
  turnId: z.string().optional(),
  callId: z.string().optional(),
});

export const TurnEndEventSchema = z.object({
  type: z.literal('turn.end'),
  seq,
  turnId: z.string().min(1),
  stopReason: StopReasonSchema,
  usage: UsageSchema.optional(),
  iterations: z.number().int().nonnegative().default(0),
  /** Wall time from the first append to this event — the divisor for tokens/s. */
  elapsedMs: z.number().int().nonnegative().optional(),
  /**
   * The `seq` of the user message that started this turn, and of the last
   * message it appended.
   *
   * `firstSeq` is what regenerate and edit address, so reporting it here is
   * what lets a message become editable the instant its turn ends — without it
   * the client would have to refetch history to learn the seq of something it
   * just watched being written.
   */
  firstSeq: z.number().int().positive().optional(),
  lastSeq: z.number().int().positive().optional(),
});

/**
 * Everything a turn emits, minus the `seq` the transport owns.
 *
 * Built by omitting `seq` from the schemas above rather than by restating them,
 * so a field added to `tool.call` is a field a nested `tool.call` carries with
 * no second edit. `subagent.event` itself is **not** a member: nesting deeper
 * than one level works by forwarding, not by wrapping a wrapper — see below.
 */
export const NestedAgentEventSchema = z.discriminatedUnion('type', [
  TurnStartEventSchema.omit({ seq: true }),
  AssistantDeltaEventSchema.omit({ seq: true }),
  ReasoningDeltaEventSchema.omit({ seq: true }),
  ToolCallEventSchema.omit({ seq: true }),
  ToolProgressEventSchema.omit({ seq: true }),
  ToolResultEventSchema.omit({ seq: true }),
  ToolApprovalRequestEventSchema.omit({ seq: true }),
  NoticeEventSchema.omit({ seq: true }),
  TurnEndEventSchema.omit({ seq: true }),
  // Already unsequenced — see `UNSEQUENCED_SERVER_EVENTS`.
  ErrorEventSchema,
]);
export type NestedAgentEvent = z.infer<typeof NestedAgentEventSchema>;

/**
 * One event from a subagent's own turn, addressed to the card it belongs under.
 *
 * A wrapper rather than an optional `parentCallId` on every event, and the
 * difference is which mistakes are possible. An optional field would let every
 * existing consumer keep compiling while quietly doing the wrong thing — the
 * channel projection would fold a subagent's `assistant.delta`s into the reply
 * it sends to a chat app, and nothing would say so. A new member of the union is
 * one case in an exhaustive switch, so every consumer is *made* to decide.
 *
 * Three fields carry the addressing, and each answers a question the others
 * cannot:
 *
 *  - **`turnId` is always the root turn**, in the transcript a person is
 *    reading. Rewritten on the way up at every level, so a client never has to
 *    know how deep it is to find the turn this belongs to.
 *  - **`parentSessionKey` + `parentCallId` are where it nests.** A `callId` is
 *    the model's and is only unique within one assistant message, so a parent
 *    and its subagent can mint the same one; composing it with the session that
 *    emitted it is unique at any depth and needs no id rewriting.
 *  - **`sessionKey` is the subagent's own session**, which is a real row. It is
 *    what a client fetches to show this run again after a reload, when the
 *    parent's stored history holds only the delegating tool result.
 *
 * Depth beyond one level works by **forwarding**: a loop that receives a
 * `subagent.event` from its own subagent re-emits it with `turnId` rewritten and
 * nothing else touched, because `parentSessionKey`/`parentCallId` already name
 * the grandchild's delegating call. That is why the payload is not recursive —
 * a `z.lazy` self-reference would have to survive `z.toJSONSchema` in both
 * directions for the OpenAPI document, and buys nothing here.
 */
export const SubagentEventSchema = z.object({
  type: z.literal('subagent.event'),
  seq,
  turnId: z.string().min(1),
  parentSessionKey: z.string().min(1),
  parentCallId: z.string().min(1),
  /** The subagent that produced the inner event. */
  agentId: z.string().min(1),
  /** Its label, so a card can name it without resolving the id. */
  label: z.string().default(''),
  sessionKey: z.string().min(1),
  /** 1 for a subagent of the session's own agent. */
  depth: z.number().int().positive(),
  event: NestedAgentEventSchema,
});

export const SessionStatusEventSchema = z.object({
  type: z.literal('session.status'),
  seq,
  sessionKey: z.string().min(1),
  busy: z.boolean(),
  queueDepth: z.number().int().nonnegative().default(0),
  /** The session's workspace, restated on every switch. */
  workspaceId: z.string().min(1).default('default'),
  turnId: z.string().optional(),
});

export const SessionResetEventSchema = z.object({
  type: z.literal('session.reset'),
  seq,
  sessionKey: z.string().min(1),
});

/**
 * Replayed history after `session.resume`, so a reconnecting client can restore
 * completed messages before the live deltas resume.
 */
export const SessionReplayEventSchema = z.object({
  type: z.literal('session.replay'),
  seq,
  sessionKey: z.string().min(1),
  messages: z.array(StoredMessageSchema),
  /** False when `lastSeq` fell outside the ring buffer and history was trimmed. */
  complete: z.boolean().default(true),
});

/**
 * A suffix of the conversation was dropped — by a regenerate, an edit, or a
 * truncation from another client.
 *
 * Carries the stored tail rather than only the cut point, so a client rebuilds
 * from one frame instead of racing a refetch against the turn that is about to
 * start. Sequenced, so it reaches every attached tab and enters the replay
 * ring: a second window watching the same conversation corrects itself with no
 * code of its own.
 */
export const SessionTruncatedEventSchema = z.object({
  type: z.literal('session.truncated'),
  seq,
  sessionKey: z.string().min(1),
  /** Everything after this `seq` is gone. */
  upToSeq: z.number().int().nonnegative(),
  messages: z.array(StoredMessageSchema),
});

export const NotificationEventSchema = z.object({
  type: z.literal('notification'),
  seq,
  id: z.string().min(1),
  title: z.string(),
  body: z.string(),
  level: z.enum(['info', 'success', 'warning', 'error']).default('info'),
  createdAtMs: z.number().int().nonnegative(),
  sessionKey: z.string().optional(),
  /** Set when raised by an automation run. */
  jobId: z.string().optional(),
});

export const TranscribeResultEventSchema = z.object({
  type: z.literal('transcribe.result'),
  seq,
  text: z.string(),
});

/** Tool list changed — an MCP server reconnected, or a plugin loaded/unloaded. */
export const ToolsChangedEventSchema = z.object({
  type: z.literal('tools.changed'),
  seq,
  tools: z.array(ToolDefinitionSchema),
});

/** Mid-turn steering echoed back so every tab shows what was injected. */
export const SteerEventSchema = z.object({
  type: z.literal('steer'),
  seq,
  sessionKey: z.string().min(1),
  content: z.string(),
});

export const ServerMessageSchema = z.discriminatedUnion('type', [
  ConnectedEventSchema,
  PongEventSchema,
  ErrorEventSchema,
  MessageAckEventSchema,
  MessageQueuedEventSchema,
  TurnStartEventSchema,
  AssistantDeltaEventSchema,
  ReasoningDeltaEventSchema,
  ToolCallEventSchema,
  ToolProgressEventSchema,
  ToolResultEventSchema,
  ToolApprovalRequestEventSchema,
  NoticeEventSchema,
  TurnEndEventSchema,
  SubagentEventSchema,
  SessionStatusEventSchema,
  SessionResetEventSchema,
  SessionReplayEventSchema,
  SessionTruncatedEventSchema,
  NotificationEventSchema,
  TranscribeResultEventSchema,
  ToolsChangedEventSchema,
  SteerEventSchema,
]);
export type ServerMessage = z.infer<typeof ServerMessageSchema>;
export type ServerMessageType = ServerMessage['type'];

/** Server events that are not part of a session's replayable history. */
export const UNSEQUENCED_SERVER_EVENTS = [
  'connected',
  'pong',
  'error',
] as const;

export type UnsequencedServerEventType =
  (typeof UNSEQUENCED_SERVER_EVENTS)[number];

/**
 * Narrows to the events a replay buffer stores. Used by the WS hub to decide
 * what to retain, and by the reconnect tests to assert nothing sequenced is
 * dropped.
 */
export function isSequencedServerMessage(
  message: ServerMessage,
): message is Extract<ServerMessage, { seq: number }> {
  return !(UNSEQUENCED_SERVER_EVENTS as readonly string[]).includes(
    message.type,
  );
}

/**
 * Re-exported so channels can build content parts without importing two
 * modules. `FilePartSchema` is the one a channel reaches for now: an
 * attachment is a workspace file, and `ImagePartSchema` survives for the
 * request-time form that `materialiseAttachments` produces.
 */
export { FilePartSchema, ImagePartSchema };
