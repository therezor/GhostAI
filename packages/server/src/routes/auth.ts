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
} from '@ghostai/protocol';
import { systemClock } from '@ghostai/core';
import type { FastifyReply } from 'fastify';

import { clearSessionCookie, sessionOf, setSessionCookie } from '../auth.js';
import { badRequest, unauthorized } from '../errors.js';
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

export function authRoutes(deps: RouteDeps): RouteGroup<AuthRouteId> {
  const clock = deps.clock ?? systemClock;
  const authEnabled = deps.config.server.auth.enabled;

  return {
    'auth.login': {
      summary: 'Exchange the password for a session',
      schema: { body: LoginRequestSchema, response: { 200: LoginResponseSchema } },
      rateLimit: { max: LOGIN_ATTEMPTS_PER_MINUTE, timeWindowMs: 60_000 },
      handler: async (request, reply): Promise<LoginResponse> => {
        if (!authEnabled) {
          // Not a 401: the credential is not wrong, there is nothing to log in
          // to. A UI that reached here has misread `authEnabled`.
          throw badRequest('Authentication is disabled on this server');
        }
        const body = request.body as LoginRequest;
        if (!(await deps.auth.verifyPassword(body.password))) {
          throw unauthorized('Incorrect password');
        }

        const issued = deps.auth.issue('web');
        setSessionCookie(request, reply, issued.token, issued.expiresAtMs, clock.now());
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
          ...(session === undefined ? {} : { expiresAtMs: session.expiresAtMs }),
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
      schema: { body: SetupClaimRequestSchema, response: { 200: LoginResponseSchema } },
      // The same limit as the login, because this is one: a code is shorter
      // than a password, and the whole reason it is safe is that it can only be
      // tried a few times before it is worth nobody's while.
      rateLimit: { max: LOGIN_ATTEMPTS_PER_MINUTE, timeWindowMs: 60_000 },
      handler: (request, reply): LoginResponse => {
        if (!authEnabled) throw badRequest('Authentication is disabled on this server');
        if (deps.auth.hasPassword()) {
          // Not a 401 either: the code is not wrong, the install is already
          // claimed and the caller should be logging in with the password.
          throw badRequest('This server already has a password; sign in instead');
        }
        const body = request.body as SetupClaimRequest;
        if (!deps.auth.consumeSetupCode(body.code)) {
          // One message for a wrong code and a spent one, for the same reason
          // the login gives one for a bad password and an unknown session.
          throw unauthorized('Incorrect or already-used setup code');
        }

        const issued = deps.auth.issue('setup');
        setSessionCookie(request, reply, issued.token, issued.expiresAtMs, clock.now());
        return { ok: true, expiresAtMs: issued.expiresAtMs };
      },
    },

    'setup.password': {
      summary: 'Set the login password, finishing the claim',
      schema: { body: SetupPasswordRequestSchema, response: { 200: LoginResponseSchema } },
      handler: async (request, reply): Promise<LoginResponse> => {
        if (!authEnabled) throw badRequest('Authentication is disabled on this server');
        const body = request.body as SetupPasswordRequest;

        // `required`, so the caller already holds a session — either the one
        // `setup.claim` minted, or a normal login rotating their password.
        await deps.auth.setPassword(body.password);

        // `setPassword` revokes every session, including the caller's own.
        // Re-issuing is not a convenience: without it the browser is signed out
        // in the middle of the wizard, with the code it would need to get back
        // in already spent.
        const issued = deps.auth.issue('web');
        setSessionCookie(request, reply, issued.token, issued.expiresAtMs, clock.now());
        return { ok: true, expiresAtMs: issued.expiresAtMs };
      },
    },
  };
}
