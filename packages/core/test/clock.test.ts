import { afterEach, describe, expect, it, vi } from 'vitest';

import { systemClock } from '#src/clock.js';
import { isGhostError } from '#src/errors.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('systemClock', () => {
  it('reports wall-clock epoch milliseconds', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    expect(systemClock.now()).toBe(1_700_000_000_000);
  });

  it('reports a monotonic reading that never goes backwards', () => {
    const first = systemClock.monotonic();
    const second = systemClock.monotonic();
    expect(second).toBeGreaterThanOrEqual(first);
  });

  it('runs a scheduled callback', () => {
    vi.useFakeTimers();
    const callback = vi.fn();
    systemClock.setTimeout(callback, 100);

    vi.advanceTimersByTime(99);
    expect(callback).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(callback).toHaveBeenCalledOnce();
  });

  it('cancels a scheduled callback', () => {
    vi.useFakeTimers();
    const callback = vi.fn();
    systemClock.clearTimeout(systemClock.setTimeout(callback, 100));

    vi.advanceTimersByTime(500);
    expect(callback).not.toHaveBeenCalled();
  });
});

describe('sleep', () => {
  it('resolves after the delay', async () => {
    vi.useFakeTimers();
    let settled = false;
    const pending = systemClock.sleep(100).then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(99);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(settled).toBe(true);
  });

  it('rejects immediately when the signal has already fired', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(systemClock.sleep(1_000, controller.signal)).rejects.toSatisfy(
      (error: unknown) => isGhostError(error) && error.kind === 'aborted',
    );
  });

  it('rejects when the signal fires during the sleep', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const pending = systemClock.sleep(1_000, controller.signal);

    await vi.advanceTimersByTimeAsync(100);
    controller.abort();

    await expect(pending).rejects.toSatisfy(
      (error: unknown) => isGhostError(error) && error.kind === 'aborted',
    );
  });

  it('cancels its timer when aborted, so nothing fires afterwards', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const pending = systemClock.sleep(1_000, controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow();

    // If the timer were still armed, this would resolve a settled promise —
    // harmless in itself, but it means the handle leaked.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('detaches its abort listener once it resolves', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener');

    const pending = systemClock.sleep(10, controller.signal);
    await vi.advanceTimersByTimeAsync(10);
    await pending;

    // A turn sleeps on one long-lived signal many times; without this the
    // listeners accumulate for the life of the session.
    expect(removeListener).toHaveBeenCalled();
  });

  it('resolves normally when no signal is supplied', async () => {
    vi.useFakeTimers();
    const pending = systemClock.sleep(5);
    await vi.advanceTimersByTimeAsync(5);
    await expect(pending).resolves.toBeUndefined();
  });
});
