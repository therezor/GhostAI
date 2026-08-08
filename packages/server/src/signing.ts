/**
 * HMAC-signed, expiring media URLs.
 *
 * `<img src>` cannot carry an `Authorization` header and will not send a
 * `SameSite=Strict` cookie on every path a browser might load it from, so an
 * authenticated file endpoint cannot be rendered inline. The tempting fix — make
 * the file endpoint public — is anonymous read access to everything under the
 * workspace, which is the agent's whole filesystem.
 *
 * A signature satisfies the browser instead. The *URL* is the credential, it
 * names one path, it expires, and the endpoint that serves it stays outside the
 * session-cookie surface rather than outside authorisation.
 *
 * Three properties this file exists to hold:
 *
 *  - **The path is inside the signature, not beside it.** A token that authorised
 *    "some file" plus a `?path=` parameter is a token that authorises every file.
 *  - **The comparison is `timingSafeEqual`.** A byte-at-a-time `===` on a MAC is
 *    forgeable given enough attempts, and a media URL is exactly the kind of
 *    thing something retries in a loop.
 *  - **Expiry is checked after the MAC verifies**, so an unsigned guess learns
 *    nothing from the difference between "expired" and "wrong".
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

import { GhostError } from '@ghostbot/core';

/** The `auth_secrets` row the signing key lives in. */
export const MEDIA_SECRET_NAME = 'media_signing_key';

/** What a verified token says. */
export interface MediaClaim {
  /** Workspace-relative, as it was when signed. */
  readonly path: string;
  /**
   * Which workspace the path is relative to.
   *
   * Inside the signature for exactly the reason the path is: two workspaces both
   * contain `notes.md`, so a token that authorised "this path" without saying
   * where would be a token for that filename in every workspace at once.
   */
  readonly workspaceId: string;
  readonly expiresAtMs: number;
}

interface Payload {
  readonly p: string;
  readonly w: string;
  readonly e: number;
}

function mac(secret: string, payload: string): Buffer {
  return createHmac('sha256', secret).update(payload, 'utf8').digest();
}

/**
 * A token for one path, good until `expiresAtMs`.
 *
 * The caller has already put the path through the jail — signing an escaping
 * path would make the signature the thing that authorised it.
 */
export function signMediaToken(secret: string, claim: MediaClaim): string {
  const payload: Payload = {
    p: claim.path,
    w: claim.workspaceId,
    e: claim.expiresAtMs,
  };
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString(
    'base64url',
  );
  return `${encoded}.${mac(secret, encoded).toString('base64url')}`;
}

/**
 * The claim a token carries, or `undefined` for anything that is not a token
 * this server signed and that is still live.
 *
 * One answer for every failure — malformed, forged, expired — because
 * distinguishing them tells a caller which half of a guess was right.
 */
export function verifyMediaToken(
  secret: string,
  token: string,
  nowMs: number,
): MediaClaim | undefined {
  const separator = token.lastIndexOf('.');
  if (separator <= 0 || separator === token.length - 1) return undefined;

  const encoded = token.slice(0, separator);
  const presented = Buffer.from(token.slice(separator + 1), 'base64url');
  const expected = mac(secret, encoded);
  // `timingSafeEqual` throws rather than returning false on a length mismatch,
  // and a truncated token must not turn into a 500.
  if (presented.byteLength !== expected.byteLength) return undefined;
  if (!timingSafeEqual(presented, expected)) return undefined;

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    // Unreachable through a signature this server produced; reachable if the
    // signing key ever leaked, which is exactly when not throwing matters.
    return undefined;
  }
  if (typeof payload !== 'object' || payload === null) return undefined;

  const { p, w, e } = payload as Partial<Payload>;
  if (typeof p !== 'string' || p === '' || typeof e !== 'number') {
    return undefined;
  }
  // A workspace-less payload is refused rather than defaulted to `default`.
  // Defaulting would let a token minted before workspaces existed — or one
  // whose `w` an attacker stripped — be replayed against the default
  // workspace, which is the one that contains all the others.
  if (typeof w !== 'string' || w === '') return undefined;
  if (e <= nowMs) return undefined;

  return { path: p, workspaceId: w, expiresAtMs: e };
}

/** The URL a client puts in `<img src>`. Relative, so it survives a reverse proxy. */
export function mediaUrl(token: string): string {
  return `/api/media/${encodeURIComponent(token)}`;
}

/** Guards against a signer built with no key, which would sign everything alike. */
export function assertSigningKey(secret: string): void {
  if (secret === '') {
    throw new GhostError('config', 'The media signing key is empty');
  }
}
