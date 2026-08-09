/**
 * The channel ⇄ agent boundary.
 *
 * Channels never call the agent and the agent never calls a channel. A channel
 * publishes an `InboundMessage` and consumes `OutboundMessage`s addressed to
 * it; the agent does the mirror image. That decoupling is what makes Telegram,
 * the web UI, the scheduler and any extension channel interchangeable — and it is
 * what stops the agent loop from acquiring an import back into the transport
 * layer, which is the cycle this architecture exists to prevent.
 *
 * Rate limiting lives here rather than in each channel because it is the same
 * policy everywhere and an extension author must not be able to omit it. It applies
 * to inbound traffic only: outbound pacing is a per-channel concern (Telegram's
 * edit interval, a websocket's backpressure) with rules the bus cannot know.
 */

import { newUuid, type ContentPart } from '@ghostwire/protocol';

import { systemClock, type Clock } from './clock.js';

/** What a channel hands the agent. */
export interface InboundMessage {
  readonly id: string;
  /** Channel that produced it — `web`, `telegram`, an extension id. */
  readonly channelId: string;
  readonly sessionKey: string;
  /** Rate-limiting identity. Per *user*, not per session or per channel. */
  readonly senderId: string;
  readonly content: readonly ContentPart[];
  readonly receivedAtMs: number;
  /** Channel-specific context: message ids, topic ids, reply targets. */
  readonly metadata: Readonly<Record<string, unknown>>;
}

/**
 * Why an outbound message is being sent.
 *
 * Channels render these differently — Telegram edits a `progress` message in
 * place and posts a `reply` as a new one — and a channel that does not
 * distinguish them can treat every kind as a reply.
 */
export type OutboundKind = 'reply' | 'progress' | 'notice' | 'error';

export interface OutboundMessage {
  readonly id: string;
  readonly channelId: string;
  readonly sessionKey: string;
  /** Channel-specific destination: chat id, user id, room, socket id. */
  readonly target: string;
  readonly content: readonly ContentPart[];
  readonly kind: OutboundKind;
  readonly createdAtMs: number;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface InboundMessageInput {
  readonly channelId: string;
  readonly sessionKey: string;
  readonly senderId: string;
  readonly content: readonly ContentPart[];
  readonly metadata?: Readonly<Record<string, unknown>>;
  /** Supplied only when the channel has its own idempotency key. */
  readonly id?: string;
}

interface OutboundMessageInput {
  readonly channelId: string;
  readonly sessionKey: string;
  readonly target: string;
  readonly content: readonly ContentPart[];
  readonly kind?: OutboundKind;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly id?: string;
}

/**
 * The outcome of a publish, as a value.
 *
 * A rejected publish is an ordinary, expected result — a user typing too fast
 * is not an exception — and the caller has to tell the three cases apart to
 * respond correctly: back off, shed load, or stop sending entirely. A thrown
 * error would collapse them into one string.
 */
export type PublishResult =
  | { readonly kind: 'accepted'; readonly id: string }
  | { readonly kind: 'rate_limited'; readonly retryAfterMs: number }
  | { readonly kind: 'queue_full'; readonly queued: number }
  | { readonly kind: 'closed' };

/**
 * An async queue with competing consumers.
 *
 * Each item goes to exactly one iterator, which is what makes several workers
 * draining `outbound()` a load-sharing pool rather than a fan-out that delivers
 * every message N times. Broadcast is deliberately not offered: the two look
 * identical at the call site and differ only in whether a user gets one reply
 * or four.
 */
class AsyncQueue<T> {
  private readonly items: T[] = [];
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = [];
  private readonly capacity: number;
  private isClosed = false;

  constructor(capacity: number) {
    this.capacity = capacity;
  }

  get size(): number {
    return this.items.length;
  }

  get closed(): boolean {
    return this.isClosed;
  }

  /** `false` when the queue is closed or at capacity. */
  push(item: T): boolean {
    if (this.isClosed) return false;
    const waiter = this.waiters.shift();
    if (waiter !== undefined) {
      waiter({ value: item, done: false });
      return true;
    }
    if (this.items.length >= this.capacity) return false;
    this.items.push(item);
    return true;
  }

  close(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    // Buffered items stay readable — a consumer draining after close still
    // gets them, so a graceful shutdown can flush replies already produced.
    // Waiting consumers are what must be released: an idle `for await` would
    // otherwise hold the process open forever.
    while (this.waiters.length > 0) {
      this.waiters.shift()?.({ value: undefined, done: true });
    }
  }

