/**
 * A clock whose timers fire only when a test says so.
 *
 * The loop awaits a race between a running tool and a heartbeat timer, and the
 * assertion a heartbeat test wants to make is about *cadence*: two progress
 * events at 15 s and 30 s, none before. `vi.useFakeTimers()` can express that,
 * but only by interleaving `advanceTimersByTimeAsync` with the generator's own
 * `next()` — and a clock that is a parameter says it directly, with the
 * advance sitting between starting the step and awaiting it.
 *
 * `now` and `monotonic` advance together here, which they do not in life. That
 * is the point of separating them in the interface: a test that wants an NTP
 * step can set `now` independently.
 */

import { GhostError, type Clock, type TimerHandle } from '@ghostai/core';

export interface ManualClock extends Clock {
  /** Moves time forward and fires everything now due, oldest first. */
  advance(ms: number): void;
  /** Timers armed and not yet fired. A leak assertion. */
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
