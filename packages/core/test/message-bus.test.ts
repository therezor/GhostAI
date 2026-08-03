import { describe, expect, it } from 'vitest';

import type { ContentPart } from '@ghostai/protocol';

import type { Clock } from '#src/clock.js';
import {
  MessageBus,
  RateLimiter,
  type InboundMessage,
} from '#src/message-bus.js';
import { textPart } from '#src/messages.js';

const NOW = 1_700_000_000_000;

/** Wall and monotonic time advance together, under the test's control. */
class TestClock implements Clock {
  wall = NOW;
  mono = 0;

  now(): number {
    return this.wall;
  }

  monotonic(): number {
    return this.mono;
  }

  advance(ms: number): void {
    this.wall += ms;
    this.mono += ms;
  }

  setTimeout(
    callback: () => void,
    delayMs: number,
  ): ReturnType<typeof globalThis.setTimeout> {
    return globalThis.setTimeout(callback, delayMs);
  }

  clearTimeout(handle: ReturnType<typeof globalThis.setTimeout>): void {
    globalThis.clearTimeout(handle);
  }

  sleep(): Promise<void> {
    return Promise.resolve();
  }
}

function counterIds(): () => string {
  let n = 0;
  return () => `id${String(++n)}`;
}

const hello: readonly ContentPart[] = [textPart('hello')];

function makeBus(
  options: Partial<ConstructorParameters<typeof MessageBus>[0]> = {},
): MessageBus {
  return new MessageBus({
    clock: new TestClock(),
    newId: counterIds(),
    ...options,
  });
}

const inboundInput = {
  channelId: 'telegram',
  sessionKey: 'telegram:42',
  senderId: 'user-1',
  content: hello,
};

describe('publishing inbound', () => {
  it('accepts a message and stamps it', async () => {
    const bus = makeBus();
    expect(bus.publishInbound(inboundInput)).toEqual({
      kind: 'accepted',
      id: 'id1',
    });

    const received = await bus.inbound().next();
    expect(received.value).toEqual({
      id: 'id1',
      channelId: 'telegram',
      sessionKey: 'telegram:42',
      senderId: 'user-1',
      content: hello,
      receivedAtMs: NOW,
      metadata: {},
    });
  });

  it('keeps a channel-supplied id for idempotency', () => {
    const bus = makeBus();
    expect(bus.publishInbound({ ...inboundInput, id: 'tg-991' })).toEqual({
      kind: 'accepted',
      id: 'tg-991',
    });
  });

  it('carries channel metadata through', async () => {
    const bus = makeBus();
    bus.publishInbound({ ...inboundInput, metadata: { topicId: 7 } });
    const received = await bus.inbound().next();
    expect((received.value as InboundMessage).metadata).toEqual({ topicId: 7 });
  });

  it('refuses once the queue is full', () => {
    const bus = makeBus({ capacity: 2 });
    expect(bus.publishInbound(inboundInput).kind).toBe('accepted');
    expect(bus.publishInbound(inboundInput).kind).toBe('accepted');
    expect(bus.publishInbound(inboundInput)).toEqual({
      kind: 'queue_full',
      queued: 2,
    });
    expect(bus.inboundSize).toBe(2);
  });

  it('refuses after close', () => {
    const bus = makeBus();
    bus.close();
    expect(bus.publishInbound(inboundInput)).toEqual({ kind: 'closed' });
    expect(bus.closed).toBe(true);
  });
});

describe('publishing outbound', () => {
  it('defaults to a reply', async () => {
    const bus = makeBus();
    bus.publishOutbound({
      channelId: 'telegram',
      sessionKey: 'telegram:42',
      target: '42',
      content: hello,
    });

    const received = await bus.outbound().next();
    expect(received.value).toMatchObject({
      kind: 'reply',
      target: '42',
      createdAtMs: NOW,
    });
  });

  it('carries an explicit kind', async () => {
    const bus = makeBus();
    bus.publishOutbound({
      channelId: 'web',
      sessionKey: 'web:1',
      target: 'socket-1',
      content: hello,
      kind: 'progress',
    });
    expect((await bus.outbound().next()).value).toMatchObject({
      kind: 'progress',
    });
  });

  it('is not rate limited — pacing belongs to the channel', () => {
    const bus = makeBus({ rateLimit: { perMinute: 1, burst: 1 } });
    const out = {
      channelId: 'telegram',
      sessionKey: 'telegram:42',
      target: '42',
      content: hello,
    };
    expect(bus.publishOutbound(out).kind).toBe('accepted');
    expect(bus.publishOutbound(out).kind).toBe('accepted');
    expect(bus.outboundSize).toBe(2);
  });

  it('refuses after close', () => {
    const bus = makeBus();
    bus.close();
    expect(
      bus.publishOutbound({
        channelId: 'web',
        sessionKey: 'web:1',
        target: 's',
        content: hello,
      }),
    ).toEqual({ kind: 'closed' });
  });
});