  iterator(): AsyncIterableIterator<T> {
    const next = (): Promise<IteratorResult<T>> => {
      const item = this.items.shift();
      if (item !== undefined) {
        return Promise.resolve({ value: item, done: false });
      }
      if (this.isClosed) {
        return Promise.resolve({ value: undefined, done: true });
      }
      return new Promise<IteratorResult<T>>((resolve) =>
        this.waiters.push(resolve),
      );
    };

    return {
      next,
      // Called when a consumer `break`s or `return`s out of `for await`. Only
      // this consumer stops; the queue and its other consumers are untouched.
      return: (): Promise<IteratorResult<T>> =>
        Promise.resolve({ value: undefined, done: true }),
      [Symbol.asyncIterator](): AsyncIterableIterator<T> {
        return this;
      },
    };
  }
}

interface RateLimitOptions {
  /** Messages per sender per minute. `0` disables the limit. */
  readonly perMinute?: number;
  /** Messages allowed back-to-back. Defaults to `perMinute`, capped at 10. */
  readonly burst?: number;
}

interface TokenBucket {
  tokens: number;
  lastRefillMs: number;
}

/**
 * A per-sender token bucket.
 *
 * A bucket rather than a fixed window because chat traffic is bursty by nature
 * — a user sends three messages in two seconds, then nothing for a minute — and
 * a fixed window either rejects that legitimate burst or, sized to allow it,
 * permits twice the intended rate across a window boundary.
 *
 * Refill is driven by `Clock.monotonic()`, so an NTP correction cannot hand a
 * sender a free reset or freeze one out for hours.
 */
export class RateLimiter {
  private readonly buckets = new Map<string, TokenBucket>();
  private readonly perMinute: number;
  private readonly capacity: number;
  private readonly clock: Clock;

  /**
   * A hard ceiling on tracked senders, not a target.
   *
   * Buckets are per sender and a public group has an unbounded supply of
   * those, so this has to bound memory even in the case where nothing is
   * reclaimable — otherwise the eviction pass runs on every message, finds
   * nothing, and the map grows anyway. `#evict` therefore always gets the map
   * back under the ceiling.
   */
  static readonly MAX_TRACKED_SENDERS = 10_000;

  constructor(options: RateLimitOptions = {}, clock: Clock = systemClock) {
    this.perMinute = Math.max(0, options.perMinute ?? 0);
    this.capacity = Math.max(1, options.burst ?? Math.min(this.perMinute, 10));
    this.clock = clock;
  }

  get enabled(): boolean {
    return this.perMinute > 0;
  }

  get trackedSenders(): number {
    return this.buckets.size;
  }

  /** `undefined` when allowed; otherwise how long until one token is available. */
  consume(senderId: string): number | undefined {
    if (!this.enabled) return undefined;

    const now = this.clock.monotonic();
    const perMs = this.perMinute / 60_000;
    const existing = this.buckets.get(senderId);
    const bucket = existing ?? { tokens: this.capacity, lastRefillMs: now };

    bucket.tokens = Math.min(
      this.capacity,
      bucket.tokens + (now - bucket.lastRefillMs) * perMs,
    );
    bucket.lastRefillMs = now;

    const allowed = bucket.tokens >= 1;
    if (allowed) bucket.tokens -= 1;

    // Re-inserting moves the key to the end, so the map's own iteration order
    // is least-recently-used first and `#evict` needs no separate index.
    if (existing !== undefined) this.buckets.delete(senderId);
    this.buckets.set(senderId, bucket);
    if (this.buckets.size > RateLimiter.MAX_TRACKED_SENDERS) this.evict();

    return allowed ? undefined : Math.ceil((1 - bucket.tokens) / perMs);
  }

