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

import type { AgentEvent, TurnInput, TurnResult } from '@ghostai/agent';
import {
  DEFAULT_WORKSPACE_ID,
  filePart,
  isAbortError,
  silentLogger,
  systemClock,
  textOf,
  textPart,
  toStoredMessage,
  type Clock,
  type Logger,
  type SessionStore,
  type StoredMessageRecord,
} from '@ghostai/core';
import {
  ClientMessageSchema,
  PROTOCOL_VERSION,
  newUuid,
  parseMentions,
  type Attachment,
  type ClientMessage,
  type Config,
  type ContentPart,
  type ErrorCode,
  type ParsedMentions,
  type ServerMessage,
} from '@ghostai/protocol';

import { agentForTurn } from './agent-binding.js';
import type { HubApprovalGate } from './approvals.js';
import { resolveError } from './errors.js';
import type { AgentMissReason } from './runtime.js';
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
 * What an install with no model says, in the one place that says it.
 *
 * Two paths report it: a turn that reached the runner and found none, and a
 * regenerate that checks *before* truncating. Both must say the same thing, or
 * the same install describes itself two ways.
 */
export const NO_MODEL_MESSAGE: string =
  'No model is configured. Add a provider and choose a model in Settings, ' +
  'or run `ghost init` from a terminal.';

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
  /** Default agent for turns from this connection; a frame may override it. */
  readonly agentId?: string;
  /**
   * There is no human on the other end of this one.
   *
   * The scheduler drives its turns *through* the hub — deliberately, because
   * the hub is the only thing that serialises a session — so a scheduled run
   * has a connection attached to it like any browser tab. It is not a watcher
   * though: it forwards events into a collector and has no way to answer
   * anything. Counting it as one made `watchers()` return 1 for every
   * unattended run, which is precisely the case the approval gate uses it to
   * detect, so the notification it exists to raise was never raised.
   *
   * A flag rather than a channel check: `telegram` is also not a browser and
   * *can* answer an approval, so "which transport" is the wrong question. The
   * right one is whether anybody is there, and only the caller knows.
   */
  readonly unattended?: boolean;
  /**
   * The workspace a session *created* by this connection lands in.
   *
   * Never applied to a session that already exists — the loop reads the stored
   * row and ignores this. A tab connects before it has sent anything, and the
   * store holds no row until the first message lands, so this is what carries
   * the user's chosen workspace across that gap.
   */
  readonly workspaceId?: string;
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
   * The loop to start the next turn on, resolved once per turn.
   *
   * A function rather than an instance for two reasons. `reconfigure` replaces
   * the loops: a settings save has to move the *next* turn onto the new
   * provider, while the running one keeps the loop it started on — its request
   * is in flight and its tool definitions are already in the model's context.
   * And a turn names an agent, so which loop runs it is a per-turn question:
   * one loop per agent, resolved here rather than switched inside the loop.
   *
   * It may throw for an id that names no runnable agent. The hub reports that
   * on the one frame that asked for it rather than failing the connection.
   *
   * `null` when no provider and model are configured. The socket stays open and
   * every other frame keeps working — only a turn is refused, with
   * `not_configured`, because the client's answer to that is to offer setup
   * rather than to reconnect.
   */
  readonly loop: (agentId: string | undefined) => TurnRunner | null;
  /**
   * Which agent an id actually names, and whether it is the one asked for.
   *
   * A function rather than a snapshot, for the reason `loop` is one: a settings
   * save has to move the *next* turn, and an agent deleted a moment ago must
   * not still resolve because the hub was built before it went.
   *
   * Every id reaching this came from somewhere that could not check it — a
   * session row written months ago, a frame from a tab that has been open since
   * before the delete, a channel's configured default. Refusing them would make
   * one settings edit stop conversations that have nothing to do with it, so a
   * miss falls back and is *reported* rather than refused.
   */
  readonly resolveAgentId: (agentId: string | undefined) => {
    readonly agentId: string;
    readonly miss: AgentMissReason | undefined;
  };
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
  /** Mutable, like `workspaceId`: a `session.new` naming an agent re-points it. */
  agentId: string | undefined;
  /** Mutable: a `session.new` naming a workspace re-points the connection. */
  workspaceId: string | undefined;
  sessionKey: string;
  closed: boolean;
  /** No human on the other end — see `ConnectOptions.unattended`. */
  readonly unattended: boolean;
}

