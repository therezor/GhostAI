/**
 * The injectable clock.
 *
 * Nothing in GhostAI calls `Date.now()` or `setTimeout` directly. Everything
 * time-dependent — the loop's wall-clock cap, the 15-second tool heartbeat,
 * per-sender rate limiting, the scheduler's rearm — takes a `Clock`, so tests
 * drive them with `vi.useFakeTimers()` and nothing ever sleeps for real.
 *
 * The interface separates two kinds of time on purpose:
 *
 *  - `now()` is wall-clock epoch milliseconds. It is what gets persisted and
 *    displayed, and it can jump backwards when NTP corrects the host.
 *  - `monotonic()` only ever moves forward. Every *duration* — elapsed turn
 *    time, token-bucket refill, timeout accounting — uses it, so an NTP step
 *    mid-turn cannot make a turn appear to have taken negative time or reset a
 *    rate limit.
 *
 * Conflating the two is the classic bug here, and it fails in production at 3am
 * rather than in a test.
 */

import { GhostError } from './errors.js';

/** Opaque timer token. Node returns a `Timeout` object, the DOM a number. */
export type TimerHandle = ReturnType<typeof globalThis.setTimeout>;

export interface Clock {
  /** Wall-clock epoch milliseconds. Persist and display this one. */
  now(): number;
  /** Monotonic milliseconds from an arbitrary origin. Measure durations with this one. */
  monotonic(): number;
  setTimeout(callback: () => void, delayMs: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
  /**
   * Rejects with an `aborted` `GhostError` if `signal` fires, and always
   * detaches its listener — an agent that sleeps on a long-lived signal
   * thousands of times per session must not accumulate listeners on it.
   */
  sleep(delayMs: number, signal?: AbortSignal): Promise<void>;
}

function sleep(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) {
    return Promise.reject(new GhostError('aborted', 'Sleep aborted'));
  }
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      globalThis.clearTimeout(timer);
      reject(new GhostError('aborted', 'Sleep aborted'));
    };
    const timer = globalThis.setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export const systemClock: Clock = {
  now: () => Date.now(),
  monotonic: () => performance.now(),
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (handle) => {
    globalThis.clearTimeout(handle);
  },
  sleep,
};
