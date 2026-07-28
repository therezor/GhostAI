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

import { ApprovalScopeSchema, ToolDefinitionSchema, ToolRiskSchema } from './tools.js';
import { ImagePartSchema, StopReasonSchema, StoredMessageSchema, UsageSchema } from './messages.js';

/** Version of the wire protocol. Bumped on any breaking envelope change. */
export const PROTOCOL_VERSION = 1 as const;
export type ProtocolVersion = typeof PROTOCOL_VERSION;

// ---------------------------------------------------------------------------
// Client → server
// ---------------------------------------------------------------------------

/** An upload the user attached to a message. */
export const AttachmentSchema = z.object({
  /** MIME type. Anything `image/*` becomes an `ImagePart`. */
  type: z.string().min(1),
  /** Signed URL or workspace-relative path returned by the upload endpoint. */
  url: z.string().min(1),
  name: z.string().optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
});
export type Attachment = z.infer<typeof AttachmentSchema>;

export const PingMessageSchema = z.object({
  type: z.literal('ping'),
});

export const UserMessageRequestSchema = z.object({
  type: z.literal('user.message'),
  sessionKey: z.string().min(1),
  content: z.string(),
  attachments: z.array(AttachmentSchema).default([]),
  profileId: z.string().optional(),
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
  profileId: z.string().optional(),
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

export const ClientMessageSchema = z.discriminatedUnion('type', [
  PingMessageSchema,
  UserMessageRequestSchema,
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
  SessionStatusEventSchema,
  SessionResetEventSchema,
  SessionReplayEventSchema,
  NotificationEventSchema,
  TranscribeResultEventSchema,
  ToolsChangedEventSchema,
  SteerEventSchema,
]);
export type ServerMessage = z.infer<typeof ServerMessageSchema>;
export type ServerMessageType = ServerMessage['type'];

/** Server events that are not part of a session's replayable history. */
export const UNSEQUENCED_SERVER_EVENTS = ['connected', 'pong', 'error'] as const;

export type UnsequencedServerEventType = (typeof UNSEQUENCED_SERVER_EVENTS)[number];

/**
 * Narrows to the events a replay buffer stores. Used by the WS hub to decide
 * what to retain, and by the reconnect tests to assert nothing sequenced is
 * dropped.
 */
export function isSequencedServerMessage(
  message: ServerMessage,
): message is Extract<ServerMessage, { seq: number }> {
  return !(UNSEQUENCED_SERVER_EVENTS as readonly string[]).includes(message.type);
}

/** Re-exported so channels can build image parts without importing two modules. */
export { ImagePartSchema };
