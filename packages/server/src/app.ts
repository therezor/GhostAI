/**
 * The Fastify instance: one port for the API, the WebSocket and the UI.
 *
 * Single-process by default, and single-port with it. Nothing GhostAI does is
 * heavy enough to justify splitting the API from the socket, and a split would
 * cost every client a second origin to configure, a second certificate to
 * trust, and a reconnect story that has to survive one half being up.
 *
 * Construction order matters and is not arbitrary:
 *
 *  1. The auth store opens its tables and any provided password is written, so
 *     that
 *  2. `assertBootPolicy` can ask whether a login could ever succeed — and
 *     refuse *before* a listener exists, when there is nothing to unwind.
 *  3. Plugins register outermost-first: rate limiting before authentication, so
 *     a flood of bad passwords is rejected before it reaches argon2id.
 *  4. Routes register from the manifest, which is the only path to a served
 *     route.
 */

import type { DatabaseSync } from 'node:sqlite';

import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import { silentLogger, type Clock, type Logger } from '@ghostai/core';
import type { Config } from '@ghostai/protocol';
import type { RandomSource } from '@ghostai/security';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';

import { AuthStore, type PasswordHasher } from './auth-store.js';
import { SESSION_COOKIE, createAuthHook } from './auth.js';
import { assertBootPolicy } from './boot.js';
import { HttpError, registerErrorHandler } from './errors.js';
import { ROUTE_MANIFEST } from './manifest.js';
import {
  PROTOCOL_COMPONENTS,
  jsonSchemaTransform,
  jsonSerializerCompiler,
  zodValidatorCompiler,
} from './schema.js';
import { createRoutes } from './routes.js';

/** Kept in step with `package.json` by `app.test.ts`. */
export const SERVER_VERSION = '0.0.0';

export interface ServerOptions {
  readonly config: Config;
  /**
   * The connection `SessionStore`, the scheduler and the knowledge base share.
   *
   * Required rather than opened here: one WAL is the point, and a server that
   * quietly opened its own would put auth writes in a second connection to the
   * same file and reintroduce the lock contention the sharing avoids.
   */
  readonly database: DatabaseSync;
  readonly logger?: Logger;
  readonly clock?: Clock;
  readonly random?: RandomSource;
  /**
   * Sets or rotates the password at boot, then is not retained.
   *
   * This is how `--password` and `GHOSTAI_PASSWORD` reach the store. Reading
   * the environment is deliberately the caller's job — a server that read it
   * itself would be untestable without mutating `process.env`.
   */
  readonly password?: string;
  /** Injected by tests; argon2id is ~50 ms per call by design. */
  readonly hasher?: PasswordHasher;
}

export interface ListenOptions {
  readonly host?: string;
  /** Overrides `server.port`. `0` asks the OS for a free one. */
  readonly port?: number;
}

export interface GhostServer {
  readonly app: FastifyInstance;
  readonly auth: AuthStore;
  readonly config: Config;
  /** Resolves to the bound address. */
  listen(options?: ListenOptions): Promise<string>;
  close(): Promise<void>;
}

/**
 * Builds the server. Throws rather than starting on a configuration that must
 * not be served — see `assertBootPolicy`.
 */
export async function createServer(options: ServerOptions): Promise<GhostServer> {
  const { config, database } = options;
  // Annotated as Fastify's own logger interface rather than pino's. Passing a
  // `pino.Logger` narrows the instance's logger type parameter, and every
  // helper taking a plain `FastifyInstance` then fails to accept it — for a
  // `msgPrefix` getter nothing in this package reads.
  const logger: FastifyBaseLogger = options.logger ?? silentLogger;

  const auth = new AuthStore({
    database,
    sessionTtlMs: config.server.auth.sessionTtlMs,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.random === undefined ? {} : { random: options.random }),
    ...(options.hasher === undefined ? {} : { hasher: options.hasher }),
  });

  if (options.password !== undefined) await auth.setPassword(options.password);
  assertBootPolicy({ config, hasPassword: auth.hasPassword() });
  // A process that was down past a token's expiry comes back with dead rows and
  // no request that would ever look them up again.
  auth.purgeExpired();

  const app = Fastify({ loggerInstance: logger });

  // Zod validates and Zod documents; Fastify's AJV is handed nothing. See
  // `schema.ts` for why feeding it draft-2020-12 output is the worse trade.
  app.setValidatorCompiler(zodValidatorCompiler);
  app.setSerializerCompiler(jsonSerializerCompiler);
  registerErrorHandler(app);

  await app.register(cookie);

  const perMinute = config.server.auth.rateLimitPerMinute;
  await app.register(rateLimit, {
    // `0` means no limit, the same convention every other `*PerMinute` field
    // in the config uses. Per-route limits still apply — the login's does not
    // come from this setting and is not switched off with it.
    global: perMinute > 0,
    max: perMinute > 0 ? perMinute : Number.MAX_SAFE_INTEGER,
    timeWindow: 60_000,
    // The plugin *throws* whatever this returns, so it has to be an `Error` —
    // a plain body object arrives at the error handler as an unrecognised
    // value and becomes a 500. An `HttpError` carries the status and the code
    // through to the one place a response body is built.
    errorResponseBuilder: (_request, context) =>
      new HttpError(
        429,
        'rate_limited',
        'rate_limited',
        `Rate limit exceeded. Retry in ${context.after}.`,
      ),
  });

  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'GhostAI',
        version: SERVER_VERSION,
        description: 'Generated from the Zod schemas in @ghostai/protocol.',
      },
      components: {
        // The `$defs` pool: every protocol schema, so a route references rather
        // than restates. Restating is how a document starts lying.
        schemas: PROTOCOL_COMPONENTS as Record<string, never>,
        securitySchemes: {
          cookieAuth: { type: 'apiKey', in: 'cookie', name: SESSION_COOKIE },
          bearerAuth: { type: 'http', scheme: 'bearer' },
        },
      },
    },
    transform: jsonSchemaTransform,
  });

  const authenticate = createAuthHook({ config, auth });
  const routes = createRoutes({
    config,
    auth,
    database,
    openapiDocument: () => app.swagger(),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });

  for (const spec of ROUTE_MANIFEST) {
    const route = routes[spec.id];
    const required = spec.auth === 'required';
    app.route({
      method: spec.method,
      url: spec.url,
      schema: {
        ...route.schema,
        summary: route.summary,
        operationId: spec.id,
        // Either carrier satisfies it, which is what a list of two alternatives
        // means in OpenAPI.
        security: required ? [{ cookieAuth: [] }, { bearerAuth: [] }] : [],
      },
      ...(required ? { onRequest: authenticate } : {}),
      ...(route.rateLimit === undefined
        ? {}
        : {
            config: {
              rateLimit: { max: route.rateLimit.max, timeWindow: route.rateLimit.timeWindowMs },
            },
          }),
      handler: route.handler,
    });
  }

  await app.ready();

  return {
    app,
    auth,
    config,
    listen: async (listenOptions: ListenOptions = {}): Promise<string> =>
      await app.listen({
        host: listenOptions.host ?? config.server.host,
        port: listenOptions.port ?? config.server.port,
      }),
    close: async (): Promise<void> => {
      await app.close();
    },
  };
}