/** A message accepted but not yet started. */
interface QueuedTurn {
  /** Acked to the client, and the `turnId` the turn will run under. */
  readonly id: string;
  readonly content: string | readonly ContentPart[];
  readonly agentId: string | undefined;
  readonly channel: string;
  /** Only ever creates; an existing session keeps the workspace it was born in. */
  readonly workspaceId: string | undefined;
  /** Parsed at submit time, so a queued message is not reparsed to run it. */
  readonly mentions: ParsedMentions;
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
 * `userMessage` is cheapest on.
 *
 * Every attachment becomes a `FilePart`, with no branch on the MIME type. This
 * layer's job is to record *what was attached*, and a path does that for a
 * screenshot and a 200 MB archive alike; deciding what a model can be shown of
 * it needs bytes off the disk and belongs in `materialiseAttachments`, at
 * request time, where the jail is. Branching here is how images ended up
 * carrying a signed URL that expired ten minutes later and that no provider
 * could resolve in the first place.
 */
function toContent(
  text: string,
  attachments: readonly Attachment[],
): string | readonly ContentPart[] {
  if (attachments.length === 0) return text;

  const parts: ContentPart[] = [];
  if (text !== '') parts.push(textPart(text));
  for (const attachment of attachments) {
    parts.push(
      filePart(attachment.path, attachment.mimeType, {
        ...(attachment.name === undefined ? {} : { name: attachment.name }),
        ...(attachment.sizeBytes === undefined
          ? {}
          : { sizeBytes: attachment.sizeBytes }),
      }),
    );
  }
  return parts;
}

/** The first schema complaint, short enough to put on a wire. */
function describeParseFailure(
  issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>,
): string {
  const first = issues[0];
  if (first === undefined) return 'Frame did not match any client message';
  const path = first.path.map(String).join('.');
  return path === '' ? first.message : `${path}: ${first.message}`;
}

export class SessionHub {
  private readonly config: Config;
  private readonly loop: (agentId: string | undefined) => TurnRunner | null;
  private readonly resolveAgentId: SessionHubOptions['resolveAgentId'];
  private readonly store: SessionStore;
  private readonly approvals: HubApprovalGate;
  private readonly clock: Clock;
  private readonly logger: Logger;
  private readonly newId: () => string;
  private readonly maxQueueDepth: number;
  private readonly maxSessions: number;
  private readonly sessions = new Map<string, SessionState>();

  constructor(options: SessionHubOptions) {
    this.config = options.config;
    this.loop = options.loop;
    this.resolveAgentId = options.resolveAgentId;
    this.store = options.store;
    this.approvals = options.approvals;
    this.clock = options.clock ?? systemClock;
    this.logger = options.logger ?? silentLogger;
    this.newId = options.newId ?? newUuid;
    this.maxQueueDepth = options.maxQueueDepth ?? DEFAULT_MAX_QUEUE_DEPTH;
    this.maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
  }

  /** Sessions holding state in this process. Includes idle ones, for their rings. */
  get sessionCount(): number {
    return this.sessions.size;
  }

  /** Whether a turn is running on this session. */
  busy(sessionKey: string): boolean {
    return this.sessions.get(sessionKey)?.running !== undefined;
  }

  /**
   * How many clients are looking at this session right now.
   *
   * Exists for the approval gate, and the question it really answers is "can
   * anyone answer a prompt on this session". Zero is the unattended case: a
   * scheduled run, or a conversation whose tab was closed mid-turn. The gate
   * turns that into a notification, because a request parked against nobody is
   * a five-minute wait for a denial that was certain from the start.
   *
   * A count rather than a boolean so a caller can tell "nobody" from "one tab"
   * without a second method, and because the set is already here.
   */
  watchers(sessionKey: string): number {
    const clients = this.sessions.get(sessionKey)?.clients;
    if (clients === undefined) return 0;
    let count = 0;
    // Not `clients.size`. The scheduler's own connection is in this set for the
    // whole of a run, so counting it made every unattended turn look watched.
    for (const client of clients) if (!client.unattended) count += 1;
    return count;
  }