describe('consuming', () => {
  it('delivers a message published after the consumer started waiting', async () => {
    const bus = makeBus();
    const pending = bus.inbound().next();
    bus.publishInbound(inboundInput);

    expect((await pending).done).toBe(false);
  });

  it('delivers each message to exactly one of several consumers', async () => {
    const bus = makeBus();
    const first = bus.inbound().next();
    const second = bus.inbound().next();

    bus.publishInbound({ ...inboundInput, id: 'a' });
    bus.publishInbound({ ...inboundInput, id: 'b' });

    const ids = [await first, await second].map(
      (r) => (r.value as InboundMessage).id,
    );
    expect(ids.sort()).toEqual(['a', 'b']);
    expect(bus.inboundSize).toBe(0);
  });

  it('drains buffered messages after close, then ends', async () => {
    const bus = makeBus();
    bus.publishInbound({ ...inboundInput, id: 'a' });
    bus.close();

    const iterator = bus.inbound();
    expect((await iterator.next()).value).toMatchObject({ id: 'a' });
    expect(await iterator.next()).toEqual({ value: undefined, done: true });
  });

  it('releases a waiting consumer on close so shutdown does not hang', async () => {
    const bus = makeBus();
    const pending = bus.inbound().next();
    bus.close();
    expect(await pending).toEqual({ value: undefined, done: true });
  });

  it('ends a for-await loop when the bus closes', async () => {
    const bus = makeBus();
    bus.publishInbound({ ...inboundInput, id: 'a' });
    bus.publishInbound({ ...inboundInput, id: 'b' });
    bus.close();

    const seen: string[] = [];
    for await (const message of bus.inbound()) seen.push(message.id);
    expect(seen).toEqual(['a', 'b']);
  });

  it('lets one consumer break without disturbing the queue', async () => {
    const bus = makeBus();
    bus.publishInbound({ ...inboundInput, id: 'a' });
    bus.publishInbound({ ...inboundInput, id: 'b' });

    for await (const message of bus.inbound()) {
      expect(message.id).toBe('a');
      break;
    }

    // `b` is still queued and still deliverable to the next consumer.
    expect(bus.inboundSize).toBe(1);
    expect((await bus.inbound().next()).value).toMatchObject({ id: 'b' });
  });

  it('keeps the two directions independent', () => {
    const bus = makeBus();
    bus.publishInbound(inboundInput);
    expect(bus.inboundSize).toBe(1);
    expect(bus.outboundSize).toBe(0);
  });
});

