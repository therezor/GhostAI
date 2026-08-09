/**
 * The login, its inverse, the question the UI asks before deciding whether to
 * show the login overlay at all — and the three routes that claim an install
 * which has no password yet.
 *
 * Setup lives here rather than in a module of its own because it *is*
 * authentication: `setup.claim` mints exactly what `auth.login` mints, from a
 * different credential, and keeping the two beside each other is what makes it
 * obvious that the one-time code is a login and has to be rate-limited like
 * one.
 */

import {
  AuthSessionResponseSchema,
  LoginRequestSchema,
  LoginResponseSchema,
  SetupClaimRequestSchema,
  SetupPasswordRequestSchema,
  SetupStatusResponseSchema,
  type AuthSessionResponse,
  type LoginRequest,
  type LoginResponse,
  type SetupClaimRequest,
  type SetupPasswordRequest,
  type SetupStatusResponse,
} from '@ghostwire/protocol';
import { systemClock } from '@ghostwire/core';
import type { FastifyReply } from 'fastify';

import { clearSessionCookie, sessionOf, setSessionCookie } from '../auth.js';
import { badRequest, tooManyRequests, unauthorized } from '../errors.js';
import type { ThrottleBlock } from '../login-throttle.js';
import type { RouteDeps, RouteGroup } from './types.js';

type AuthRouteId =
  | 'auth.login'
  | 'auth.logout'
  | 'auth.me'
  | 'setup.status'
  | 'setup.claim'
  | 'setup.password';

/**
 * Login attempts per minute per address.
 *
 * Independent of `server.auth.rateLimitPerMinute`, and not disabled when that
 * is zero. The general limit protects the process from load; this one protects a
 * single password from being guessed, and an operator turning off the former
 * is not asking for the latter.
 */
export const LOGIN_ATTEMPTS_PER_MINUTE = 10;

/**
 * The body cap on the routes an anonymous caller can reach.
 *
 * The global limit is a megabyte, which is right for an upload and absurd for a
 * username and a password. Every byte above this is one an unauthenticated
 * caller can make the server buffer and parse before anything has decided
 * whether to talk to them at all.
 */
const CREDENTIAL_BODY_LIMIT = 4096;

/**
 * Turns a throttle block into the response the caller gets.
 *
 * `Retry-After` in whole seconds, rounded up: the header is defined in seconds,
 * and rounding down would tell a well-behaved client to come back at a moment
 * the throttle still refuses — which reads to them as the limit being broken.
 */
function throttled(block: ThrottleBlock, reply: FastifyReply): never {
  const seconds = Math.ceil(block.retryAfterMs / 1000);
  void reply.header('Retry-After', String(seconds));
  // The scope is deliberately not in the message. "Your address is locked out"
  // and "the account is locked out" tell an attacker whether their address has
  // been singled out, which is exactly what they would use to decide whether
  // rotating through a botnet is working.
  throw tooManyRequests(`Too many attempts. Try again in ${String(seconds)}s.`);
}