  /**
   * One frame to every attached client, on every session.
   *
   * What this exists for: the scheduler raises notifications about turns nobody
   * started, and there is no session they belong to — a nightly job's result is
   * addressed to whoever is looking, not to a conversation.
   *
   * `seq` is per session, so this stamps each session's own counter rather than
   * inventing a second sequence space the replay ring would not understand.
   *
   * **Sessions with no client attached are skipped**, and that is the part that
   * keeps the `seq` contract honest rather than being an optimisation: bumping
   * a counter nobody is reading would leave a session that reconnects later
   * resuming at a `lastSeq` accounting for an event it was never sent, which is
   * exactly the gap `replay` reports as incomplete.
   *
   * The accepted cost is the mirror of that: a tab reconnecting mid-turn
   * replays the ring and sees the notification a second time. A duplicate toast
   * is worth less than a false gap.
   */
  broadcast(event: HubEvent): void {
    for (const state of this.sessions.values()) {
      if (state.clients.size === 0) continue;
      this.emit(state, event);
    }
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
      id: this.newId(),
      send: options.send,
      channel: options.channel ?? 'web',
      agentId: options.agentId,
      workspaceId: options.workspaceId,
      // A fresh tab with no `?session=` gets its key here.
      sessionKey: options.sessionKey ?? this.newId(),
      closed: false,
      unattended: options.unattended ?? false,
    };

    const state = this.session(connection.sessionKey);
    state.clients.add(connection);
    this.logger.debug(
      { connectionId: connection.id, sessionKey: connection.sessionKey },
      'hub connection opened',
    );

    this.deliver(connection, {
      type: 'connected',
      protocolVersion: PROTOCOL_VERSION,
      sessionKey: connection.sessionKey,
      serverTimeMs: this.clock.now(),
      lastSeq: state.seq,
      workspaceId: this.workspaceOf(connection),
    });

