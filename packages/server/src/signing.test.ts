import { describe, expect, it } from 'vitest';

import { assertSigningKey, mediaUrl, signMediaToken, verifyMediaToken } from './signing.js';

const KEY = 'a-signing-key';
const NOW = 1_700_000_000_000;

function token(overrides: { path?: string; expiresAtMs?: number } = {}): string {
  return signMediaToken(KEY, {
    path: overrides.path ?? 'notes/photo.png',
    expiresAtMs: overrides.expiresAtMs ?? NOW + 60_000,
  });
}

describe('media tokens', () => {
  it('verifies a token it signed', () => {
    expect(verifyMediaToken(KEY, token(), NOW)).toEqual({
      path: 'notes/photo.png',
      expiresAtMs: NOW + 60_000,
    });
  });

  it('refuses one signed with another key', () => {
    expect(verifyMediaToken('another-key', token(), NOW)).toBeUndefined();
  });

  it('refuses one whose expiry has passed', () => {
    const expiring = token({ expiresAtMs: NOW });
    expect(verifyMediaToken(KEY, expiring, NOW - 1)).toBeDefined();
    // Exactly at the boundary counts as expired: a token is good *until* its
    // deadline, and "still valid at the instant it ran out" is the reading that
    // makes a TTL one millisecond longer than it says.
    expect(verifyMediaToken(KEY, expiring, NOW)).toBeUndefined();
  });

  // The whole point of putting the path inside the MAC: a token authorises one
  // file, not "some file plus whatever the query string says".
  it('refuses a token whose path was swapped', () => {
    const [payload, signature] = token().split('.');
    const edited = Buffer.from(
      JSON.stringify({
        ...(JSON.parse(Buffer.from(payload ?? '', 'base64url').toString('utf8')) as object),
        p: '../../etc/passwd',
      }),
      'utf8',
    ).toString('base64url');

    expect(verifyMediaToken(KEY, `${edited}.${signature ?? ''}`, NOW)).toBeUndefined();
  });

  it.each([
    ['empty', ''],
    ['no separator', 'justonepart'],
    ['nothing before the separator', '.signature'],
    ['nothing after the separator', 'payload.'],
    ['a truncated signature', token().slice(0, -4)],
  ])('refuses a %s token without throwing', (_name, value) => {
    // A malformed token must not turn into a 500: it is the shape a scanner
    // sends, and an exception there is a way to find the code path.
    expect(() => verifyMediaToken(KEY, value, NOW)).not.toThrow();
    expect(verifyMediaToken(KEY, value, NOW)).toBeUndefined();
  });

  it('builds a relative URL so a reverse proxy does not have to be told about it', () => {
    expect(mediaUrl('abc.def')).toBe('/api/media/abc.def');
  });

  it('URL-encodes a token', () => {
    // base64url never produces these, but a token is a credential and the
    // encoder is what stops one from being reinterpreted as a path.
    expect(mediaUrl('a/b.c')).toBe('/api/media/a%2Fb.c');
  });

  it('refuses an empty signing key', () => {
    expect(() => {
      assertSigningKey('');
    }).toThrow(/empty/);
    expect(() => {
      assertSigningKey(KEY);
    }).not.toThrow();
  });
});
