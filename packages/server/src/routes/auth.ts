/**
 * The login, its inverse, and the question the UI asks before deciding whether
 * to show the login overlay at all.
 */

import {
  AuthSessionResponseSchema,
  LoginRequestSchema,
  LoginResponseSchema,
  type AuthSessionResponse,
  type LoginRequest,
  type LoginResponse,
} from '@ghostai/protocol';
import { systemClock } from '@ghostai/core';
import type { FastifyReply } from 'fastify';

import { clearSessionCookie, sessionOf, setSessionCookie } from '../auth.js';
import { badRequest, unauthorized } from '../errors.js';
import type { RouteDeps, RouteGroup } from './types.js';

type AuthRouteId = 'auth.login' | 'auth.logout' | 'auth.me';

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
  };
}
