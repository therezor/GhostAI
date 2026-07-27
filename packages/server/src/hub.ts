/**
 * `SessionHub` — one session, many connections, one turn at a time.
 *
 * `AgentLoop` runs a turn. It does not know that two browser tabs are open on
 * the same conversation, that the user sent a second message while the first
 * was still running, or that a tab reloaded halfway through a tool call. Those
 * are transport problems, and this is where they are solved — once, for every
 * transport, because a channel that bridges through the hub inherits the same
 * queueing, the same approval gate and the same event stream as the web UI.
 *
 * The design in five decisions:
 *
 *  - **A session runs one turn at a time, and the rest queue.** `AgentLoop` will
 *    happily run two turns on one session key, and the result is two provider
 *    requests interleaving their writes into one history — which produces a
 *    transcript no model can read and no user can explain. The queue is FIFO,
 *    bounded, and the depth is reported so the UI can say what it is doing.
 *  - **Fanout belongs here, not to `MessageBus`.** That queue is
 *    competing-consumer by design and explicitly does not broadcast; handing one
 *    session's events to it would deliver each event to exactly one of three
 *    open tabs.
 *  - **Sequenced means broadcast.** Every event carrying a `seq` goes to every
 *    subscriber of that session and into the replay ring. There is one `seq`
 *    stream per session and it means the same thing on every connection —
 *    otherwise a client's `lastSeq` addresses a different event on reconnect
 *    than it did on the connection that produced it. `connected`, `pong` and
 *    `error` carry no `seq` and are the only frames sent to one client.
 *  - **`AgentEvent` + `seq` *is* `ServerMessage`.** Forwarding a turn is a
 *    counter and a broadcast, not a mapping table. `events.test.ts` in
 *    `@ghostai/agent` holds that property from the other side.
 *  - **Nothing an inbound frame contains can throw out of here.** Every frame is
 *    `safeParse`d and every failure is an `error` event on the socket that sent
 *    it. A hub that throws on a malformed frame is a hub a client can kill.
 *
 * The turn's `AbortSignal` is the one from Step 10: `turn.stop` aborts the
 * controller, and the same signal reaches the provider fetch, the running tool
 * and its child process. There is no second cancellation path.
 */

import { randomUUID } from 'node:crypto';

import type { AgentEvent, TurnInput, TurnResult } from '@ghostai/agent';
import {
  isAbortError,
  silentLogger,
  systemClock,
  textPart,
  toStoredMessage,
  type Clock,
  type Logger,
  type SessionStore,
} from '@ghostai/core';
import {
  ClientMessageSchema,
  PROTOCOL_VERSION,
  type Attachment,
  type ClientMessage,
  type Config,
  type ContentPart,
  type ErrorCode,
  type ServerMessage,
} from '@ghostai/protocol';

import type { HubApprovalGate } from './approvals.js';
import { resolveError } from './errors.js';
import { ReplayBuffer, type SequencedServerMessage } from './replay.js';

/**
 * How many messages one session may hold while a turn runs.
 *
 * A bound rather than a courtesy: the queue fills from a socket and drains from
 * a loop that may be blocked in a slow tool. Past the cap the hub answers
 * `session_busy` — the one error code in the protocol that exists for exactly
 * this, and the one honest answer to "I cannot hold any more of these".
 */
export const DEFAULT_MAX_QUEUE_DEPTH = 8;

/**
 * How many sessions keep their replay ring in memory.
 *
 * Idle sessions are evicted oldest-first past this, and a client that reconnects
 * to an evicted session lands on the same path as one that fell out of the ring:
 * `complete: false`, and a rebuild from storage. A session with a client
 * attached, a running turn or a queue is never evicted — the cap yields to
 * anything live rather than dropping work to satisfy a number.
 */
export const DEFAULT_MAX_SESSIONS = 64;

/**
 * Stored messages returned when a replay could not cover the gap.
 *
 * Enough to rebuild a conversation a user is actually looking at, bounded
 * because this runs on a socket rather than on a paginated route. `complete:
 * false` still says "refetch from REST" — this is what saves the round trip in
 * the common case, not a replacement for the route.
 */
export const RESUME_MESSAGE_LIMIT = 200;

/**
 * Idempotency keys remembered per session.
 *
 * A client retrying after a dropped socket resends the last message or two, not
 * the last hundred. The bound is what stops a long-lived session accumulating
 * one entry per message it has ever received.
 */
const MAX_TRACKED_CLIENT_MESSAGE_IDS = 64;

