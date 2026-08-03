/**
 * A clock that records sleeps instead of taking them.
 *
 * The alternative — `vi.useFakeTimers()` — works, and costs a `runAllTimersAsync`
 * dance around every await in the code under test. Retry backoff is the one place
 * where what a test wants to assert *is* the delay, so a clock that returns the
 * schedule as data says it directly: `expect(clock.sleeps).toEqual([2000])`.
 */

import type { Clock } from '@ghostai/core';
import { GhostError } from '@ghostai/core';

export interface RecordingClock extends Clock {
  /** Every delay asked for, in order. Nothing actually waited. */
  readonly sleeps: readonly number[];
  advance(ms: number): void;
}

export function recordingClock(startMs = 1_700_000_000_000): RecordingClock {
  const sleeps: number[] = [];
  let now = startMs;

  return {
    sleeps,
    advance: (ms) => {
      now += ms;
    },
    now: () => now,
    monotonic: () => now,
    setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
    clearTimeout: (handle) => {
      globalThis.clearTimeout(handle);
    },
    sleep: (delayMs, signal) => {
      // The signal is still honoured: a turn cancelled during backoff must not
      // proceed to the retry, and that ordering is worth testing without a wait.
      if (signal?.aborted === true) {
        return Promise.reject(new GhostError('aborted', 'Sleep aborted'));
      }
      sleeps.push(delayMs);
      now += delayMs;
      return Promise.resolve();
    },
  };
}
