import { GhostError, ERROR_KINDS } from '@ghostai/core';
import { ErrorResponseSchema } from '@ghostai/protocol';
import { describe, expect, it } from 'vitest';

import {
  type HttpError,
  badRequest,
  errorBody,
  notFound,
  resolveError,
  unauthorized,
  unprocessable,
} from '#src/errors.js';

describe('errorBody', () => {
  it('produces the protocol envelope', () => {
    expect(ErrorResponseSchema.safeParse(errorBody('not_found', 'gone')).success).toBe(true);
  });

  it('omits an empty details object rather than sending one', () => {
    expect(errorBody('bad_request', 'no', {})).toEqual({
      error: { code: 'bad_request', message: 'no' },
    });
  });
});

describe('resolveError', () => {
  // The whole point of the kind taxonomy: a status is derived from a flag, never
  // from the text of a message.
  it.each(ERROR_KINDS)('maps the %s kind to a status without reading the message', (kind) => {
    const resolved = resolveError(new GhostError(kind, 'rate limit not found internal 429'));

    expect(resolved.status).toBeGreaterThanOrEqual(400);
    expect(ErrorResponseSchema.safeParse(resolved.body).success).toBe(true);
  });

  it.each([
    ['not_found', 404, 'not_found'],
    ['invalid_input', 422, 'bad_request'],
    ['rate_limited', 429, 'rate_limited'],
    ['provider', 502, 'provider_error'],
    ['jail_escape', 403, 'unauthorized'],
    ['config', 500, 'config_invalid'],
  ] as const)('reports %s as %i', (kind, status, code) => {
    const resolved = resolveError(new GhostError(kind, 'because'));

    expect(resolved.status).toBe(status);
    expect(resolved.body.error.code).toBe(code);
  });

  // A `GhostError` is written for an operator to act on; a stray `TypeError`
  // carries a file path, a SQL fragment or a stringified row.
  it('shows an operator error at 500 and hides anything else', () => {
    expect(resolveError(new GhostError('storage', 'the database file is read-only')).body).toEqual({
      error: { code: 'internal', message: 'the database file is read-only' },
    });
    expect(
      resolveError(new TypeError("Cannot read 'x' of undefined at /Users/me/secret")).body,
    ).toEqual({ error: { code: 'internal', message: 'Internal server error' } });
  });

  it('keeps an HttpError status, code and details', () => {
    const resolved = resolveError(unprocessable('Invalid body', { '/password': 'Required' }));

    expect(resolved.status).toBe(422);
    expect(resolved.body).toEqual({
      error: { code: 'bad_request', message: 'Invalid body', details: { '/password': 'Required' } },
    });
  });

  // Fastify's own 4xx — malformed JSON, an unsupported content type. Mapping
  // these through the kind table would report a client mistake as a 500.
  it('honours a 4xx statusCode from a plain error', () => {
    const error = Object.assign(new Error('Unexpected token'), { statusCode: 400 });
    expect(resolveError(error).status).toBe(400);
    expect(resolveError(error).body.error.code).toBe('bad_request');
  });

  it.each([
    [401, 'unauthorized'],
    [403, 'unauthorized'],
    [404, 'not_found'],
    [429, 'rate_limited'],
    [415, 'bad_request'],
  ] as const)('gives a %i the %s code', (status, code) => {
    const error = Object.assign(new Error('nope'), { statusCode: status });
    expect(resolveError(error).body.error.code).toBe(code);
  });

  it('does not honour a 5xx statusCode from a plugin', () => {
    const error = Object.assign(new Error('internal plugin detail'), { statusCode: 503 });
    expect(resolveError(error).status).toBe(500);
    expect(resolveError(error).body.error.message).toBe('Internal server error');
  });

  it('classifies an abort as neither a failure nor a success', () => {
    const abort = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    expect(resolveError(abort).status).toBe(499);
  });

  it('normalises a thrown non-error', () => {
    expect(resolveError('just a string').status).toBe(500);
    expect(resolveError('just a string').cause.kind).toBe('internal');
  });
});

describe('the helpers', () => {
  it.each([
    [unauthorized('no'), 401, 'unauthorized'],
    [badRequest('no'), 400, 'bad_request'],
    [notFound('no'), 404, 'not_found'],
  ] as const)('builds a %#', (error: HttpError, status, code) => {
    expect(error.status).toBe(status);
    expect(error.code).toBe(code);
    // Still a GhostError, so a kind survives if it is caught below the transport.
    expect(ERROR_KINDS).toContain(error.kind);
  });

  it('carries details through when given them', () => {
    expect(badRequest('no', { '/a': 'b' }).details).toEqual({ '/a': 'b' });
  });
});
