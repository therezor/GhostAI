/**
 * The bridge: `MessageBus` on one side, the session hub on the other.
 *
 * A channel publishes an `InboundMessage`; this turns it into the same
 * `user.message` frame a browser sends and hands it to the hub. The hub answers
 * with the same `ServerMessage` stream a browser gets; this projects it back
 * into `OutboundMessage`s and pushes them to the channel that asked. Both
 * directions go through the bus, so the queueing, the rate limit and the
 * bounded capacity are the ones `@ghostai/core` already implements rather than
 * a second set per channel.
 *
 * What that buys is the point of the whole package: a Telegram turn is not a
 * different code path from a web turn. It is the same hub, the same queue
 * discipline, the same approval gate, the same session store — so `@kb:`
 * parsing, `session_busy` and a stop mid-tool behave identically, and the
 * behaviours that only ever get exercised in a browser cannot quietly stop
 * working everywhere else.
 *
 * Three things here are load-bearing:
 *
 *  - **Session keys are namespaced by channel.** A channel names its own
 *    session (`telegram:4471`), and a channel that named `web:1` would be
 *    writing into a browser's conversation — reading its history back on the
 *    next turn and posting its replies to a stranger. Any key not already
 *    prefixed with the channel's id gets prefixed.
 *  - **One hub connection per `(channel, session)`, bounded and evicted.** A
 *    public channel has an unbounded supply of senders, and a connection the
 *    hub can see is a session the hub will not evict — so the bound has to be
 *    here. Eviction is least-recently-used and skips sessions with a turn in
 *    flight, which is the same rule the hub applies to its own rings.
 *  - **Ordering is per channel, not global.** Each channel gets its own
 *    delivery chain, so a Telegram edit waiting on a `RetryAfter` cannot hold
 *    up a reply on Discord, and a `reply` still cannot overtake the `progress`
 *    that preceded it on the same channel.
 */

import {
  MessageBus,
  silentLogger,
  systemClock,
  textPart,
  type Clock,
  type InboundMessage,
  type Logger,
  type MessageBusOptions,
  type OutboundKind,
  type OutboundMessage,
} from '@ghostai/core';
import type { Attachment, ContentPart, ServerMessage } from '@ghostai/protocol';

import {
  DEFAULT_ACCEPTED_KINDS,
  type Channel,
  type ChannelContext,
  type ChannelFactory,
  type ChannelInbound,
} from './channel.js';
import { TurnProjection, type TurnProjectionOptions } from './projection.js';

/**
 * The hub, as this package needs it.
 *
 * Structural rather than an import of `SessionHub`, for the reason
 * `@ghostai/server` states its own `ServerRuntime` port: depending on the
 * transport package would put a Fastify instance, an auth store and argon2id
 * behind every channel test, and would point an arrow from the channels at the
 * HTTP server that nothing in the design wants. `SessionHub` satisfies this as
 * written.
 */
export interface ChannelHubConnection {
  /** Moves on `session.switch`; a channel connection never sends one. */
  readonly sessionKey: string;
  receive(frame: unknown): void;
  close(): void;
}

export interface ChannelHubConnectOptions {
  /**
   * A property rather than a method, which is not a style choice: the hub keeps
   * this function and calls it detached from the object it arrived on, and a
   * method shorthand would make that a `this`-scoping hazard the linter is
   * right to flag.
   */
  readonly send: (message: ServerMessage) => void;
  readonly sessionKey?: string;
  /** Recorded as the session's origin, so a bridged turn is not labelled `web`. */
  readonly channel?: string;
  /** The workspace a session created by this connection lands in. */
  readonly workspaceId?: string;
  /**
   * The agent a session created by this channel is bound to.
   *
   * Optional, like everything else here: this interface is structural so a
   * channel needs no import of the hub, and a required field would break every
   * implementation of it.
   */
  readonly agentId?: string;
}

export interface ChannelHub {
  connect(options: ChannelHubConnectOptions): ChannelHubConnection;
}

/**
 * How many `(channel, session)` pairs hold a hub connection.
 *
 * High enough that a household's worth of chats never reaches it, low enough
 * that a public bot cannot turn one connection per sender into unbounded state
 * in a process that has no other reason to grow.
 */
export const DEFAULT_MAX_CHANNEL_SESSIONS = 256;

