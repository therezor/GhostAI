/**
 * What a channel is.
 *
 * A channel owns one transport — a Telegram bot, a Discord gateway, an SMTP
 * mailbox, a loopback array in a test — and nothing else. It turns whatever
 * arrives there into an `InboundMessage`, and renders `OutboundMessage`s back
 * onto it. It never sees `AgentLoop`, never sees a session store and never sees
 * the hub: everything it can reach is on the `ChannelContext` it is handed, and
 * that is deliberately four things.
 *
 * Two decisions in the shape are worth stating, because both close a hole a
 * plugin channel would otherwise be able to walk through:
 *
 *  - **A channel publishes through `context.publish`, not through the bus.**
 *    Handing a channel the `MessageBus` would hand it `publishOutbound` — the
 *    ability to speak as the agent — and `outbound()`, whose iterator is
 *    *competing-consumer*: a channel that drained it would silently take
 *    another channel's replies out of the queue. `publish` stamps the channel's
 *    own id, so a channel cannot forge one either.
 *
 *  - **A channel declares the kinds it renders.** `progress` carries the answer
 *    as it is being written, for a transport that can edit a message in place;
 *    a transport that can only post would repeat the whole answer twice, once
 *    in pieces and once whole. Rather than trusting every channel author to
 *    know that, `accepts` states it and the manager filters — so the default is
 *    the one that cannot look broken.
 *
 * ## Attachments
 *
 * **An attachment is a file in the workspace.** A channel that receives one
 * writes the bytes there and publishes a `FilePart` naming the path; it does
 * not publish inline bytes and it does not publish a URL. That is the same
 * thing a browser upload produces, so a photo sent to a bot and a photo dropped
 * on the web composer travel one code path from here down — and a path, unlike
 * a URL, is still resolvable when the conversation is replayed next month.
 *
 * The gap this leaves is deliberate and not yet filled: `ChannelContext` has no
 * filesystem, so a channel *cannot* write to the workspace today. The seam when
 * one needs to is a fifth member here, supplied by the manager against a jail
 * exactly as `publish` is supplied against the bus —
 *
 * ```ts
 * readonly attach: (file: {
 *   readonly name: string;
 *   readonly mimeType: string;
 *   readonly bytes: Uint8Array;
 * }) => Promise<{ readonly path: string; readonly sizeBytes: number }>;
 * ```
 *
 * — which keeps a channel as far from the filesystem as it is from the bus. A
 * Telegram bot would then be: `getFile`, download, `attach`, publish a
 * `FilePart`. It is written down rather than built because no channel produces
 * an image yet, and an unused port with a wiring site and a test is cost with
 * no reader.
 */

import type {
  Clock,
  InboundMessageInput,
  Logger,
  OutboundKind,
  OutboundMessage,
  PublishResult,
} from '@ghostai/core';
import type { ClientMessage } from '@ghostai/protocol';

/**
 * An inbound message as a channel writes it: everything but the `channelId`,
 * which the manager stamps.
 */
export type ChannelInbound = Omit<InboundMessageInput, 'channelId'>;

/**
 * The frames a channel may send that are not a message somebody typed.
 *
 * Deliberately five, rather than "everything except `user.message`". The three
 * that are missing — `session.new`, `session.switch`, `session.resume` — move
 * the *connection*, and the manager derives a session from what the channel
 * publishes: a channel that sent one would move where its events arrive while
 * its next message still went to the old conversation, and the two halves would
 * disagree with nothing to say so. A channel changes conversation by publishing
 * a different `sessionKey`, which is the same thing the loopback channel's
 * `conversation` option does.
 *
 * `ping` and `audio.transcribe` are absent because neither means anything here:
 * there is no socket to keep alive, and no channel produces audio yet.
 */
export type ChannelControlFrame = Extract<
  ClientMessage,
  {
    readonly type:
      | 'tool.approve'
      | 'turn.stop'
      | 'turn.steer'
      | 'turn.regenerate'
      | 'user.edit';
  }
>;

