/**
 * A clock a test moves by hand.
 *
 * Two things in this package are only testable with one. Keyset pagination is
 * about rows that carry *different* timestamps, and four sessions created in a
 * single millisecond — which is what a fast test does — would all tie and hide
 * the ordering the cursor depends on. Signed-URL expiry is the other: the
 * alternative to advancing a clock is sleeping through the TTL.
 */

import type { Clock } from '@ghostbot/core';

export interface ManualClock extends Clock {
  advance(ms: number): void;
  set(ms: number): void;
}

export function manualClock(startMs = 1_700_000_000_000): ManualClock {
  let now = startMs;

  return {
    advance: (ms) => {
      now += ms;
    },
    set: (ms) => {
      now = ms;
    },
    now: () => now,
    // The same value: nothing in the routes measures a duration across a
    // wall-clock jump, and one number is one thing for a test to move.
    monotonic: () => now,
    setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
    clearTimeout: (handle) => {
      globalThis.clearTimeout(handle);
    },
    sleep: async (delayMs) => {
      now += delayMs;
    },
  };
}
