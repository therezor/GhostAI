import { describe, expect, it } from 'vitest';

import { GhostError, isGhostError } from '@ghostbot/core';

import { fsFailure } from '#src/builtin/shared.js';

describe('fsFailure', () => {
  it('maps an errno to a kind and a workspace-relative message', () => {
    const error = fsFailure(
      Object.assign(new Error('raw'), { code: 'EACCES' }),
      'notes.md',
    );
    expect(isGhostError(error)).toBe(true);
    if (isGhostError(error)) {
      expect(error.kind).toBe('permission_denied');
      expect(error.message).toBe(
        'notes.md is not readable or writable by this process.',
      );
      expect(error.details).toEqual({ path: 'notes.md', code: 'EACCES' });
    }
  });

  it('passes a GhostError through so jail_escape is never downgraded', () => {
    // Re-wrapping would replace the most security-relevant kind in the
    // taxonomy with an anonymous storage failure.
    const original = new GhostError('jail_escape', 'nope');
    expect(fsFailure(original, 'x')).toBe(original);
  });

  it('passes an abort through rather than reading its numeric DOM code', () => {
    const abort = new Error('The operation was aborted');
    abort.name = 'AbortError';
    Object.assign(abort, { code: 20 });
    expect(fsFailure(abort, 'x')).toBe(abort);
  });

  it('leaves an error with no errno alone', () => {
    const plain = new Error('something else');
    expect(fsFailure(plain, 'x')).toBe(plain);
    expect(fsFailure('a string', 'x')).toBe('a string');
  });

  it('falls back to the tool kind for an unrecognised errno', () => {
    const error = fsFailure(
      Object.assign(new Error('raw'), { code: 'EXDEV' }),
      'x',
    );
    expect(isGhostError(error)).toBe(true);
    if (isGhostError(error)) {
      expect(error.kind).toBe('tool');
      expect(error.message).toContain('EXDEV');
    }
  });
});
