import { describe, expect, it } from 'vitest';

import { isGhostError, toGhostError } from '@ghostai/core';

import {
  PROVIDER_ERROR_REASONS,
  ProviderError,
  classifyStatus,
  isProviderError,
  parseRetryAfter,
  toProviderError,
} from './errors.js';

describe('ProviderError', () => {
  it('maps its reason onto the core taxonomy', () => {
    expect(new ProviderError('rate_limit', 'x').kind).toBe('rate_limited');
    expect(new ProviderError('transport', 'x').kind).toBe('network');
    expect(new ProviderError('auth', 'x').kind).toBe('permission_denied');
    expect(new ProviderError('aborted', 'x').kind).toBe('aborted');
    expect(new ProviderError('unsupported_param', 'x').kind).toBe('provider');
  });

  it('is a GhostError, so it survives normalisation at a boundary', () => {
    const error = new ProviderError('rate_limit', 'slow down', { providerId: 'groq' });
    expect(isGhostError(error)).toBe(true);
    // The important half: `toGhostError` must not downgrade it to `internal`.
    expect(toGhostError(error)).toBe(error);
    expect(toGhostError(error).kind).toBe('rate_limited');
  });

  it('decides retryability from the reason, and lets a caller override', () => {
    expect(new ProviderError('server', 'x').retryable).toBe(true);
    expect(new ProviderError('invalid_request', 'x').retryable).toBe(false);
    expect(new ProviderError('invalid_request', 'x', { retryable: true }).retryable).toBe(true);
  });

  it('puts the diagnosis in structured details, not in the message', () => {
    const error = new ProviderError('unsupported_param', 'nope', {
      providerId: 'openai',
      status: 400,
      code: 'unsupported_parameter',
      param: 'reasoning_effort',
    });
    expect(error.details).toEqual({
      reason: 'unsupported_param',
      providerId: 'openai',
      status: 400,
      code: 'unsupported_parameter',
      param: 'reasoning_effort',
    });
    // Redaction and log filtering work by path, so absent fields must be
    // absent rather than present-and-undefined.
    expect(Object.keys(new ProviderError('server', 'x').details)).toEqual(['reason']);
  });

  it('is recognised structurally, across class identities', () => {
    expect(isProviderError(new ProviderError('server', 'x'))).toBe(true);
    expect(isProviderError(new Error('plain'))).toBe(false);
    expect(isProviderError({ reason: 'server' })).toBe(false);
    // What a second copy of this package resolving separately looks like.
    const foreign = Object.assign(new Error('x'), { reason: 'rate_limit' });
    expect(isProviderError(foreign)).toBe(true);
  });

  it('covers every declared reason', () => {
    for (const reason of PROVIDER_ERROR_REASONS) {
      const error = new ProviderError(reason, reason);
      expect(error.reason).toBe(reason);
      expect(typeof error.retryable).toBe('boolean');
    }
  });
});

describe('classifyStatus', () => {
  it('reads the status where the status is enough', () => {
    expect(classifyStatus(401, null)).toBe('auth');
    expect(classifyStatus(403, null)).toBe('auth');
    expect(classifyStatus(404, null)).toBe('model_not_found');
    expect(classifyStatus(408, null)).toBe('timeout');
    expect(classifyStatus(429, null)).toBe('rate_limit');
    expect(classifyStatus(500, null)).toBe('server');
    expect(classifyStatus(502, null)).toBe('server');
    expect(classifyStatus(503, null)).toBe('overloaded');
    // Anthropic's non-standard overload status, which no client special-cases.
    expect(classifyStatus(529, null)).toBe('overloaded');
  });

  it('reads the provider error code on a 400', () => {
    expect(classifyStatus(400, { code: 'context_length_exceeded' })).toBe('context_length');
    expect(classifyStatus(400, { code: 'unsupported_parameter' })).toBe('unsupported_param');
    expect(classifyStatus(400, { code: 'invalid_model' })).toBe('model_not_found');
    expect(classifyStatus(400, { code: 'content_filter' })).toBe('content_filter');
    expect(classifyStatus(400, { code: 'insufficient_quota' })).toBe('rate_limit');
  });

  it('treats a named parameter as the provider pointing at the field', () => {
    expect(classifyStatus(400, { param: 'reasoning_effort' })).toBe('unsupported_param');
    expect(classifyStatus(400, { param: '' })).toBe('invalid_request');
  });

  it('never reads the message text', () => {
    // The whole point: a body whose prose says "context length exceeded" but
    // carries no code is an ordinary bad request, and a model that writes
    // "rate limit" in an answer must not become a retry.
    expect(
      classifyStatus(400, { message: 'context length exceeded, rate limit, overloaded' }),
    ).toBe('invalid_request');
  });

  it('falls back to unknown below 400', () => {
    expect(classifyStatus(200, null)).toBe('unknown');
    expect(classifyStatus(302, null)).toBe('unknown');
  });
});

describe('parseRetryAfter', () => {
  const now = Date.parse('2026-07-27T12:00:00Z');

  it('reads delta-seconds', () => {
    expect(parseRetryAfter('2', now)).toBe(2000);
    expect(parseRetryAfter('  30 ', now)).toBe(30_000);
  });

  it('reads an HTTP date', () => {
    expect(parseRetryAfter('Mon, 27 Jul 2026 12:00:05 GMT', now)).toBe(5000);
  });

  it('never returns a negative delay for a date already past', () => {
    expect(parseRetryAfter('Mon, 27 Jul 2026 11:59:00 GMT', now)).toBe(0);
  });

  it('returns null for absent or malformed headers', () => {
    expect(parseRetryAfter(null, now)).toBeNull();
    expect(parseRetryAfter('', now)).toBeNull();
    expect(parseRetryAfter('soon', now)).toBeNull();
    expect(parseRetryAfter('-5', now)).toBeNull();
  });
});

describe('toProviderError', () => {
  it('passes an already-typed error through untouched', () => {
    const original = new ProviderError('rate_limit', 'x');
    expect(toProviderError(original, 'openai')).toBe(original);
  });

  it('recognises an abort by name, across realms', () => {
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    expect(toProviderError(abort, 'openai').reason).toBe('aborted');
  });

  it('recognises a timeout signal', () => {
    const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    expect(toProviderError(timeout, 'openai').reason).toBe('timeout');
  });

  it('treats anything else on the request path as transport', () => {
    expect(toProviderError(new TypeError('fetch failed'), 'openai').reason).toBe('transport');
    expect(toProviderError('a string', 'openai').message).toBe('a string');
    expect(toProviderError(new TypeError('x'), 'openai').providerId).toBe('openai');
  });
});