/**
 * What the hub needs from an agent loop.
 *
 * A structural interface rather than `AgentLoop` itself: the hub uses two of its
 * methods, and stating which two means a test drives it with a scripted
 * generator instead of a provider, a jail, a registry and a store. `AgentLoop`
 * satisfies it as written.
 */
export interface TurnRunner {
  run(input: TurnInput): AsyncGenerator<AgentEvent, TurnResult>;
  steer(sessionKey: string, content: string): void;
}

/** Distributes `Omit` over the union, which a bare `Omit` would collapse. */
type Unsequenced<T> = T extends unknown ? Omit<T, 'seq'> : never;

/** A sequenced event as the hub builds it, before the counter is stamped on. */
type HubEvent = Unsequenced<SequencedServerMessage>;

export interface ConnectOptions {
  /**
   * Delivers one frame.
   *
   * The hub never serialises — a WebSocket wants a JSON string, a test wants
   * the object, and an in-process channel wants neither. A throw here is read
   * as a dead connection and detaches it.
   */
  readonly send: (message: ServerMessage) => void;
  /** The session this connection starts on. A fresh key is minted when absent. */
  readonly sessionKey?: string;
  /** Recorded as the session's origin, so a bridged channel is not labelled `web`. */
  readonly channel?: string;
  /** Default profile for turns from this connection; a frame may override it. */
  readonly profileId?: string;
}

export interface HubClient {
  readonly id: string;
  /** The session this connection is watching. Moves on `session.switch`. */
  readonly sessionKey: string;
  /** Handles one inbound frame: a JSON string, bytes, or an already-parsed value. */
  receive(frame: unknown): void;
  /** Detaches. Idempotent, so a socket's `close` and `error` can both call it. */
  close(): void;
}

export interface SessionHubOptions {
  /** Read for `server.replayBufferSize` when a session is first seen. */
  readonly config: Config;
  /**
   * The loop to start the next turn on, read once per turn.
   *
   * A function rather than an instance because `reconfigure` replaces the loop:
   * a settings save has to move the *next* turn onto the new provider, and the
   * running one has to keep the loop it started on — its request is in flight
   * and its tool definitions are already in the model's context.
   */
  readonly loop: () => TurnRunner;
  /** Read only to rebuild a transcript a replay could not cover. */
  readonly store: SessionStore;
  /**
   * Where `tool.approve` lands.
   *
   * Constructed by the caller rather than here, because the runtime needs it at
   * construction and the hub needs the runtime's loop and store. Building the
   * gate first is what unties that knot.
   */
  readonly approvals: HubApprovalGate;
  readonly clock?: Clock;
  readonly logger?: Logger;
  /** Turn and connection ids. Injected so a test asserts on stable values. */
  readonly newId?: () => string;
  readonly maxQueueDepth?: number;
  readonly maxSessions?: number;
}

/** A connection, as the hub tracks it. `sessionKey` is mutable; the rest is not. */
interface Connection {
  readonly id: string;
  readonly send: (message: ServerMessage) => void;
  readonly channel: string;
  readonly profileId: string | undefined;
  sessionKey: string;
  closed: boolean;
}

/** A message accepted but not yet started. */
interface QueuedTurn {
  /** Acked to the client, and the `turnId` the turn will run under. */
  readonly id: string;
  readonly content: string | readonly ContentPart[];
  readonly profileId: string | undefined;
  readonly channel: string;
}

interface RunningTurn {
  readonly turnId: string;
  readonly controller: AbortController;
  /** The loop this turn started on, so a steer reaches the loop that is running it. */
  readonly runner: TurnRunner;
}

interface SessionState {
  readonly key: string;
  /** Last `seq` emitted. Monotonic for the session's lifetime in this process. */
  seq: number;
  readonly ring: ReplayBuffer;
  readonly clients: Set<Connection>;
  readonly queue: QueuedTurn[];
  running: RunningTurn | undefined;
  /** `clientMessageId` → the id it was acked with, for retry after a dropped socket. */
  readonly acked: Map<string, string>;
  touchedAtMs: number;
}

/** Bytes from a socket, a JSON string, or a value someone already parsed. */
function decodeFrame(frame: unknown): unknown {
  if (frame instanceof Uint8Array) return new TextDecoder().decode(frame);
  return frame;
}

/**
 * What the user sent, as the loop wants it.
 *
 * A plain string when there is nothing but text — the common case, and the one
 * `userMessage` is cheapest on. Non-image attachments become a text line rather
 * than being dropped: the model cannot see the bytes, but knowing a file was
 * attached is what lets it reach for a tool and read it.
 */