export interface ChannelManagerOptions {
  readonly hub: ChannelHub;
  /**
   * `config.channels`, whole.
   *
   * The two known flags drive the projection; every other key is a channel's
   * own settings block, looked up by the channel's id. `enabled: false` in that
   * block keeps a registered channel from starting, which is how a UI toggle
   * turns one off without uninstalling it.
   */
  readonly channels?: Readonly<Record<string, unknown>>;
  readonly factories?: readonly ChannelFactory[];
  /** Shared with a caller that has one; otherwise the manager makes its own. */
  readonly bus?: MessageBus;
  /** Applied to the bus this manager creates. Ignored when one is supplied. */
  readonly busOptions?: MessageBusOptions;
  readonly logger?: Logger;
  readonly clock?: Clock;
  readonly maxSessions?: number;
  /**
   * The workspace bridged conversations are created in.
   *
   * Defaults to `default`, which is the right answer for a chat app: a person
   * messaging a bot has no way to pick a workspace, and the default is the one
   * that can see every other. An operator who wants a channel confined to its
   * own workspace sets this and gets exactly that.
   *
   * Only ever creates — a session that already exists keeps the workspace it
   * was born in, so changing this does not move existing conversations.
   */
  readonly workspaceId?: string;
}

/** One `(channel, session)` pair: its hub connection and its turn state. */
interface Bridged {
  readonly key: string;
  readonly channelId: string;
  readonly sessionKey: string;
  readonly connection: ChannelHubConnection;
  readonly projection: TurnProjection;
  /** Where replies go: the channel's own address for this conversation. */
  target: string;
  /** Read from `session.status`, so eviction can leave a running turn alone. */
  busy: boolean;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A channel's own settings block, or an empty one. */
function settingsFor(
  channels: Readonly<Record<string, unknown>>,
  id: string,
): Readonly<Record<string, unknown>> {
  const block = channels[id];
  return isRecord(block) ? block : {};
}

function flagOf(source: Readonly<Record<string, unknown>>, key: string): boolean | undefined {
  const value = source[key];
  return typeof value === 'boolean' ? value : undefined;
}

/**
 * The text and the attachments a `user.message` frame carries.
 *
 * An image with a `url` keeps it; one carrying bytes becomes a data URI, which
 * is the same thing the upload route would have produced and is what makes a
 * photo sent to a bot reach the model rather than being dropped on the way.
 */
function toFrameContent(content: readonly ContentPart[]): {
  text: string;
  attachments: Attachment[];
} {
  const texts: string[] = [];
  const attachments: Attachment[] = [];
  for (const part of content) {
    if (part.type === 'text') {
      texts.push(part.text);
      continue;
    }
    const url =
      part.url ??
      (part.data === undefined ? undefined : `data:${part.mimeType};base64,${part.data}`);
    if (url !== undefined) attachments.push({ type: part.mimeType, url });
  }
  return { text: texts.join('\n'), attachments };
}

/** The reply address a channel gave us, if it gave one. */
function targetOf(message: InboundMessage): string {
  const target = message.metadata.target;
  return typeof target === 'string' && target !== '' ? target : message.senderId;
}

export class ChannelManager {
  readonly #hub: ChannelHub;
  readonly #channelsConfig: Readonly<Record<string, unknown>>;
  readonly #projectionOptions: TurnProjectionOptions;
  readonly #bus: MessageBus;
  readonly #ownsBus: boolean;
  readonly #logger: Logger;
  readonly #clock: Clock;
  readonly #maxSessions: number;
  readonly #workspaceId: string | undefined;
  readonly #factories = new Map<string, ChannelFactory>();
  readonly #channels = new Map<string, Channel>();
  /** Delivery chains, one per channel — see the module header. */
  readonly #tails = new Map<string, Promise<void>>();
  readonly #bridged = new Map<string, Bridged>();
  readonly #lifetime = new AbortController();
  #pumps: Promise<void> | undefined;
  #started = false;

