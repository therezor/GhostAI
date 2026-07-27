/**
 * Turning a request into a session, and a session into a cookie.
 *
 * Two credential carriers for two callers. A browser gets an `httpOnly` cookie
 * because the alternative — a token in `localStorage` — is readable from
 * JavaScript, and this application's entire job is rendering markdown a
 * language model wrote. One successful injection would exfiltrate the session.
 * A CLI or a CI job gets a `Bearer` header, because it has no cookie jar and no
 * XSS surface to protect it from.
 *
 * `SameSite=Strict` is what stands in for a CSRF token. The cookie is simply
 * not attached to a cross-site request, so a form on another origin cannot
 * spend it, and there is no second secret to mint, store and rotate.
 */

import { isLoopbackHost, type Config } from '@ghostai/protocol';
import type { FastifyReply, FastifyRequest, onRequestHookHandler } from 'fastify';

// Loads `@fastify/cookie`'s augmentation of FastifyRequest/FastifyReply without
// pulling the module into this file's runtime graph.
import type {} from '@fastify/cookie';

import type { AuthSession, AuthStore } from './auth-store.js';
import { unauthorized } from './errors.js';

export const SESSION_COOKIE = 'ghost_session';
const BEARER_PREFIX = 'bearer ';

/**
 * The verified session for a request, keyed by the request object.
 *
 * A `WeakMap` rather than `decorateRequest`: decoration means augmenting
 * Fastify's own interface from this package, and every consumer of the type
 * then inherits a property that is only populated on authenticated routes.
 * This keeps the association where it belongs and out of the public types.
 */
const SESSIONS = new WeakMap<FastifyRequest, AuthSession>();

export function sessionOf(request: FastifyRequest): AuthSession | undefined {
  return SESSIONS.get(request);
}

/**
 * The credential presented, if any. `Authorization` wins over the cookie.
 *
 * A caller that sends both is a CLI driving a browser session or a test; taking
 * the explicit header first means an expired cookie left in a jar cannot
 * shadow a token the caller deliberately attached.
 */
export function readCredential(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (typeof header === 'string' && header.toLowerCase().startsWith(BEARER_PREFIX)) {
    const token = header.slice(BEARER_PREFIX.length).trim();
    if (token !== '') return token;
  }
  const cookie = request.cookies[SESSION_COOKIE];
  return cookie === undefined || cookie === '' ? undefined : cookie;
}

/**
 * `Secure` unless this is plain HTTP to a loopback host.
 *
 * The rule has to bend exactly that far and no further. Safari refuses to store
 * a `Secure` cookie over `http://`, including on localhost, so an unconditional
 * flag would make `ghost serve` unusable in one browser on the default bind.
 * Everywhere else the flag stays on, and the consequence — a plain-HTTP LAN
 * bind cannot hold a session — is the correct outcome rather than a bug: a
 * session cookie crossing a network in the clear is the thing being prevented.
 */
export function cookieSecure(request: FastifyRequest): boolean {
  if (request.protocol === 'https') return true;
  return !isLoopbackHost(request.hostname);
}

export function setSessionCookie(
  request: FastifyRequest,
  reply: FastifyReply,
  token: string,
  expiresAtMs: number,
  nowMs: number,
): void {
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: cookieSecure(request),
    path: '/',
    // Seconds, and never negative: a cookie whose lifetime rounds below zero is
    // a cookie the browser deletes on arrival.
    maxAge: Math.max(0, Math.floor((expiresAtMs - nowMs) / 1000)),
  });
}

export function clearSessionCookie(request: FastifyRequest, reply: FastifyReply): void {
  // The attributes have to match the ones it was set with or the browser keeps
  // the original cookie and clears nothing.
  reply.clearCookie(SESSION_COOKIE, {
    httpOnly: true,
    sameSite: 'strict',
    secure: cookieSecure(request),
    path: '/',
  });
}

export interface AuthHookOptions {
  readonly config: Config;
  readonly auth: AuthStore;
}

/**
 * The hook every `required` route in the manifest is registered with.
 *
 * `onRequest`, so an unauthenticated request is refused before its body is
 * read: an anonymous caller should not be able to make the server buffer a
 * megabyte of JSON.
 */
export function createAuthHook(options: AuthHookOptions): onRequestHookHandler {
  return function authenticate(request, _reply, done) {
    // Disabling authentication is a boot-time decision, not a request-time one:
    // `assertBootPolicy` has already refused the combination that makes this
    // dangerous, so a loopback-only server can be reached without a login.
    if (!options.config.server.auth.enabled) {
      done();
      return;
    }

    const token = readCredential(request);
    if (token === undefined) {
      done(unauthorized('Authentication required'));
      return;
    }

    const session = options.auth.verify(token);
    if (session === undefined) {
      // One message for a malformed token, an unknown one and an expired one.
      // Distinguishing them tells a caller which half of a guess was right.
      done(unauthorized('Invalid or expired session'));
      return;
    }

    SESSIONS.set(request, session);
    done();
  };
}