/** A control frame, addressed to one of this channel's own conversations. */
export interface ChannelControl {
  /**
   * The conversation it is about, namespaced by the manager exactly as the one
   * on `publish` is.
   *
   * Required even for `tool.approve`, which carries no session of its own: the
   * manager delivers on a connection, and this is what names which.
   */
  readonly sessionKey: string;
  /** Where a reply this produces goes. Defaults to `sessionKey`. */
  readonly target?: string;
  readonly frame: ChannelControlFrame;
}

/**
 * What the manager gives a channel, and the whole of what a channel may reach.
 */
export interface ChannelContext {
  /** The id this channel publishes under. Matches its factory. */
  readonly id: string;
  /**
   * This channel's block of `config.channels`, unparsed.
   *
   * `ChannelsConfigSchema` is a `looseObject` precisely so that installing a
   * channel plugin does not require a schema change in `@ghostai/protocol`, so
   * the channel parses its own settings — with its own Zod schema, if it has
   * one — and reports a bad block by refusing to start.
   */
  readonly settings: Readonly<Record<string, unknown>>;
  readonly logger: Logger;
  readonly clock: Clock;
  /**
   * Fires when the manager stops, before `stop()` is called.
   *
   * A long-poll or a reconnect backoff should hang off this rather than off a
   * flag the channel sets in `stop()` — by then it is already too late for a
   * request that is in flight.
   */
  readonly signal: AbortSignal;
  /**
   * Hands a user message to the agent. Rate limiting is applied here.
   *
   * A property rather than a method so a channel can destructure it — it is
   * already bound to this channel's id, and that binding is the whole point.
   */
  readonly publish: (message: ChannelInbound) => PublishResult;
  /**
   * The frames a browser sends that are not messages, on this channel's own
   * conversation. This is what lets a transport answer an approval, stop a
   * turn, or re-run one.
   *
   * The fifth member the header above anticipated, and supplied the same way
   * `publish` is: the manager namespaces the `sessionKey` and rewrites it into
   * the frame, so a channel can no more drive another channel's conversation
   * through here than it can forge a `channelId` through `publish`. That
   * symmetry is the whole reason this is a member rather than a hub handed over
   * at construction.
   *
   * Does not go through the bus. The bus queues *content* — a message and a
   * reply — and applies a per-sender rate limit to it; a stop is not content,
   * and a stop that queued behind the turn it is trying to stop would never
   * arrive in time to do anything.
   */
  readonly control: (command: ChannelControl) => void;
}

/** Kinds delivered to a channel that does not say which it renders. */
export const DEFAULT_ACCEPTED_KINDS: readonly OutboundKind[] = [
  'reply',
  'notice',
  'error',
];

export interface Channel {
  /** Matches the factory's id and the `channelId` of everything it publishes. */
  readonly id: string;
  /**
   * The outbound kinds this transport renders. Defaults to everything but
   * `progress` — see the module header for why that one is opt-in.
   */
  readonly accepts?: readonly OutboundKind[];
  /**
   * Connects. Throwing here fails the manager's `start()`, which is what makes
   * a bad token a startup error rather than a channel that is silently dead.
   */
  start?(): Promise<void> | void;
  /**
   * Renders one message on the transport.
   *
   * A throw is logged and dropped: one Telegram edit that 429s must not stop
   * the pump that feeds every other channel. Retrying is the channel's own
   * decision, because only it knows what its API says about repeating a send.
   */
  send(message: OutboundMessage): Promise<void> | void;
  /** Disconnects. Called once, and after `context.signal` has already fired. */
  stop?(): Promise<void> | void;
}

/**
 * How a channel is built.
 *
 * The indirection is what lets the manager own the lifecycle — settings,
 * logger, abort signal, the publish function bound to this id — and it is the
 * same contract a plugin's `registerChannel` will hand over in Phase 4. The
 * built-in channels consume it too, so it cannot rot.
 */
export interface ChannelFactory {
  readonly id: string;
  create(context: ChannelContext): Channel | Promise<Channel>;
}