  constructor(options: ChannelManagerOptions) {
    this.#hub = options.hub;
    this.#channelsConfig = options.channels ?? {};
    this.#projectionOptions = {
      sendProgress: flagOf(this.#channelsConfig, 'sendProgress') ?? true,
      sendToolHints: flagOf(this.#channelsConfig, 'sendToolHints') ?? false,
    };
    this.#bus = options.bus ?? new MessageBus(options.busOptions ?? {});
    this.#ownsBus = options.bus === undefined;
    this.#logger = options.logger ?? silentLogger;
    this.#clock = options.clock ?? systemClock;
    this.#maxSessions = options.maxSessions ?? DEFAULT_MAX_CHANNEL_SESSIONS;
    this.#workspaceId = options.workspaceId;
    for (const factory of options.factories ?? []) this.register(factory);
  }

  /** The queue both directions travel through. Shared with the scheduler later. */
  get bus(): MessageBus {
    return this.#bus;
  }

  /** Live channels, in registration order. */
  get channels(): readonly Channel[] {
    return [...this.#channels.values()];
  }

  /** `(channel, session)` pairs currently holding a hub connection. */
  get sessionCount(): number {
    return this.#bridged.size;
  }

  channel(id: string): Channel | undefined {
    return this.#channels.get(id);
  }

  /**
   * Adds a factory. Before `start()`, and never twice under one id.
   *
   * A duplicate id is refused rather than shadowed: two channels publishing
   * under one id produce sessions neither of them can address, and the failure
   * shows up as replies going to the wrong chat.
   */
  register(factory: ChannelFactory): void {
    if (this.#started) {
      throw new Error(`Channel "${factory.id}" was registered after the manager started`);
    }
    if (this.#factories.has(factory.id)) {
      throw new Error(`Channel "${factory.id}" is already registered`);
    }
    this.#factories.set(factory.id, factory);
  }

  /**
   * Builds and starts every enabled channel, then the pumps.
   *
   * A channel that throws from `create` or `start` fails the whole call, and
   * anything already started is stopped again — a half-started manager is a
   * process where some channels answer and the rest are silent, with nothing
   * saying which is which.
   */
  async start(): Promise<void> {
    if (this.#started) return;
    this.#started = true;

    try {
      for (const factory of this.#factories.values()) {
        const settings = settingsFor(this.#channelsConfig, factory.id);
        if (flagOf(settings, 'enabled') === false) {
          this.#logger.info({ channel: factory.id }, 'channel disabled by config');
          continue;
        }
        const channel = await factory.create(this.#context(factory.id, settings));
        if (channel.id !== factory.id) {
          throw new Error(
            `Channel factory "${factory.id}" created a channel with id "${channel.id}"`,
          );
        }
        await channel.start?.();
        this.#channels.set(factory.id, channel);
      }
    } catch (error) {
      await this.stop();
      throw error;
    }

    this.#pumps = Promise.all([this.#pumpInbound(), this.#pumpOutbound()]).then(() => undefined);
    this.#logger.info({ channels: [...this.#channels.keys()] }, 'channels started');
  }

  /**
   * Stops everything, in the order that lets replies already produced land.
   *
   * The signal fires first so a channel's own in-flight request unwinds; the
   * bus closes next, which ends the pumps once they have drained what was
   * buffered; and only then are the channels told to disconnect.
   */
  async stop(): Promise<void> {
    this.#lifetime.abort();
    if (this.#ownsBus) this.#bus.close();
    await this.#pumps;
    this.#pumps = undefined;
    await Promise.all([...this.#tails.values()]);
    this.#tails.clear();

    for (const channel of this.#channels.values()) {
      try {
        await channel.stop?.();
      } catch (error) {
        // A transport that cannot say goodbye is not a reason to leave the
        // rest of them running.
        this.#logger.warn({ channel: channel.id, err: error }, 'channel stop failed');
      }
    }
    this.#channels.clear();

    for (const bridged of this.#bridged.values()) bridged.connection.close();
    this.#bridged.clear();
  }

  // -------------------------------------------------------------------------
  // Inbound: channel → bus → hub
  // -------------------------------------------------------------------------

  #context(id: string, settings: Readonly<Record<string, unknown>>): ChannelContext {
    return {
      id,
      settings,
      logger: this.#logger,
      clock: this.#clock,
      signal: this.#lifetime.signal,
      // Bound to this id, so a channel can neither publish as another channel
      // nor reach the outbound queue it does not own.
      publish: (message: ChannelInbound) => this.#bus.publishInbound({ ...message, channelId: id }),
    };
  }

  async #pumpInbound(): Promise<void> {
    for await (const message of this.#bus.inbound()) {
      try {
        this.#toHub(message);
      } catch (error) {
        // The pump is the process's only reader of this queue. A throw that
        // escaped would stop every channel, on one bad message.
        this.#logger.error(
          { channel: message.channelId, sessionKey: message.sessionKey, err: error },
          'inbound message could not be bridged',
        );
      }
    }
  }

  #toHub(message: InboundMessage): void {
    const bridged = this.#connect(message);
    bridged.target = targetOf(message);
    const { text, attachments } = toFrameContent(message.content);

    bridged.connection.receive({
      type: 'user.message',
      sessionKey: bridged.sessionKey,
      content: text,
      attachments,
      // The channel's own id for the message, so a transport that redelivers —
      // every one of them, on a dropped connection — is acked rather than
      // running the same turn twice.
      clientMessageId: message.id,
    });
  }

  /**
   * The hub connection for this message, made if it is the first one.
   *
   * `sessionKey` is namespaced here rather than trusted: see the module header.
   */
  #connect(message: InboundMessage): Bridged {
    const sessionKey = this.#sessionKey(message.channelId, message.sessionKey);
    const key = `${message.channelId} ${sessionKey}`;
    const existing = this.#bridged.get(key);
    if (existing !== undefined) {
      // Re-inserting moves the key to the end, so the map's iteration order is
      // least-recently-used first and eviction needs no second index.
      this.#bridged.delete(key);
      this.#bridged.set(key, existing);
      return existing;
    }

    const bridged: Bridged = {
      key,
      channelId: message.channelId,
      sessionKey,
      target: targetOf(message),
      busy: false,
      projection: new TurnProjection(this.#projectionOptions),
      connection: this.#hub.connect({
        sessionKey,
        channel: message.channelId,
        ...(this.#workspaceId === undefined ? {} : { workspaceId: this.#workspaceId }),
        send: (event) => {
          this.#fromHub(key, event);
        },
      }),
    };
    this.#bridged.set(key, bridged);
    this.#evict(key);
    return bridged;
  }

  #sessionKey(channelId: string, sessionKey: string): string {
    const prefix = `${channelId}:`;
    const key = sessionKey === '' ? 'default' : sessionKey;
    return key.startsWith(prefix) ? key : `${prefix}${key}`;
  }

  /** Drops the least-recently-used idle connections until the cap holds. */
  #evict(exclude: string): void {
    while (this.#bridged.size > this.#maxSessions) {
      let victim: Bridged | undefined;
      for (const bridged of this.#bridged.values()) {
        if (bridged.key === exclude || bridged.busy) continue;
        victim = bridged;
        break;
      }
      // Every remaining pair has a turn in flight. Dropping one would lose the
      // reply it is about to produce, which is worse than being over the cap
      // until it finishes.
      if (victim === undefined) return;
      this.#bridged.delete(victim.key);
      victim.connection.close();
      this.#logger.debug(
        { channel: victim.channelId, sessionKey: victim.sessionKey },
        'evicted idle channel session',
      );
    }
  }

  // -------------------------------------------------------------------------
  // Outbound: hub → bus → channel
  // -------------------------------------------------------------------------

  #fromHub(key: string, event: ServerMessage): void {
    const bridged = this.#bridged.get(key);
    if (bridged === undefined) return;
    if (event.type === 'session.status') bridged.busy = event.busy;

    for (const draft of bridged.projection.project(event)) {
      const result = this.#bus.publishOutbound({
        channelId: bridged.channelId,
        sessionKey: bridged.sessionKey,
        target: bridged.target,
        kind: draft.kind,
        content: [textPart(draft.text)],
        ...(draft.turnId === undefined ? {} : { metadata: { turnId: draft.turnId } }),
      });
      if (result.kind !== 'accepted') {
        this.#logger.warn(
          { channel: bridged.channelId, kind: draft.kind, result: result.kind },
          'outbound message dropped',
        );
      }
    }
  }

  async #pumpOutbound(): Promise<void> {
    for await (const message of this.#bus.outbound()) this.#dispatch(message);
  }

  /** Queues one message behind whatever that channel is already sending. */
  #dispatch(message: OutboundMessage): void {
    const channel = this.#channels.get(message.channelId);
    if (channel === undefined) {
      this.#logger.warn({ channel: message.channelId }, 'outbound message for an unknown channel');
      return;
    }
    const accepts: readonly OutboundKind[] = channel.accepts ?? DEFAULT_ACCEPTED_KINDS;
    if (!accepts.includes(message.kind)) return;

    const tail = this.#tails.get(message.channelId) ?? Promise.resolve();
    this.#tails.set(
      message.channelId,
      tail.then(async () => {
        try {
          await channel.send(message);
        } catch (error) {
          // One failed send, not a dead pump: whether repeating it is safe is a
          // question only the transport's own API can answer.
          this.#logger.warn(
            { channel: message.channelId, kind: message.kind, err: error },
            'channel send failed',
          );
        }
      }),
    );
  }
}
