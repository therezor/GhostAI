/**
 * The loopback channel: the contract, with the transport removed.
 *
 * Every other channel spends most of its code on someone else's API — long
 * polling, gateway reconnects, message-edit rate limits — and none of that is
 * the contract. This one has no network at all: `say()` is a user typing and
 * `transcript` is the chat window. What is left is exactly the four things a
 * channel does, which is what makes it worth reading before writing a real one:
 *
 *  1. turn transport input into `context.publish({ sessionKey, senderId, content })`;
 *  2. name the conversation, and use the same name every time so the session
 *     is the same session;
 *  3. say where a reply goes, via `metadata.target`;
 *  4. render an `OutboundMessage` in `send()`.
 *
 * It is also what `channelConformance` runs against in this repo, so the suite
 * is checked against a passing implementation rather than only against the
 * channels that come later.
 */

import type {
  Channel,
  ChannelContext,
  ChannelFactory,
} from '@ghostbot/channels';
import {
  textPart,
  type OutboundKind,
  type OutboundMessage,
  type PublishResult,
} from '@ghostbot/core';

/** One line of the conversation, in the order it happened. */
export interface LoopbackEntry {
  readonly direction: 'in' | 'out';
  readonly text: string;
  /** `reply`, `notice`, `error` — and `progress`, since this channel renders it. */
  readonly kind?: OutboundKind;
  readonly sessionKey: string;
}

export interface LoopbackOptions {
  /** The id it publishes under. A second instance needs a second id. */
  readonly id?: string;
  /** The conversation `say()` speaks into. */
  readonly conversation?: string;
  /** Who is typing. The rate-limiting identity, so it is per user. */
  readonly senderId?: string;
}

export interface LoopbackChannel extends Channel {
  /** A user typing. Returns what the bus made of it, rate limit included. */
  say(
    text: string,
    options?: { conversation?: string; senderId?: string },
  ): PublishResult;
  /** Everything said, both directions. */
  readonly transcript: readonly LoopbackEntry[];
  /** Just what the agent said, oldest first — what a test usually asserts on. */
  replies(): string[];
  /** Called for each outbound message, so a caller can render as they arrive. */
  onMessage(listener: (entry: LoopbackEntry) => void): () => void;
}

const DEFAULT_ID = 'loopback';

class Loopback implements LoopbackChannel {
  readonly id: string;
  /**
   * Declared, unlike most channels: an in-memory transcript can hold the answer
   * as it is being written without anyone having to re-read it, which is the
   * case `progress` exists for. A channel that can only post should leave this
   * out and get replies alone.
   */
  readonly accepts: readonly OutboundKind[] = [
    'reply',
    'notice',
    'error',
    'progress',
  ];
  readonly transcript: LoopbackEntry[] = [];

  private readonly context: ChannelContext;
  private readonly conversation: string;
  private readonly senderId: string;
  private readonly listeners = new Set<(entry: LoopbackEntry) => void>();
  private open = false;

  constructor(context: ChannelContext, options: LoopbackOptions) {
    this.id = context.id;
    this.context = context;
    this.conversation = options.conversation ?? 'default';
    this.senderId = options.senderId ?? 'local';
  }

  start(): void {
    this.open = true;
  }

  stop(): void {
    this.open = false;
    this.listeners.clear();
  }

  say(
    text: string,
    options: { conversation?: string; senderId?: string } = {},
  ): PublishResult {
    // A transport that kept accepting input after `stop()` would produce turns
    // whose replies have nowhere to land. The manager's `signal` says the same
    // thing a socket's `close` would.
    if (!this.open || this.context.signal.aborted) return { kind: 'closed' };

    const conversation = options.conversation ?? this.conversation;
    this.transcript.push({ direction: 'in', text, sessionKey: conversation });

    return this.context.publish({
      // The conversation, not the message: a channel that minted a fresh key
      // per message would start a new session for every line the user typed.
      sessionKey: conversation,
      senderId: options.senderId ?? this.senderId,
      content: [textPart(text)],
      // Where the answer goes. A real channel puts its chat id here.
      metadata: { target: conversation },
    });
  }

  send(message: OutboundMessage): void {
    const text = message.content
      .map((part) => (part.type === 'text' ? part.text : `[${part.mimeType}]`))
      .join('');
    const entry: LoopbackEntry = {
      direction: 'out',
      text,
      kind: message.kind,
      sessionKey: message.sessionKey,
    };
    this.transcript.push(entry);
    for (const listener of [...this.listeners]) listener(entry);
  }

  replies(): string[] {
    return this.transcript
      .filter((entry) => entry.direction === 'out' && entry.kind === 'reply')
      .map((entry) => entry.text);
  }

  onMessage(listener: (entry: LoopbackEntry) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

/**
 * The factory the manager registers.
 *
 * A factory rather than an instance because the manager owns the lifecycle: it
 * decides when the channel is built, hands it the settings block and the abort
 * signal, and is the only thing that can bind `publish` to this channel's id.
 */
export function loopbackChannel(options: LoopbackOptions = {}): ChannelFactory {
  const id = options.id ?? DEFAULT_ID;
  return {
    id,
    create: (context) => new Loopback(context, options),
  };
}
