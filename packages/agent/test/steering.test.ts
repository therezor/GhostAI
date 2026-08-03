import { describe, expect, it } from 'vitest';

import { MAX_PENDING_STEER, STEERING_PREFIX, SteeringQueue, steeringText } from '#src/steering.js';

describe('SteeringQueue', () => {
  it('holds messages until the loop drains them', () => {
    const queue = new SteeringQueue();

    expect(queue.hasPending('a')).toBe(false);
    queue.push('a', 'use the other directory', 1000);
    expect(queue.hasPending('a')).toBe(true);

    expect(queue.drain('a')).toEqual([{ content: 'use the other directory', receivedAtMs: 1000 }]);
    expect(queue.hasPending('a')).toBe(false);
    expect(queue.drain('a')).toEqual([]);
  });

  it('keeps sessions apart', () => {
    const queue = new SteeringQueue();

    queue.push('a', 'for a', 1);
    queue.push('b', 'for b', 2);

    expect(queue.size).toBe(2);
    expect(queue.drain('a').map((message) => message.content)).toEqual(['for a']);
    expect(queue.hasPending('b')).toBe(true);
  });

  it('drops the oldest when a session floods it', () => {
    const queue = new SteeringQueue({ maxPending: 2 });

    queue.push('a', 'first', 1);
    queue.push('a', 'second', 2);
    queue.push('a', 'third', 3);

    // The newest correction is the one the user is waiting on.
    expect(queue.drain('a').map((message) => message.content)).toEqual(['second', 'third']);
  });

  it('defaults to a bounded queue', () => {
    const queue = new SteeringQueue();

    for (let index = 0; index <= MAX_PENDING_STEER; index += 1) {
      queue.push('a', `message ${String(index)}`, index);
    }

    expect(queue.drain('a')).toHaveLength(MAX_PENDING_STEER);
  });

  it('forgets a session on clear', () => {
    const queue = new SteeringQueue();

    queue.push('a', 'pending', 1);
    queue.clear('a');

    expect(queue.hasPending('a')).toBe(false);
    expect(queue.size).toBe(0);
  });
});

describe('steeringText', () => {
  it('marks the message as an interruption rather than a new request', () => {
    const text = steeringText({ content: 'no, the other one', receivedAtMs: 1 });

    expect(text.startsWith(STEERING_PREFIX)).toBe(true);
    expect(text).toContain('no, the other one');
  });
});