function toContent(
  text: string,
  attachments: readonly Attachment[],
): string | readonly ContentPart[] {
  if (attachments.length === 0) return text;

  const parts: ContentPart[] = [];
  if (text !== '') parts.push(textPart(text));
  for (const attachment of attachments) {
    if (attachment.type.startsWith('image/')) {
      parts.push({ type: 'image', mimeType: attachment.type, url: attachment.url });
    } else {
      parts.push(
        textPart(`[Attachment: ${attachment.name ?? attachment.url} (${attachment.type})]`),
      );
    }
  }
  return parts;
}

/** The first schema complaint, short enough to put on a wire. */
function describeParseFailure(issues: readonly { path: PropertyKey[]; message: string }[]): string {
  const first = issues[0];
  if (first === undefined) return 'Frame did not match any client message';
  const path = first.path.map(String).join('.');
  return path === '' ? first.message : `${path}: ${first.message}`;
}

export class SessionHub {
  readonly #config: Config;
  readonly #loop: () => TurnRunner;
  readonly #store: SessionStore;
  readonly #approvals: HubApprovalGate;
  readonly #clock: Clock;
  readonly #logger: Logger;
  readonly #newId: () => string;
  readonly #maxQueueDepth: number;
  readonly #maxSessions: number;
  readonly #sessions = new Map<string, SessionState>();

  constructor(options: SessionHubOptions) {
    this.#config = options.config;
    this.#loop = options.loop;
    this.#store = options.store;
    this.#approvals = options.approvals;
    this.#clock = options.clock ?? systemClock;
    this.#logger = options.logger ?? silentLogger;
    this.#newId = options.newId ?? randomUUID;
    this.#maxQueueDepth = options.maxQueueDepth ?? DEFAULT_MAX_QUEUE_DEPTH;
    this.#maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
  }

  /** Sessions holding state in this process. Includes idle ones, for their rings. */
  get sessionCount(): number {
    return this.#sessions.size;
  }

  /** Whether a turn is running on this session. */
  busy(sessionKey: string): boolean {
    return this.#sessions.get(sessionKey)?.running !== undefined;
  }

  /**
   * Attaches a connection and greets it.
   *
   * The `connected` frame carries `lastSeq` so a fresh client knows where the
   * session is before it has seen anything, and a reconnecting one can tell
   * immediately whether it missed anything at all.
   */
  connect(options: ConnectOptions): HubClient {
    const connection: Connection = {
      id: this.#newId(),
      send: options.send,
      channel: options.channel ?? 'web',
      profileId: options.profileId,
      sessionKey: options.sessionKey ?? this.#newId(),
      closed: false,
    };

    const state = this.#session(connection.sessionKey);
    state.clients.add(connection);
    this.#logger.debug(
      { connectionId: connection.id, sessionKey: connection.sessionKey },
      'hub connection opened',
    );