export function authRoutes(deps: RouteDeps): RouteGroup<AuthRouteId> {
  const clock = deps.clock ?? systemClock;
  const authEnabled = deps.config.server.auth.enabled;
  const throttle = deps.loginThrottle;

  return {
    'auth.login': {
      summary: 'Exchange the username and password for a session',
      schema: {
        body: LoginRequestSchema,
        response: { 200: LoginResponseSchema },
      },
      rateLimit: { max: LOGIN_ATTEMPTS_PER_MINUTE, timeWindowMs: 60_000 },
      bodyLimit: CREDENTIAL_BODY_LIMIT,
      handler: async (request, reply): Promise<LoginResponse> => {
        if (!authEnabled) {
          // Not a 401: the credential is not wrong, there is nothing to log in
          // to. A UI that reached here has misread `authEnabled`.
          throw badRequest('Authentication is disabled on this server');
        }

        // Before the KDF, not after. A caller who is already locked out must not
        // be able to spend 50 ms and 19 MiB of the server's budget per request
        // — a rate limit that still does the expensive work is an amplifier.
        const blocked = throttle.check(request.ip);
        if (blocked !== undefined) throttled(blocked, reply);

        const body = request.body as LoginRequest;
        if (!(await deps.auth.verifyLogin(body.username, body.password))) {
          const block = throttle.fail(request.ip);
          // The block is reported on the attempt that created it rather than on
          // the next one. A 401 tells the attacker the guess was wrong and
          // leaves them free to send another immediately; the delay is only real
          // once the response says so.
          if (block !== undefined) throttled(block, reply);
          // One message for a wrong username and a wrong password. Naming which
          // half failed hands over the other half.
          throw unauthorized('Incorrect username or password');
        }
        throttle.succeed(request.ip);

        const issued = deps.auth.issue('web');
        setSessionCookie(
          request,
          reply,
          issued.token,
          issued.expiresAtMs,
          clock.now(),
        );
        // The token is deliberately absent from the body. A response a browser
        // can read is a response an injected script can read.
        return { ok: true, expiresAtMs: issued.expiresAtMs };
      },
    },

    'auth.logout': {
      summary: 'Revoke the presented session',
      schema: {},
      handler: (request, reply): FastifyReply => {
        const session = sessionOf(request);
        if (session !== undefined) deps.auth.revokeById(session.id);
        clearSessionCookie(request, reply);
        // 204 rather than a body: there is nothing to say, and inventing a
        // `{ ok: true }` DTO for it would put a schema in the protocol that
        // exists only to be ignored.
        return reply.status(204).send();
      },
    },

    'auth.me': {
      summary: 'Whether the caller is authenticated, and until when',
      schema: { response: { 200: AuthSessionResponseSchema } },
      handler: (request): AuthSessionResponse => {
        const session = sessionOf(request);
        return {
          // Reaching this handler means the hook let the request through, which
          // is true either because a session checked out or because
          // authentication is off.
          authenticated: true,
          authEnabled,
          ...(session === undefined
            ? {}
            : { expiresAtMs: session.expiresAtMs }),
          // Only when authentication is on. With it off there is no account,
          // and reporting the name of one would describe a login that does not
          // exist.
          ...(authEnabled ? { username: deps.auth.username() } : {}),
        };
      },
    },

    'setup.status': {
      summary: 'Whether this install still has to be claimed',
      schema: { response: { 200: SetupStatusResponseSchema } },
      handler: (): SetupStatusResponse => ({
        // With authentication off there is nothing to claim: the server is
        // reachable without a credential by design, and offering a setup
        // screen would be asking for a password that would never be checked.
        required: authEnabled && !deps.auth.hasPassword(),
      }),
    },

    'setup.claim': {
      summary: 'Spend the one-time code printed at startup for a session',
      schema: {
        body: SetupClaimRequestSchema,
        response: { 200: LoginResponseSchema },
      },
      // The same limit as the login, because this is one: a code is shorter
      // than a password, and the whole reason it is safe is that it can only be
      // tried a few times before it is worth nobody's while.
      rateLimit: { max: LOGIN_ATTEMPTS_PER_MINUTE, timeWindowMs: 60_000 },
      bodyLimit: CREDENTIAL_BODY_LIMIT,
      handler: (request, reply): LoginResponse => {
        if (!authEnabled) {
          throw badRequest('Authentication is disabled on this server');
        }
        if (deps.auth.hasPassword()) {
          // Not a 401 either: the code is not wrong, the install is already
          // claimed and the caller should be logging in with the password.
          throw badRequest(
            'This server already has a password; sign in instead',
          );
        }

        // The same throttle the login uses, and the same buckets: a code is a
        // credential for exactly the same account, so guesses at it have to
        // count against the same aggregate rate. Two independent counters would
        // let an attacker have both budgets.
        const blocked = throttle.check(request.ip);
        if (blocked !== undefined) throttled(blocked, reply);

        const body = request.body as SetupClaimRequest;
        if (!deps.auth.consumeSetupCode(body.code)) {
          const block = throttle.fail(request.ip);
          if (block !== undefined) throttled(block, reply);
          // One message for a wrong code and a spent one, for the same reason
          // the login gives one for a bad password and an unknown session.
          throw unauthorized('Incorrect or already-used setup code');
        }
        throttle.succeed(request.ip);

        const issued = deps.auth.issue('setup');
        setSessionCookie(
          request,
          reply,
          issued.token,
          issued.expiresAtMs,
          clock.now(),
        );
        return { ok: true, expiresAtMs: issued.expiresAtMs };
      },
    },

    'setup.password': {
      summary:
        'Set the login password and name, finishing the claim or rotating both',
      schema: {
        body: SetupPasswordRequestSchema,
        response: { 200: LoginResponseSchema },
      },
      // Rate-limited like a login, because on an install that already has a
      // password this route *takes* one. Without a limit here the current-
      // password proof below would be the one credential check on the server
      // that could be guessed at as fast as the network allows.
      rateLimit: { max: LOGIN_ATTEMPTS_PER_MINUTE, timeWindowMs: 60_000 },
      bodyLimit: CREDENTIAL_BODY_LIMIT,
      handler: async (request, reply): Promise<LoginResponse> => {
        if (!authEnabled) {
          throw badRequest('Authentication is disabled on this server');
        }
        const body = request.body as SetupPasswordRequest;

        // `required`, so the caller already holds a session — either the one
        // `setup.claim` minted, or a normal login rotating their password.
        //
        // A session is sufficient for the first and not for the second. During a
        // claim there is no password to prove and demanding one would make the
        // wizard unfinishable; afterwards, the session is a credential that an
        // injected script in a page full of model-authored markdown can spend,
        // and the old password is the thing it cannot produce.
        if (deps.auth.hasPassword()) {
          const blocked = throttle.check(request.ip);
          if (blocked !== undefined) throttled(blocked, reply);

          if (body.currentPassword === undefined) {
            throw badRequest('The current password is required to change it');
          }
          if (!(await deps.auth.verifyPassword(body.currentPassword))) {
            const block = throttle.fail(request.ip);
            if (block !== undefined) throttled(block, reply);
            throw unauthorized('Incorrect current password');
          }
          throttle.succeed(request.ip);
        }

        await deps.auth.setPassword(
          body.password,
          ...(body.username === undefined ? [] : [body.username]),
        );

        // `setPassword` revokes every session, including the caller's own.
        // Re-issuing is not a convenience: without it the browser is signed out
        // in the middle of the wizard, with the code it would need to get back
        // in already spent.
        const issued = deps.auth.issue('web');
        setSessionCookie(
          request,
          reply,
          issued.token,
          issued.expiresAtMs,
          clock.now(),
        );
        return { ok: true, expiresAtMs: issued.expiresAtMs };
      },
    },
  };
}
