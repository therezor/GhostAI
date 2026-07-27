/**
 * The handlers, keyed by the manifest's route ids.
 *
 * Nothing here registers itself. `createRoutes` returns a
 * `Record<RouteId, RouteDefinition>`, the router walks `ROUTE_MANIFEST`, and
 * the two are joined by the id — so the type checker enforces that the set of
 * handlers and the set of served routes are the same set.
 *
 * Step 13 fills in the other twenty-odd. What is here is what the auth surface
 * itself needs: a liveness probe that answers before a login, the login, its
 * inverse, and the question the UI asks before deciding whether to show the
 * login overlay at all.
 */

import type { DatabaseSync } from 'node:sqlite';

import {
  AuthSessionResponseSchema,
  HealthResponseSchema,
  LoginRequestSchema,
  LoginResponseSchema,
  type AuthSessionResponse,
  type Config,
  type HealthResponse,
  type LoginRequest,
  type LoginResponse,
} from '@ghostai/protocol';
import { systemClock, type Clock } from '@ghostai/core';
import type { FastifyReply, FastifyRequest, FastifySchema } from 'fastify';

import type { AuthStore } from './auth-store.js';
import { clearSessionCookie, sessionOf, setSessionCookie } from './auth.js';
import { badRequest, unauthorized } from './errors.js';
import type { RouteId } from './manifest.js';

/**
 * Login attempts per minute per address.
 *
 * Independent of `server.auth.rateLimitPerMinute`, and not disabled when that
 * is zero. The general limit protects the process from load; this one protects
 * a single password from being guessed, and an operator turning off the former
 * is not asking for the latter.
 */
export const LOGIN_ATTEMPTS_PER_MINUTE = 10;

export interface RouteRateLimit {
  readonly max: number;
  readonly timeWindowMs: number;
}

export interface RouteDefinition {
  /** Shown as the operation summary in the generated document. */
  readonly summary: string;
  /** Zod schemas; `jsonSchemaTransform` converts them for the document. */
  readonly schema: FastifySchema;
  readonly rateLimit?: RouteRateLimit;
  /**
   * A property rather than a method, and it matters: the router passes this
   * function to `app.route` detached from the object it was declared on, which
   * a method shorthand makes a `this`-scoping hazard.
   */
  readonly handler: (request: FastifyRequest, reply: FastifyReply) => unknown;
}

export interface RouteDeps {
  readonly config: Config;
  readonly auth: AuthStore;
  /** Pinged by the health check, which is the only honest liveness signal. */
  readonly database: DatabaseSync;
  /** Deferred: the document does not exist until the app is ready. */
  readonly openapiDocument: () => unknown;
  readonly clock?: Clock;
}

/** `SELECT 1` — the cheapest statement that proves the file is still readable. */
function databaseHealthy(database: DatabaseSync): boolean {
  try {
    database.prepare('SELECT 1').get();
    return true;
  } catch {
    return false;
  }
}

export function createRoutes(deps: RouteDeps): Record<RouteId, RouteDefinition> {
  const clock = deps.clock ?? systemClock;
  const authEnabled = deps.config.server.auth.enabled;

  return {
    'system.health': {
      summary: 'Liveness and the checks behind it',
      schema: { response: { 200: HealthResponseSchema } },
      handler: (): HealthResponse => {
        const storage = databaseHealthy(deps.database);
        return {
          // `fail` rather than `degraded`: with no database there is no session
          // to write a turn into, so nothing the server does still works.
          status: storage ? 'ok' : 'fail',
          checks: [
            {
              name: 'database',
              status: storage ? 'ok' : 'fail',
              detail: storage ? '' : 'the session database is not readable',
            },
          ],
        };
      },
    },

    'system.openapi': {
      summary: 'The generated OpenAPI 3.1 document',
      schema: {},
      handler: (): unknown => deps.openapiDocument(),
    },

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
