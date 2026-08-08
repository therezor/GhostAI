/**
 * A clock whose timers fire only when a test says so.
 *
 * Local rather than imported from `@ghostbot/agent/testkit`, following what
 * `packages/tools/test/registry.test.ts` already does: a dev dependency on a
 * package that sits *above* this one in the layer graph would be an upward edge
 * that pnpm's isolated `node_modules` exists to make impossible, and it would
 * be one for forty lines.
 *
 * The assertion it exists for is *cadence*: a reconnect at 1 s, then 2 s, then
 * 4 s, and none before. `pending` is the leak assertion — a connection that has
 * been closed must not leave a timer armed.
 */

import { GhostError, type Clock, type TimerHandle } from '@ghostbot/core';

export interface ManualClock extends Clock {
  /** Moves time forward and fires everything now due, oldest first. */
  advance(ms: number): void;
  /** Timers armed and not yet fired. */
  readonly pending: number;
}

interface PendingTimer {
  readonly at: number;
  readonly callback: () => void;
}

export function manualClock(startMs = 1_700_000_000_000): ManualClock {
  const timers = new Map<number, PendingTimer>();
  let monotonic = 0;
  let nextId = 1;

  return {
    now: () => startMs + monotonic,
    monotonic: () => monotonic,
    setTimeout(callback, delayMs) {
      const id = nextId++;
      timers.set(id, { at: monotonic + delayMs, callback });
      return id as unknown as TimerHandle;
    },
    clearTimeout(handle) {
      timers.delete(handle as unknown as number);
    },
    sleep: (delayMs, signal) => {
      if (signal?.aborted === true) {
        return Promise.reject(new GhostError('aborted', 'Sleep aborted'));
      }
      monotonic += delayMs;
      return Promise.resolve();
    },
    advance(ms) {
      monotonic += ms;
      for (const [id, timer] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
        if (timer.at > monotonic) continue;
        timers.delete(id);
        timer.callback();
      }
    },
    get pending() {
      return timers.size;
    },
  };
}
