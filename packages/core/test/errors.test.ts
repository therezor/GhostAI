import { describe, expect, it } from 'vitest';

import {
  ERROR_KINDS,
  GhostError,
  abortedError,
  isAbortError,
  isGhostError,
  toGhostError,
  onAbort,
} from '#src/errors.js';

describe('GhostError', () => {
  it('carries its kind and message', () => {
    const error = new GhostError('tool', 'read_file failed');
    expect(error.kind).toBe('tool');
    expect(error.message).toBe('read_file failed');
    expect(error.name).toBe('GhostError');
    expect(error).toBeInstanceOf(Error);
  });

  it('defaults retryable from the kind', () => {
    expect(new GhostError('network', 'boom').retryable).toBe(true);
    expect(new GhostError('rate_limited', 'slow down').retryable).toBe(true);
    expect(new GhostError('timeout', 'too slow').retryable).toBe(true);
    expect(new GhostError('invalid_input', 'nope').retryable).toBe(false);
    // A provider 400 is the common case, and retrying it burns quota to reach
    // the same answer — the adapter overrides this when it knows the status.
    expect(new GhostError('provider', 'bad request').retryable).toBe(false);
  });

  it('lets the caller override retryable', () => {
    expect(
      new GhostError('provider', 'overloaded', { retryable: true }).retryable,
    ).toBe(true);
  });

  it('defaults details to an empty object', () => {
    expect(new GhostError('internal', 'x').details).toEqual({});
  });

  it('keeps structured details', () => {
    const error = new GhostError('storage', 'x', {
      details: { sessionKey: 's', seq: 3 },
    });
    expect(error.details).toEqual({ sessionKey: 's', seq: 3 });
  });

  it('preserves a cause', () => {
    const cause = new Error('underlying');
    expect(new GhostError('storage', 'wrapper', { cause }).cause).toBe(cause);
  });

  it('has a retryable default for every declared kind', () => {
    for (const kind of ERROR_KINDS) {
      expect(typeof new GhostError(kind, 'x').retryable).toBe('boolean');
    }
  });
});

describe('isGhostError', () => {
  it('recognises its own errors', () => {
    expect(isGhostError(new GhostError('tool', 'x'))).toBe(true);
  });

  it('recognises one from another copy of the package', () => {
    // A plugin resolving its own @ghostai/core produces a different class
    // identity; an instanceof check would misclassify every one of these.
    const foreign = Object.assign(new Error('from a plugin'), { kind: 'tool' });
    expect(isGhostError(foreign)).toBe(true);
  });

  it('rejects an error whose kind is not in the taxonomy', () => {
    expect(
      isGhostError(Object.assign(new Error('x'), { kind: 'invented' })),
    ).toBe(false);
  });

  it('rejects plain errors and non-errors', () => {
    expect(isGhostError(new Error('x'))).toBe(false);
    expect(isGhostError('tool')).toBe(false);
    expect(isGhostError(null)).toBe(false);
    expect(isGhostError({ kind: 'tool' })).toBe(false);
  });
});

describe('isAbortError', () => {
  it('recognises a signal abort', () => {
    const controller = new AbortController();
    controller.abort();
    try {
      controller.signal.throwIfAborted();
      expect.unreachable('throwIfAborted should throw');
    } catch (error) {
      expect(isAbortError(error)).toBe(true);
    }
  });

  it('recognises our own aborted kind', () => {
    expect(isAbortError(new GhostError('aborted', 'x'))).toBe(true);
  });

  it('rejects other GhostErrors and unrelated values', () => {
    expect(isAbortError(new GhostError('timeout', 'x'))).toBe(false);
    expect(isAbortError(new Error('AbortError'))).toBe(false);
    expect(isAbortError('AbortError')).toBe(false);
  });
});

describe('toGhostError', () => {
  it('passes a typed error through unchanged', () => {
    const original = new GhostError('jail_escape', 'outside the workspace');
    expect(toGhostError(original)).toBe(original);
  });

  it('does not degrade a precise kind when re-normalised', () => {
    const original = new GhostError('rate_limited', 'slow down');
    expect(toGhostError(toGhostError(original), 'internal').kind).toBe(
      'rate_limited',
    );
  });

  it('maps an abort to the aborted kind', () => {
    const error = toGhostError(new DOMException('stopped', 'AbortError'));
    expect(error.kind).toBe('aborted');
  });

  it('wraps a plain error, keeping the message and cause', () => {
    const cause = new Error('disk on fire');
    const error = toGhostError(cause, 'storage');
    expect(error.kind).toBe('storage');
    expect(error.message).toBe('disk on fire');
    expect(error.cause).toBe(cause);
  });

  it('defaults to internal', () => {
    expect(toGhostError(new Error('x')).kind).toBe('internal');
  });

  it('handles a thrown string', () => {
    const error = toGhostError('something went wrong', 'tool');
    expect(error.kind).toBe('tool');
    expect(error.message).toBe('something went wrong');
  });

  it('handles a thrown non-string, non-error', () => {
    expect(toGhostError(42).message).toBe('42');
    expect(toGhostError(null).message).toBe('null');
    expect(toGhostError({ nope: true }).message).toBe('[object Object]');
  });
});

describe('abortedError', () => {
  it('builds a non-retryable aborted error', () => {
    const error = abortedError('Turn');
    expect(error.kind).toBe('aborted');
    expect(error.retryable).toBe(false);
    expect(error.message).toBe('Turn aborted');
  });
});

describe('onAbort', () => {
  it('fires when the signal aborts, once', () => {
    const controller = new AbortController();
    let fired = 0;
    onAbort(controller.signal, () => {
      fired += 1;
    });

    controller.abort();
    controller.abort();

    expect(fired).toBe(1);
  });

  it('fires immediately for a signal that has already aborted', () => {
    // The line both hand-rolled copies had a comment about: an `abort` listener
    // added after the fact is never called, so a watcher without this waits out
    // its whole deadline on a turn that was cancelled a moment earlier.
    const controller = new AbortController();
    controller.abort();

    let fired = false;
    const subscription = onAbort(controller.signal, () => {
      fired = true;
    });

    expect(fired).toBe(true);
    expect(() => {
      subscription.dispose();
    }).not.toThrow();
  });

  it('stops listening once disposed', () => {
    // The other load-bearing line. One turn makes dozens of tool calls against a
    // signal that lives as long as the request, and a listener left behind per
    // call is an accumulating leak on a long-lived object.
    const controller = new AbortController();
    let fired = false;
    const subscription = onAbort(controller.signal, () => {
      fired = true;
    });

    subscription.dispose();
    controller.abort();

    expect(fired).toBe(false);
  });
});