    return {
      id: connection.id,
      get sessionKey(): string {
        return connection.sessionKey;
      },
      receive: (frame: unknown): void => {
        this.receive(connection, frame);
      },
      close: (): void => {
        this.disconnect(connection);
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
    for (const state of this.sessions.values()) {
      state.running?.controller.abort();
      state.queue.length = 0;
      this.approvals.clearSession(state.key);
    }
    this.sessions.clear();
  }

  /**
   * Forgets standing tool approvals for agents that are no longer configured.
   *
   * Called after a settings write, because that is the only moment an agent can
   * stop existing. The gate is the hub's, so the route reaches it through here
   * rather than being handed the gate as a second dependency.
   */
  retainAgents(agentIds: ReadonlySet<string>): void {
    this.approvals.retainAgents(agentIds);
  }

  /** Carries one agent's standing tool approvals to its new id. */
  renameAgent(from: string, to: string): void {
    this.approvals.renameAgent(from, to);
  }

  // -------------------------------------------------------------------------
  // Inbound
  // -------------------------------------------------------------------------

  private receive(connection: Connection, frame: unknown): void {
    if (connection.closed) return;

    const decoded = decodeFrame(frame);
    let value: unknown = decoded;
    if (typeof decoded === 'string') {
      try {
        value = JSON.parse(decoded);
      } catch {
        this.error(connection, 'bad_request', 'Frame is not valid JSON');
        return;
      }
    }

    const parsed = ClientMessageSchema.safeParse(value);
    if (!parsed.success) {
      this.error(
        connection,
        'bad_request',
        describeParseFailure(parsed.error.issues),
      );
      return;
    }

    this.dispatch(connection, parsed.data);
  }

  /** Exhaustive on purpose: a client message added without a handler is a type error. */
  private dispatch(connection: Connection, message: ClientMessage): void {
    switch (message.type) {
      case 'ping':
        this.deliver(connection, {
          type: 'pong',
          serverTimeMs: this.clock.now(),
        });
        return;

      case 'user.message':
        this.submit(connection, message);
        return;

      case 'turn.regenerate':
        this.regenerate(connection, message);
        return;

      case 'user.edit':
        this.edit(connection, message);
        return;

      case 'turn.stop': {
        const state = this.sessions.get(message.sessionKey);
        // A stop with nothing running is the user clicking as the turn ends.
        // Answering it with an error would be reporting a race as a mistake.
        if (state?.running === undefined) return;
        this.logger.info(
          { sessionKey: state.key, turnId: state.running.turnId },
          'turn stopped by client',
        );
        state.running.controller.abort();
        return;
      }

      case 'turn.steer': {
        const state = this.sessions.get(message.sessionKey);
        if (state?.running === undefined) {
          this.error(
            connection,
            'bad_request',
            'No turn is running on this session to steer',
          );
          return;
        }
        // The loop the turn started on, not the current one: after a
        // reconfigure those differ, and the queue the running loop drains is
        // the only one it will ever read.
        state.running.runner.steer(state.key, message.content);
        this.emit(state, {
          type: 'steer',
          sessionKey: state.key,
          content: message.content,
        });
        return;
      }

      case 'session.new':
        // A `session.new` naming a workspace re-points this connection, so the
        // conversation it is about to start lands there rather than in whatever
        // the tab was opened with.
        if (message.workspaceId !== undefined) {
          connection.workspaceId = message.workspaceId;
        }
        // And the same for the agent it names. Without this the field was read
        // off the frame and dropped: `connection.agentId` was only ever set at
        // connect time, so the fallback at `#submit` could never see anything a
        // client chose later. The web UI happens to resend `agentId` on every
        // message, which is what hid it — a channel does not.
        if (message.agentId !== undefined) connection.agentId = message.agentId;
        this.move(connection, message.sessionKey ?? this.newId());
        return;

      case 'session.switch':
        this.move(connection, message.sessionKey);
        return;

      case 'session.resume':
        this.resume(connection, message.sessionKey, message.lastSeq);
        return;

      case 'tool.approve': {
        const answered = this.approvals.resolve(
          message.callId,
          message.approved,
          message.scope,
        );
        // An unanswered `callId` is the normal two-tab race, or an answer to a
        // call whose turn was stopped. Neither is worth an error frame.
        if (!answered) {
          this.logger.debug(
            { callId: message.callId },
            'approval answered too late',
          );
        }
        return;
      }

      case 'audio.transcribe':
        this.error(
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
  private submit(
    connection: Connection,
    message: Extract<ClientMessage, { type: 'user.message' }>,
  ): void {
    const state = this.session(message.sessionKey);
    const clientMessageId = message.clientMessageId;

    if (clientMessageId !== undefined) {
      const known = state.acked.get(clientMessageId);
      if (known !== undefined) {
        // A retry after a dropped socket. It is acked again, with the id the
        // first attempt got and no second turn queued — the ack is idempotent
        // because the client keys on `messageId`, and re-acking is what tells a
        // reconnecting tab its message did land.
        this.logger.debug(
          { sessionKey: state.key, clientMessageId },
          'duplicate client message id, not re-queued',
        );
        this.emit(state, {
          type: 'message.ack',
          sessionKey: state.key,
          messageId: known,
          clientMessageId,
        });
        return;
      }
    }

    if (message.content === '' && message.attachments.length === 0) {
      this.error(connection, 'bad_request', 'Message is empty');
      return;
    }

    this.enqueue(connection, state, {
      content: toContent(message.content, message.attachments),
      // Here, and only here. Parsing mentions in the WebSocket handler would
      // make `@kb:` a browser feature: a channel bridging through this hub
      // sends the same frame and would get none of it. The text is never
      // modified — the model sees exactly what the user typed.
      mentions: parseMentions(message.content),
      ...(clientMessageId === undefined ? {} : { clientMessageId }),
      ...(message.agentId === undefined ? {} : { agentId: message.agentId }),
    });
  }

  /**
   * The queue rules, in the one place that has them.
   *
   * `#submit`, `#regenerate` and `#edit` all end here. Three callers is exactly
   * why this is a method: the depth cap, the ack and the drain/queue decision
   * are the contract a client renders against, and three copies of it would be
   * three chances for a retry path to behave unlike the path it retries.
   */
  private enqueue(
    connection: Connection,
    state: SessionState,
    turn: {
      readonly content: string | readonly ContentPart[];
      readonly mentions: ParsedMentions;
      readonly clientMessageId?: string;
      readonly agentId?: string;
    },
  ): void {
    if (state.queue.length >= this.maxQueueDepth) {
      this.error(
        connection,
        'session_busy',
        `This session already has ${String(state.queue.length)} messages waiting. Let it catch up.`,
        true,
      );
      return;
    }

    const id = this.newId();
    if (turn.clientMessageId !== undefined) {
      this.remember(state, turn.clientMessageId, id);
    }

    state.queue.push({
      id,
      content: turn.content,
      agentId: turn.agentId ?? connection.agentId,
      channel: connection.channel,
      workspaceId: connection.workspaceId,
      mentions: turn.mentions,
    });

    this.emit(state, {
      type: 'message.ack',
      sessionKey: state.key,
      messageId: id,
      ...(turn.clientMessageId === undefined
        ? {}
        : { clientMessageId: turn.clientMessageId }),
    });

    if (state.running !== undefined) {
      this.emit(state, {
        type: 'message.queued',
        sessionKey: state.key,
        queueDepth: state.queue.length,
      });
      this.status(state);
      return;
    }

    this.drain(state);
  }

  /**
   * Re-runs a turn, discarding the answer it produced.
   *
   * The guard order is the design, not decoration. **The unconfigured check
   * comes before the truncation**: discovering there is no model *after*
   * deleting the answer would destroy what the user had and give nothing back,
   * and it is the one ordering mistake here that is not recoverable.
   */
  private regenerate(
    connection: Connection,
    message: Extract<ClientMessage, { type: 'turn.regenerate' }>,
  ): void {
    const state = this.session(message.sessionKey);

    if (this.loop(undefined) === null) {
      this.error(connection, 'not_configured', NO_MODEL_MESSAGE, false);
      return;
    }

    // A queued message would otherwise run against a history that is about to
    // change underneath it.
    if (state.running !== undefined || state.queue.length > 0) {
      this.error(
        connection,
        'session_busy',
        'A turn is running on this session. Stop it, then try again.',
        true,
      );
      return;
    }

    const target =
      message.seq === undefined
        ? this.lastQuestion(state.key)
        : this.userMessageAt(state.key, message.seq);
    if (target === undefined) {
      this.error(
        connection,
        'bad_request',
        'There is nothing to regenerate on this session.',
      );
      return;
    }

    // Read before the delete, because the delete is what removes it.
    const content =
      target.message.role === 'user' ? target.message.content : [];
    this.rewind(state, target.seq);
    this.enqueue(connection, state, {
      content,
      mentions: parseMentions(textOf(target.message)),
      // Forwarded exactly as `#edit` does. The rewind above deletes the question
      // and the loop appends it again, so the asking client is showing an
      // optimistic bubble in the gap; this is what the ack uses to claim it.
      ...(message.clientMessageId === undefined
        ? {}
        : { clientMessageId: message.clientMessageId }),
    });
  }

  /** Replaces a message and re-runs from it. Same guards as `#regenerate`. */
  private edit(
    connection: Connection,
    message: Extract<ClientMessage, { type: 'user.edit' }>,
  ): void {
    const state = this.session(message.sessionKey);

    if (this.loop(undefined) === null) {
      this.error(connection, 'not_configured', NO_MODEL_MESSAGE, false);
      return;
    }

    if (state.running !== undefined || state.queue.length > 0) {
      this.error(
        connection,
        'session_busy',
        'A turn is running on this session. Stop it, then try again.',
        true,
      );
      return;
    }

    if (this.userMessageAt(state.key, message.seq) === undefined) {
      this.error(connection, 'bad_request', 'That message cannot be edited.');
      return;
    }

    if (message.content === '' && message.attachments.length === 0) {
      this.error(connection, 'bad_request', 'Message is empty');
      return;
    }

    this.rewind(state, message.seq);
    this.enqueue(connection, state, {
      content: toContent(message.content, message.attachments),
      mentions: parseMentions(message.content),
      ...(message.clientMessageId === undefined
        ? {}
        : { clientMessageId: message.clientMessageId }),
      ...(message.agentId === undefined ? {} : { agentId: message.agentId }),
    });
  }

  /**
   * Drops the question at `seq` and everything after it, then says so.
   *
   * **Minus one is load-bearing.** `AgentLoop.run` appends the user message
   * unconditionally at the top of every turn, so truncating *to* `seq` and then
   * re-running would write the same question twice — once from history and once
   * from the loop. The question is deleted here and rewritten there.
   */
  private rewind(state: SessionState, seq: number): void {
    const result = this.store.truncateAfter(state.key, seq - 1);
    this.emit(state, {
      type: 'session.truncated',
      sessionKey: state.key,
      upToSeq: result.seq,
      // The surviving tail, so a client rebuilds from this frame rather than
      // racing a refetch against the turn that is about to start. Sequenced, so
      // every other attached tab corrects itself with no code of its own.
      messages: this.store
        .messages(state.key, { limit: RESUME_MESSAGE_LIMIT, fromEnd: true })
        .map(toStoredMessage),
    });
  }

  /** The stored row at `seq`, if it is a message the user wrote. */
  private userMessageAt(
    sessionKey: string,
    seq: number,
  ): StoredMessageRecord | undefined {
    const [record] = this.store.messages(sessionKey, {
      afterSeq: seq - 1,
      beforeSeq: seq + 1,
    });
    return record?.message.role === 'user' ? record : undefined;
  }

  /**
   * The question that started the most recent turn.
   *
   * The *earliest* user row of that turn, not the latest: steering appends user
   * rows mid-turn under the same turn id, and the last of those is a correction
   * to the answer rather than the question that asked for it.
   */
  private lastQuestion(sessionKey: string): StoredMessageRecord | undefined {
    const tail = this.store.messages(sessionKey, {
      limit: RESUME_MESSAGE_LIMIT,
      fromEnd: true,
    });
    const turnId = tail.at(-1)?.turnId;
    if (turnId === undefined) return undefined;
    return tail.find(
      (record) => record.turnId === turnId && record.message.role === 'user',
    );
  }

  private remember(
    state: SessionState,
    clientMessageId: string,
    messageId: string,
  ): void {
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
  private drain(state: SessionState): boolean {
    if (state.running !== undefined) return false;
    const next = state.queue.shift();
    if (next === undefined) return false;
    // The turn is set up synchronously before the first `await`, so `running` is
    // populated by the time this returns.
    void this.runTurn(state, next);
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
  private async runTurn(state: SessionState, turn: QueuedTurn): Promise<void> {
    const controller = new AbortController();
    /**
     * Set once the loop's `turn.start` has reached the clients.
     *
     * The distinction it records is "did anyone see this turn open", which is
     * what decides whether a failure can be closed at an address the client
     * already holds. Undefined means the loop was never asked to run at all.
     */
    let opened: { readonly firstSeq: number | undefined } | undefined;
    try {
      // An id naming no runnable agent — deleted, switched off, or never real —
      // becomes the default agent rather than a refusal. A conversation must
      // not stop working because an agent it was bound to was deleted, and the
      // binding is left alone, so re-creating that agent silently restores it.
      // The rule lives in `agent-binding.ts`: sixty lines of domain policy do
      // not belong in the file that frames sockets.
      const requested = agentForTurn({
        stored: this.store.getSession(state.key)?.agentId,
        requested: turn.agentId,
        resolves: (agentId) => this.resolveAgentId(agentId).miss === undefined,
      });
      const { agentId, miss } = this.resolveAgentId(requested);
      if (miss !== undefined) {
        // Said out loud every turn, not once. The fallback is re-decided each
        // time — nothing is written to make it stick — so a notice that fired
        // once would describe a state the operator could no longer see. It also
        // matters that they see it: the default agent may allow tools the
        // departed one did not, so this widens what the turn can do.
        // Through `#emit`, so it is sequenced into the transcript and survives
        // a reload the way the turn's own events do. A fallback the operator
        // only saw if they happened to be watching would be worth very little.
        //
        // Deliberately carries **no `turnId`**. This is a statement about the
        // conversation's binding rather than about anything the turn did, and
        // the turn it would name has not started yet — a notice addressed to a
        // turn the transcript has no item for is one the client silently drops.
        this.emit(state, {
          type: 'notice',
          kind: 'agent_fallback',
          message:
            miss === 'disabled'
              ? `This session runs on "${requested ?? agentId}", which is switched off. Using "${agentId}" instead.`
              : `This session runs on "${requested ?? agentId}", which no longer exists. Using "${agentId}" instead.`,
        });
      }

      let runner: TurnRunner | null;
      try {
        runner = this.loop(agentId);
      } catch (error) {
        // Not a missing agent any more — `resolveAgentId` just ruled that out —
        // but an agent that exists and cannot be built, which is a real fault.
        // Reported on the frame that asked for it: the connection is fine, and
        // every other session on it keeps working.
        this.failTurn(state, turn.id, error);
        return;
      }
      if (runner === null) {
        // Not a failure of this turn so much as of the install. It is reported
        // where the turn would have been, and `turn.end` is *not* emitted,
        // because no turn ever started — a client that saw one close would
        // render an empty assistant message for a request nothing ran.
        this.broadcastToSession(state, {
          type: 'error',
          code: 'not_configured',
          message: NO_MODEL_MESSAGE,
          retryable: false,
          turnId: turn.id,
        });
        return;
      }
      state.running = { turnId: turn.id, controller, runner };
      state.touchedAtMs = this.clock.now();
      this.status(state);

      const events = runner.run({
        sessionKey: state.key,
        content: turn.content,
        signal: controller.signal,
        channel: turn.channel,
        turnId: turn.id,
        mentions: turn.mentions,
        ...(turn.workspaceId === undefined
          ? {}
          : { workspaceId: turn.workspaceId }),
        // The *resolved* id, so the loop that runs and the binding it writes
        // agree. Passing the frame's raw id would let a turn run on `default`
        // while `ensureSession` recorded a session bound to an agent that does
        // not exist — the exact disagreement `agentForTurn` exists to prevent.
        //
        // Still conditional on the frame having named one at all: an absent
        // `agentId` means "do not bind", and substituting `default` here would
        // turn every unbound conversation into an explicitly-bound one.
        ...(turn.agentId === undefined ? {} : { agentId }),
      });

      for await (const event of events) {
        // Remembered so a failure below can close the turn at the same address
        // the client already has. The loop opens the turn before anything that
        // can throw, so in practice this is set whenever the loop ran at all.
        if (event.type === 'turn.start') opened = { firstSeq: event.firstSeq };
        this.forward(state, event);
      }
    } catch (error) {
      this.failTurn(state, turn.id, error, opened);
    } finally {
      state.running = undefined;
      state.touchedAtMs = this.clock.now();
      // The next turn's own `turn.start` and status say the session is busy
      // again; announcing idle first would make a queue look like a gap.
      if (!this.drain(state)) this.status(state);
    }
  }

  /**
   * Closes a turn that threw.
   *
   * `opened` carries the `firstSeq` the loop reported on `turn.start`, when it
   * got that far. Restating it here is what keeps a failed turn re-runnable
   * through a reconnect: the client reads `message.firstSeq ?? turn.firstSeq`,
   * so a replay that has lost the original `turn.start` out of the ring buffer
   * would otherwise rebuild a turn with no address and offer no Regenerate.
   */
  private failTurn(
    state: SessionState,
    turnId: string,
    error: unknown,
    opened?: { readonly firstSeq: number | undefined },
  ): void {
    const address =
      opened?.firstSeq === undefined
        ? {}
        : ({ firstSeq: opened.firstSeq } as const);

    if (isAbortError(error)) {
      // The loop normally yields `turn.end` with `aborted` itself; a throw here
      // means it unwound before it could, and the turn still has to close.
      this.emit(state, {
        type: 'turn.end',
        turnId,
        stopReason: 'aborted',
        iterations: 0,
        ...address,
      });
      return;
    }

    // The same mapping the REST error handler uses, so one thrown value cannot
    // be a `provider_error` on a socket and a 500 with a different code on a
    // route. It also decides what is safe to say: an unexpected throw's message
    // was written for a stack trace, not for whoever is connected.
    const resolved = resolveError(error);
    this.logger.error(
      { sessionKey: state.key, turnId, err: resolved.cause },
      'turn failed',
    );
    this.broadcastToSession(state, {
      type: 'error',
      code: resolved.code,
      message: resolved.body.error.message,
      retryable: resolved.cause.retryable,
      turnId,
    });
    this.emit(state, {
      type: 'turn.end',
      turnId,
      stopReason: 'error',
      iterations: 0,
      ...address,
    });
  }

  /**
   * One turn event onto the wire.
   *
   * `error` is the only event the protocol leaves unsequenced — it is scoped to
   * a connection or a turn rather than to a session's replayable history — so it
   * broadcasts without a counter and never enters the ring.
   */
  private forward(state: SessionState, event: AgentEvent): void {
    if (event.type === 'error') {
      this.broadcastToSession(state, event);
      return;
    }
    this.emit(state, event);
  }

  // -------------------------------------------------------------------------
  // Sessions and replay
  // -------------------------------------------------------------------------

  private session(key: string): SessionState {
    const existing = this.sessions.get(key);
    if (existing !== undefined) {
      existing.touchedAtMs = this.clock.now();
      return existing;
    }

    const state: SessionState = {
      key,
      seq: 0,
      ring: new ReplayBuffer(this.config.server.replayBufferSize),
      clients: new Set(),
      queue: [],
      running: undefined,
      acked: new Map(),
      touchedAtMs: this.clock.now(),
    };
    this.sessions.set(key, state);
    // Excluded from its own eviction: nothing has attached to it yet, so by
    // every measure of "idle" it is the best victim in the map — and evicting
    // the session a client is in the middle of opening would drop the state
    // that call is about to use.
    this.evict(key);
    return state;
  }

  /** Drops the oldest idle sessions until the cap holds, or nothing is idle. */
  private evict(exclude: string): void {
    while (this.sessions.size > this.maxSessions) {
      let victim: SessionState | undefined;
      for (const state of this.sessions.values()) {
        if (state.key === exclude) continue;
        const idle =
          state.clients.size === 0 &&
          state.running === undefined &&
          state.queue.length === 0;
        if (!idle) continue;
        if (victim === undefined || state.touchedAtMs < victim.touchedAtMs) {
          victim = state;
        }
      }
      if (victim === undefined) return;
      this.sessions.delete(victim.key);
      this.approvals.clearSession(victim.key);
      this.logger.debug(
        { sessionKey: victim.key },
        'evicted idle session state',
      );
    }
  }

  /** Moves a connection onto another session and reports where it landed. */
  private move(connection: Connection, sessionKey: string): SessionState {
    const target = this.session(sessionKey);
    if (connection.sessionKey !== sessionKey) {
      this.sessions.get(connection.sessionKey)?.clients.delete(connection);
      connection.sessionKey = sessionKey;
      target.clients.add(connection);
    }
    this.status(target);
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
  private resume(
    connection: Connection,
    sessionKey: string,
    lastSeq: number,
  ): void {
    const state = this.move(connection, sessionKey);
    const slice = state.ring.after(lastSeq);

    this.emit(state, {
      type: 'session.replay',
      sessionKey: state.key,
      messages: slice.complete
        ? []
        : this.store
            .messages(state.key, { limit: RESUME_MESSAGE_LIMIT, fromEnd: true })
            .map(toStoredMessage),
      complete: slice.complete,
    });

    if (!slice.complete) {
      this.logger.info(
        { sessionKey: state.key, lastSeq, ringSize: state.ring.size },
        'resume fell outside the replay buffer',
      );
      return;
    }

    // Re-sends, not new events: the same frames with the same `seq`, to the one
    // connection that missed them. They therefore arrive *after* an envelope
    // carrying a higher number, which is why a client tracks the maximum `seq`
    // it has seen rather than the last one it was handed.
    for (const message of slice.messages) this.deliver(connection, message);
  }

  private status(state: SessionState): void {
    this.emit(state, {
      type: 'session.status',
      sessionKey: state.key,
      busy: state.running !== undefined,
      queueDepth: state.queue.length,
      workspaceId: this.storedWorkspace(state.key) ?? DEFAULT_WORKSPACE_ID,
      ...(state.running === undefined ? {} : { turnId: state.running.turnId }),
    });
  }

  /** The workspace a session is bound to, or `undefined` before its first turn. */
  private storedWorkspace(sessionKey: string): string | undefined {
    return this.store.getSession(sessionKey)?.workspaceId;
  }

  /**
   * What to tell a connection its workspace is.
   *
   * The stored row wins — switching to someone else's session moves you to
   * *its* workspace, and saying so is what stops the UI's idea of the current
   * workspace from drifting from the session's. Before a session has a row,
   * the answer is what this connection would create it in.
   */
  private workspaceOf(connection: Connection): string {
    return (
      this.storedWorkspace(connection.sessionKey) ??
      connection.workspaceId ??
      DEFAULT_WORKSPACE_ID
    );
  }

  // -------------------------------------------------------------------------
  // Outbound
  // -------------------------------------------------------------------------

  private emit(state: SessionState, event: HubEvent): void {
    state.seq += 1;
    // `AgentEvent` and every hub-originated event above is a `ServerMessage`
    // minus its `seq`; stamping the counter completes it, and the compiler
    // agrees without a cast. `hub.test.ts` parses every frame this hub emits
    // through `ServerMessageSchema`, so the runtime shape is checked too.
    const message: SequencedServerMessage = { ...event, seq: state.seq };
    state.ring.push(message);
    this.broadcastToSession(state, message);
  }

  /** A copy of the set, because a failing send detaches the connection mid-loop. */
  private broadcastToSession(
    state: SessionState,
    message: ServerMessage,
  ): void {
    for (const connection of [...state.clients]) {
      this.deliver(connection, message);
    }
  }

  private deliver(connection: Connection, message: ServerMessage): void {
    if (connection.closed) return;
    try {
      connection.send(message);
    } catch (error) {
      this.logger.warn(
        { connectionId: connection.id, err: error, type: message.type },
        'connection send failed, detaching',
      );
      this.disconnect(connection);
    }
  }

  private error(
    connection: Connection,
    code: ErrorCode,
    message: string,
    retryable = false,
  ): void {
    this.deliver(connection, { type: 'error', code, message, retryable });
  }

  private disconnect(connection: Connection): void {
    if (connection.closed) return;
    connection.closed = true;
    this.sessions.get(connection.sessionKey)?.clients.delete(connection);
    this.logger.debug(
      { connectionId: connection.id, sessionKey: connection.sessionKey },
      'hub connection closed',
    );
    // The session state stays: the case a replay buffer exists for is a tab that
    // reloads, which is a disconnect followed by a reconnect a second later.
    // `#evict` is what eventually reclaims it.
  }
}
