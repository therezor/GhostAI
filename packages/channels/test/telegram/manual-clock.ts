/**
 * A clock a test moves by hand.
 *
 * Local rather than imported from `@ghostwire/agent/testkit` or `@ghostwire/mcp`'s,
 * for the reason both of those give for having their own: a dev dependency on a
 * package *above* this one in the layer graph is an upward edge that pnpm's
 * isolated `node_modules` exists to make impossible, and it would be one for
 * forty lines.
 *
 * Two things it buys here. Callback tokens expire on wall time, so a test can
 * step past a deadline instead of sleeping through one. And `sleep` advances
 * rather than waits — which is what lets the poll loop's backoff be asserted as
 * a *cadence* (1s, 2s, 4s…) in a suite that finishes in milliseconds.
 */

import { GhostError, type Clock, type TimerHandle } from '@ghostwire/core';

export interface ManualClock extends Clock {
  /** Moves time forward and fires everything now due, oldest first. */
  advance(ms: number): void;
  /** Every `sleep` asked for, in order. The backoff cadence, as data. */
  readonly slept: readonly number[];
  /** Timers armed and not yet fired — the leak assertion. */
  readonly pending: number;
}

interface PendingTimer {
  readonly at: number;
  readonly callback: () => void;
}

export function manualClock(startMs = 1_700_000_000_000): ManualClock {
  const timers = new Map<number, PendingTimer>();
  const slept: number[] = [];
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
      // Rejecting on an already-aborted signal is the real clock's contract,
      // and the poll loop's shutdown path depends on it.
      if (signal?.aborted === true) {
        return Promise.reject(new GhostError('aborted', 'Sleep aborted'));
      }
      slept.push(delayMs);
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
    get slept() {
      return slept;
    },
    get pending() {
      return timers.size;
    },
  };
}