  /**
   * Gets the map back under the ceiling, in two passes.
   *
   * Refilled buckets go first: they are indistinguishable from a sender that
   * was never seen, so dropping them changes nothing. If that is not enough —
   * a flood of distinct senders, which is what an abuse case looks like — the
   * least recently used are dropped as well.
   *
   * That second pass is deliberately fail-open. An evicted sender's next
   * message is treated as their first, so the worst case is that an attacker
   * spending one sender identity per message evades a per-sender limit — which
   * they could do anyway, by definition. Failing closed would instead let them
   * lock out real users by flooding them out of the map, and unbounded growth
   * would let them take the process down outright.
   */
  private evict(): void {
    const now = this.clock.monotonic();
    const perMs = this.perMinute / 60_000;

    for (const [senderId, bucket] of this.buckets) {
      // Project the refill forward to now. `bucket.tokens` is only recomputed
      // when *that* sender sends, so a bucket idle long enough to be full
      // still holds the level it had at its last message — testing the stored
      // value directly would reclaim almost nothing.
      if (
        bucket.tokens + (now - bucket.lastRefillMs) * perMs >=
        this.capacity
      ) {
        this.buckets.delete(senderId);
      }
    }
    for (const senderId of this.buckets.keys()) {
      if (this.buckets.size <= RateLimiter.MAX_TRACKED_SENDERS) break;
      this.buckets.delete(senderId);
    }
  }
}

export interface MessageBusOptions {
  readonly clock?: Clock;
  readonly newId?: () => string;
  /**
   * Messages buffered per direction before publishes are refused.
   *
   * Bounded on purpose. An unbounded queue in front of a component that can
   * stall — a provider that stopped responding, a channel that lost its socket
   * — converts a stall into unbounded memory growth, and the process dies with
   * no indication of which component stopped consuming.
   */
  readonly capacity?: number;
  readonly rateLimit?: RateLimitOptions;
}

export class MessageBus {
  private readonly inboundQueue: AsyncQueue<InboundMessage>;
  private readonly outboundQueue: AsyncQueue<OutboundMessage>;
  private readonly limiter: RateLimiter;
  private readonly clock: Clock;
  private readonly newId: () => string;

  constructor(options: MessageBusOptions = {}) {
    this.clock = options.clock ?? systemClock;
    this.newId = options.newId ?? newUuid;
    const capacity = options.capacity ?? 1_000;
    this.inboundQueue = new AsyncQueue<InboundMessage>(capacity);
    this.outboundQueue = new AsyncQueue<OutboundMessage>(capacity);
    this.limiter = new RateLimiter(options.rateLimit ?? {}, this.clock);
  }

  get inboundSize(): number {
    return this.inboundQueue.size;
  }

  get outboundSize(): number {
    return this.outboundQueue.size;
  }

  get closed(): boolean {
    return this.inboundQueue.closed;
  }

  publishInbound(input: InboundMessageInput): PublishResult {
    if (this.inboundQueue.closed) return { kind: 'closed' };

    const retryAfterMs = this.limiter.consume(input.senderId);
    if (retryAfterMs !== undefined) {
      return { kind: 'rate_limited', retryAfterMs };
    }

    const message: InboundMessage = {
      id: input.id ?? this.newId(),
      channelId: input.channelId,
      sessionKey: input.sessionKey,
      senderId: input.senderId,
      content: input.content,
      receivedAtMs: this.clock.now(),
      metadata: input.metadata ?? {},
    };

    return this.inboundQueue.push(message)
      ? { kind: 'accepted', id: message.id }
      : { kind: 'queue_full', queued: this.inboundQueue.size };
  }

  /** Not rate limited — outbound pacing belongs to the channel that sends it. */
  publishOutbound(input: OutboundMessageInput): PublishResult {
    if (this.outboundQueue.closed) return { kind: 'closed' };

    const message: OutboundMessage = {
      id: input.id ?? this.newId(),
      channelId: input.channelId,
      sessionKey: input.sessionKey,
      target: input.target,
      content: input.content,
      kind: input.kind ?? 'reply',
      createdAtMs: this.clock.now(),
      metadata: input.metadata ?? {},
    };

    return this.outboundQueue.push(message)
      ? { kind: 'accepted', id: message.id }
      : { kind: 'queue_full', queued: this.outboundQueue.size };
  }

  /** Consumed by the agent. Ends when the bus closes. */
  inbound(): AsyncIterableIterator<InboundMessage> {
    return this.inboundQueue.iterator();
  }

  /** Consumed by the channel manager. Ends when the bus closes. */
  outbound(): AsyncIterableIterator<OutboundMessage> {
    return this.outboundQueue.iterator();
  }

  /** Ends every active iterator so shutdown does not hang on a `for await`. */
  close(): void {
    this.inboundQueue.close();
    this.outboundQueue.close();
  }
}