describe('rate limiting', () => {
  it('is disabled by default', () => {
    const limiter = new RateLimiter({}, new TestClock());
    expect(limiter.enabled).toBe(false);
    for (let i = 0; i < 100; i++) {
      expect(limiter.consume('user-1')).toBeUndefined();
    }
  });

  it('allows a burst and then refuses', () => {
    const limiter = new RateLimiter(
      { perMinute: 60, burst: 3 },
      new TestClock(),
    );
    expect(limiter.consume('u')).toBeUndefined();
    expect(limiter.consume('u')).toBeUndefined();
    expect(limiter.consume('u')).toBeUndefined();
    expect(limiter.consume('u')).toBeGreaterThan(0);
  });

  it('reports how long until the next token', () => {
    const clock = new TestClock();
    const limiter = new RateLimiter({ perMinute: 60, burst: 1 }, clock);
    limiter.consume('u');
    // 60/minute is one per second, and the bucket was just emptied.
    expect(limiter.consume('u')).toBe(1_000);
  });

  it('refills over time', () => {
    const clock = new TestClock();
    const limiter = new RateLimiter({ perMinute: 60, burst: 1 }, clock);
    limiter.consume('u');
    expect(limiter.consume('u')).toBeGreaterThan(0);

    clock.advance(1_000);
    expect(limiter.consume('u')).toBeUndefined();
  });

  it('never refills past the burst ceiling', () => {
    const clock = new TestClock();
    const limiter = new RateLimiter({ perMinute: 60, burst: 2 }, clock);
    clock.advance(600_000);

    expect(limiter.consume('u')).toBeUndefined();
    expect(limiter.consume('u')).toBeUndefined();
    expect(limiter.consume('u')).toBeGreaterThan(0);
  });

  it('meters each sender separately', () => {
    const limiter = new RateLimiter(
      { perMinute: 60, burst: 1 },
      new TestClock(),
    );
    expect(limiter.consume('a')).toBeUndefined();
    expect(limiter.consume('b')).toBeUndefined();
    expect(limiter.consume('a')).toBeGreaterThan(0);
  });

  it('defaults the burst to the rate, capped at ten', () => {
    const generous = new RateLimiter({ perMinute: 600 }, new TestClock());
    for (let i = 0; i < 10; i++) expect(generous.consume('u')).toBeUndefined();
    expect(generous.consume('u')).toBeGreaterThan(0);
  });

  it('allows at least one message even at a rate below one per minute', () => {
    const limiter = new RateLimiter({ perMinute: 0.5 }, new TestClock());
    expect(limiter.consume('u')).toBeUndefined();
    expect(limiter.consume('u')).toBeGreaterThan(0);
  });

  it('treats a negative rate as disabled rather than as a lockout', () => {
    const limiter = new RateLimiter({ perMinute: -5 }, new TestClock());
    expect(limiter.enabled).toBe(false);
    expect(limiter.consume('u')).toBeUndefined();
  });

  it('reclaims refilled buckets once the map grows past the ceiling', () => {
    const clock = new TestClock();
    const limiter = new RateLimiter({ perMinute: 60_000, burst: 2 }, clock);

    for (let i = 0; i <= RateLimiter.MAX_TRACKED_SENDERS; i++) {
      clock.advance(10); // enough to refill every bucket to full
      limiter.consume(`sender-${String(i)}`);
    }

    // Full buckets are indistinguishable from absent ones, so almost all of
    // them are reclaimable and the map collapses rather than merely capping.
    expect(limiter.trackedSenders).toBeLessThan(10);
  });

  it('stays bounded even when nothing is reclaimable', () => {
    // Time frozen, so no bucket ever refills — the LRU pass is the only thing
    // standing between a flood of distinct senders and unbounded memory.
    const limiter = new RateLimiter(
      { perMinute: 60, burst: 2 },
      new TestClock(),
    );
    for (let i = 0; i < RateLimiter.MAX_TRACKED_SENDERS + 500; i++) {
      limiter.consume(`sender-${String(i)}`);
    }
    expect(limiter.trackedSenders).toBe(RateLimiter.MAX_TRACKED_SENDERS);
  });

  it('evicts the least recently used sender, not the most recent', () => {
    const limiter = new RateLimiter(
      { perMinute: 60, burst: 2 },
      new TestClock(),
    );
    limiter.consume('early');
    for (let i = 0; i < RateLimiter.MAX_TRACKED_SENDERS; i++) {
      limiter.consume(`sender-${String(i)}`);
    }

    // `early` was evicted, so its bucket starts full again — fail-open by
    // design, and the alternative would let a flood lock out real users.
    expect(limiter.consume('early')).toBeUndefined();
    expect(limiter.consume('early')).toBeUndefined();
  });

  it('surfaces a refusal through the bus as a value, not a throw', () => {
    const bus = makeBus({ rateLimit: { perMinute: 60, burst: 1 } });
    expect(bus.publishInbound(inboundInput).kind).toBe('accepted');

    const refused = bus.publishInbound(inboundInput);
    expect(refused.kind).toBe('rate_limited');
    if (refused.kind !== 'rate_limited') throw new Error('expected a refusal');
    expect(refused.retryAfterMs).toBeGreaterThan(0);
    // Refused messages must not reach the agent.
    expect(bus.inboundSize).toBe(1);
  });
});
