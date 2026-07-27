import type { FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';

import { cookieSecure, readCredential, SESSION_COOKIE } from './auth.js';

interface FakeRequest {
  readonly headers: Record<string, string | undefined>;
  readonly cookies: Record<string, string | undefined>;
  readonly protocol?: string;
  readonly hostname?: string;
}

function request(parts: Partial<FakeRequest> = {}): FastifyRequest {
  return {
    headers: parts.headers ?? {},
    cookies: parts.cookies ?? {},
    protocol: parts.protocol ?? 'http',
    hostname: parts.hostname ?? '127.0.0.1',
  } as unknown as FastifyRequest;
}

describe('readCredential', () => {
  it('finds nothing when nothing was sent', () => {
    expect(readCredential(request())).toBeUndefined();
  });

  it('reads a bearer token', () => {
    expect(readCredential(request({ headers: { authorization: 'Bearer abc.def' } }))).toBe(
      'abc.def',
    );
  });

  it('accepts the scheme in any case, as the HTTP spec requires', () => {
    expect(readCredential(request({ headers: { authorization: 'bearer abc.def' } }))).toBe(
      'abc.def',
    );
    expect(readCredential(request({ headers: { authorization: 'BEARER abc.def' } }))).toBe(
      'abc.def',
    );
  });

  it('ignores another scheme entirely', () => {
    expect(
      readCredential(request({ headers: { authorization: 'Basic dXNlcjpwdw==' } })),
    ).toBeUndefined();
  });

  it('ignores an empty bearer value', () => {
    expect(readCredential(request({ headers: { authorization: 'Bearer   ' } }))).toBeUndefined();
  });

  it('reads the session cookie', () => {
    expect(readCredential(request({ cookies: { [SESSION_COOKIE]: 'abc.def' } }))).toBe('abc.def');
  });

  it('ignores an empty cookie', () => {
    expect(readCredential(request({ cookies: { [SESSION_COOKIE]: '' } }))).toBeUndefined();
  });

  // An expired cookie left in a jar must not shadow a token the caller
  // deliberately attached.
  it('prefers the header over the cookie', () => {
    const value = readCredential(
      request({
        headers: { authorization: 'Bearer from-header' },
        cookies: { [SESSION_COOKIE]: 'from-cookie' },
      }),
    );
    expect(value).toBe('from-header');
  });
});

describe('cookieSecure', () => {
  it('is set over HTTPS regardless of host', () => {
    expect(cookieSecure(request({ protocol: 'https', hostname: '127.0.0.1' }))).toBe(true);
  });

  // Safari refuses to store a `Secure` cookie over http://, localhost included,
  // so an unconditional flag would break login on the default bind.
  it.each(['127.0.0.1', 'localhost', '::1'])('is not set over plain HTTP to %s', (hostname) => {
    expect(cookieSecure(request({ protocol: 'http', hostname }))).toBe(false);
  });

  // The consequence — a plain-HTTP LAN bind cannot hold a session — is the
  // point, not a bug: that is a session cookie crossing a network in the clear.
  it.each(['192.168.1.10', 'ghost.local', '0.0.0.0'])(
    'is set over plain HTTP to %s',
    (hostname) => {
      expect(cookieSecure(request({ protocol: 'http', hostname }))).toBe(true);
    },
  );
});