    this.#deliver(connection, {
      type: 'connected',
      protocolVersion: PROTOCOL_VERSION,
      sessionKey: connection.sessionKey,
      serverTimeMs: this.#clock.now(),
      lastSeq: state.seq,
    });

    return {
      id: connection.id,
      get sessionKey(): string {
        return connection.sessionKey;
      },
      receive: (frame: unknown): void => {
        this.#receive(connection, frame);
      },
      close: (): void => {
        this.#disconnect(connection);
      },
    };
  }

  /**
   * Stops every turn and drops every session.
   *
   * Sockets are not closed here — the transport that opened them owns that, and
   * a hub that closed them would race the server's own shutdown.
   */
  close(): void {
    for (const state of this.#sessions.values()) {
      state.running?.controller.abort();
      state.queue.length = 0;
      this.#approvals.clearSession(state.key);
    }
    this.#sessions.clear();
  }

  // -------------------------------------------------------------------------
  // Inbound
  // -------------------------------------------------------------------------

  #receive(connection: Connection, frame: unknown): void {
    if (connection.closed) return;

    const decoded = decodeFrame(frame);
    let value: unknown = decoded;
    if (typeof decoded === 'string') {
      try {
        value = JSON.parse(decoded);
      } catch {
        this.#error(connection, 'bad_request', 'Frame is not valid JSON');
        return;
      }
    }

    const parsed = ClientMessageSchema.safeParse(value);
    if (!parsed.success) {
      this.#error(connection, 'bad_request', describeParseFailure(parsed.error.issues));
      return;
    }

    this.#dispatch(connection, parsed.data);
  }

  /** Exhaustive on purpose: a client message added without a handler is a type error. */
  #dispatch(connection: Connection, message: ClientMessage): void {
    switch (message.type) {
      case 'ping':
        this.#deliver(connection, { type: 'pong', serverTimeMs: this.#clock.now() });
        return;

      case 'user.message':
        this.#submit(connection, message);
        return;

      case 'turn.stop': {
        const state = this.#sessions.get(message.sessionKey);
        // A stop with nothing running is the user clicking as the turn ends.
        // Answering it with an error would be reporting a race as a mistake.
        if (state?.running === undefined) return;
        this.#logger.info(
          { sessionKey: state.key, turnId: state.running.turnId },
          'turn stopped by client',
        );
        state.running.controller.abort();
        return;
      }

      case 'turn.steer': {
        const state = this.#sessions.get(message.sessionKey);
        if (state?.running === undefined) {
          this.#error(connection, 'bad_request', 'No turn is running on this session to steer');
          return;
        }
        // The loop the turn started on, not the current one: after a
        // reconfigure those differ, and the queue the running loop drains is
        // the only one it will ever read.
        state.running.runner.steer(state.key, message.content);
        this.#emit(state, {
          type: 'steer',
          sessionKey: state.key,
          content: message.content,
        });
        return;
      }

      case 'session.new':
        this.#move(connection, message.sessionKey ?? this.#newId());
        return;

      case 'session.switch':
        this.#move(connection, message.sessionKey);
        return;

      case 'session.resume':
        this.#resume(connection, message.sessionKey, message.lastSeq);
        return;

      case 'tool.approve': {
        const answered = this.#approvals.resolve(message.callId, message.approved, message.scope);
        // An unanswered `callId` is the normal two-tab race, or an answer to a
        // call whose turn was stopped. Neither is worth an error frame.
        if (!answered) {
          this.#logger.debug({ callId: message.callId }, 'approval answered too late');
        }
        return;
      }

      case 'audio.transcribe':
        this.#error(
          connection,
          'config_invalid',
          'Audio transcription is not configured on this server',
        );
        return;
    }
  }

  /**
   * Accepts a user message: ack, queue, and start it if nothing is running.
   *
   * The ack carries the id the turn will run under. It is deliberately not the
   * stored message's row id — a queued message has not been persisted yet, and
   * an ack that waited for persistence would be an ack that waits for the turn
   * in front of it to finish, which is the one moment the client needs it.
   */
  #submit(connection: Connection, message: Extract<ClientMessage, { type: 'user.message' }>): void {
    const state = this.#session(message.sessionKey);
    const clientMessageId = message.clientMessageId;

    if (clientMessageId !== undefined) {
      const known = state.acked.get(clientMessageId);
      if (known !== undefined) {
        // A retry after a dropped socket. It is acked again, with the id the
        // first attempt got and no second turn queued — the ack is idempotent
        // because the client keys on `messageId`, and re-acking is what tells a
        // reconnecting tab its message did land.
        this.#logger.debug(
          { sessionKey: state.key, clientMessageId },
          'duplicate client message id, not re-queued',
        );
        this.#emit(state, {
          type: 'message.ack',
          sessionKey: state.key,
          messageId: known,
          clientMessageId,
        });
        return;
      }
    }

    if (message.content === '' && message.attachments.length === 0) {
      this.#error(connection, 'bad_request', 'Message is empty');
      return;
    }

    if (state.queue.length >= this.#maxQueueDepth) {
      this.#error(
        connection,
        'session_busy',
        `This session already has ${String(state.queue.length)} messages waiting. Let it catch up.`,
        true,
      );
      return;
    }

    const id = this.#newId();
    if (clientMessageId !== undefined) this.#remember(state, clientMessageId, id);

    state.queue.push({
      id,
      content: toContent(message.content, message.attachments),
      profileId: message.profileId ?? connection.profileId,
      channel: connection.channel,
    });

    this.#emit(state, {
      type: 'message.ack',
      sessionKey: state.key,
      messageId: id,
      ...(clientMessageId === undefined ? {} : { clientMessageId }),
    });

    if (state.running !== undefined) {
      this.#emit(state, {
        type: 'message.queued',
        sessionKey: state.key,
        queueDepth: state.queue.length,
      });
      this.#status(state);
      return;
    }

    this.#drain(state);
  }

  #remember(state: SessionState, clientMessageId: string, messageId: string): void {
    state.acked.set(clientMessageId, messageId);
    for (const oldest of state.acked.keys()) {
      if (state.acked.size <= MAX_TRACKED_CLIENT_MESSAGE_IDS) break;
      state.acked.delete(oldest);
    }
  }

  // -------------------------------------------------------------------------
  // Turns
  // -------------------------------------------------------------------------

  /** Starts the next queued turn if the session is free. Returns whether it did. */
  #drain(state: SessionState): boolean {
    if (state.running !== undefined) return false;
    const next = state.queue.shift();
    if (next === undefined) return false;
    // The turn is set up synchronously before the first `await`, so `running` is
    // populated by the time this returns.
    void this.#runTurn(state, next);
    return true;
  }

  /**
   * Runs one turn to completion. Never rejects.
   *
   * A turn this hub started is a turn this hub closes: if the loop throws
   * instead of yielding `turn.end`, the client is holding an open turn it will
   * render as a spinner forever, so the failure path emits both the error and
   * the close.
   */
  async #runTurn(state: SessionState, turn: QueuedTurn): Promise<void> {
    const controller = new AbortController();
    try {
      const runner = this.#loop();
      state.running = { turnId: turn.id, controller, runner };
      state.touchedAtMs = this.#clock.now();
      this.#status(state);

      const events = runner.run({
        sessionKey: state.key,
        content: turn.content,
        signal: controller.signal,
        channel: turn.channel,
        turnId: turn.id,
        ...(turn.profileId === undefined ? {} : { profileId: turn.profileId }),
      });

      for await (const event of events) this.#forward(state, event);
    } catch (error) {
      this.#failTurn(state, turn.id, error);
    } finally {
      state.running = undefined;
      state.touchedAtMs = this.#clock.now();
      // The next turn's own `turn.start` and status say the session is busy
      // again; announcing idle first would make a queue look like a gap.
      if (!this.#drain(state)) this.#status(state);
    }
  }

  #failTurn(state: SessionState, turnId: string, error: unknown): void {
    if (isAbortError(error)) {
      // The loop normally yields `turn.end` with `aborted` itself; a throw here
      // means it unwound before it could, and the turn still has to close.
      this.#emit(state, { type: 'turn.end', turnId, stopReason: 'aborted', iterations: 0 });
      return;
    }

    // The same mapping the REST error handler uses, so one thrown value cannot
    // be a `provider_error` on a socket and a 500 with a different code on a
    // route. It also decides what is safe to say: an unexpected throw's message
    // was written for a stack trace, not for whoever is connected.
    const resolved = resolveError(error);
    this.#logger.error({ sessionKey: state.key, turnId, err: resolved.cause }, 'turn failed');
    this.#broadcast(state, {
      type: 'error',
      code: resolved.code,
      message: resolved.body.error.message,
      retryable: resolved.cause.retryable,
      turnId,
    });
    this.#emit(state, { type: 'turn.end', turnId, stopReason: 'error', iterations: 0 });
  }

  /**
   * One turn event onto the wire.
   *
   * `error` is the only event the protocol leaves unsequenced — it is scoped to
   * a connection or a turn rather than to a session's replayable history — so it
   * broadcasts without a counter and never enters the ring.
   */
  #forward(state: SessionState, event: AgentEvent): void {
    if (event.type === 'error') {
      this.#broadcast(state, event);
      return;
    }
    this.#emit(state, event);
  }

  // -------------------------------------------------------------------------
  // Sessions and replay
  // -------------------------------------------------------------------------

  #session(key: string): SessionState {
    const existing = this.#sessions.get(key);
    if (existing !== undefined) {
      existing.touchedAtMs = this.#clock.now();
      return existing;
    }

    const state: SessionState = {
      key,
      seq: 0,
      ring: new ReplayBuffer(this.#config.server.replayBufferSize),
      clients: new Set(),
      queue: [],
      running: undefined,
      acked: new Map(),
      touchedAtMs: this.#clock.now(),
    };
    this.#sessions.set(key, state);
    // Excluded from its own eviction: nothing has attached to it yet, so by
    // every measure of "idle" it is the best victim in the map — and evicting
    // the session a client is in the middle of opening would drop the state
    // that call is about to use.
    this.#evict(key);
    return state;
  }

  /** Drops the oldest idle sessions until the cap holds, or nothing is idle. */
  #evict(exclude: string): void {
    while (this.#sessions.size > this.#maxSessions) {
      let victim: SessionState | undefined;
      for (const state of this.#sessions.values()) {
        if (state.key === exclude) continue;
        const idle =
          state.clients.size === 0 && state.running === undefined && state.queue.length === 0;
        if (!idle) continue;
        if (victim === undefined || state.touchedAtMs < victim.touchedAtMs) victim = state;
      }
      if (victim === undefined) return;
      this.#sessions.delete(victim.key);
      this.#approvals.clearSession(victim.key);
      this.#logger.debug({ sessionKey: victim.key }, 'evicted idle session state');
    }
  }

  /** Moves a connection onto another session and reports where it landed. */
  #move(connection: Connection, sessionKey: string): SessionState {
    const target = this.#session(sessionKey);
    if (connection.sessionKey !== sessionKey) {
      this.#sessions.get(connection.sessionKey)?.clients.delete(connection);
      connection.sessionKey = sessionKey;
      target.clients.add(connection);
    }
    this.#status(target);
    return target;
  }

  /**
   * Rebuilds a reconnecting client.
   *
   * Two answers, and the flag is which one it got. Covered by the ring: the
   * events after `lastSeq` verbatim, which is strictly more than storage holds —
   * it includes the deltas of a turn still running. Past the ring: the stored
   * tail instead, `complete: false`, and the client refetches the rest from
   * REST. Never both, because a stored assistant message and the deltas that
   * produced it are the same text twice.
   */
  #resume(connection: Connection, sessionKey: string, lastSeq: number): void {
    const state = this.#move(connection, sessionKey);
    const slice = state.ring.after(lastSeq);

    this.#emit(state, {
      type: 'session.replay',
      sessionKey: state.key,
      messages: slice.complete
        ? []
        : this.#store
            .messages(state.key, { limit: RESUME_MESSAGE_LIMIT, fromEnd: true })
            .map(toStoredMessage),
      complete: slice.complete,
    });

    if (!slice.complete) {
      this.#logger.info(
        { sessionKey: state.key, lastSeq, ringSize: state.ring.size },
        'resume fell outside the replay buffer',
      );
      return;
    }

    // Re-sends, not new events: the same frames with the same `seq`, to the one
    // connection that missed them. They therefore arrive *after* an envelope
    // carrying a higher number, which is why a client tracks the maximum `seq`
    // it has seen rather than the last one it was handed.
    for (const message of slice.messages) this.#deliver(connection, message);
  }

  #status(state: SessionState): void {
    this.#emit(state, {
      type: 'session.status',
      sessionKey: state.key,
      busy: state.running !== undefined,
      queueDepth: state.queue.length,
      ...(state.running === undefined ? {} : { turnId: state.running.turnId }),
    });
  }

  // -------------------------------------------------------------------------
  // Outbound
  // -------------------------------------------------------------------------

  #emit(state: SessionState, event: HubEvent): void {
    state.seq += 1;
    // `AgentEvent` and every hub-originated event above is a `ServerMessage`
    // minus its `seq`; stamping the counter completes it, and the compiler
    // agrees without a cast. `hub.test.ts` parses every frame this hub emits
    // through `ServerMessageSchema`, so the runtime shape is checked too.
    const message: SequencedServerMessage = { ...event, seq: state.seq };
    state.ring.push(message);
    this.#broadcast(state, message);
  }

  /** A copy of the set, because a failing send detaches the connection mid-loop. */
  #broadcast(state: SessionState, message: ServerMessage): void {
    for (const connection of [...state.clients]) this.#deliver(connection, message);
  }

  #deliver(connection: Connection, message: ServerMessage): void {
    if (connection.closed) return;
    try {
      connection.send(message);
    } catch (error) {
      this.#logger.warn(
        { connectionId: connection.id, err: error, type: message.type },
        'connection send failed, detaching',
      );
      this.#disconnect(connection);
    }
  }

  #error(connection: Connection, code: ErrorCode, message: string, retryable = false): void {
    this.#deliver(connection, { type: 'error', code, message, retryable });
  }

  #disconnect(connection: Connection): void {
    if (connection.closed) return;
    connection.closed = true;
    this.#sessions.get(connection.sessionKey)?.clients.delete(connection);
    this.#logger.debug(
      { connectionId: connection.id, sessionKey: connection.sessionKey },
      'hub connection closed',
    );
    // The session state stays: the case a replay buffer exists for is a tab that
    // reloads, which is a disconnect followed by a reconnect a second later.
    // `#evict` is what eventually reclaims it.
  }
}
