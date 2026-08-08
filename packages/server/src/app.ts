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
import fastifyStatic from '@fastify/static';
import swagger from '@fastify/swagger';
import websocket from '@fastify/websocket';
import {
  GhostError,
  silentLogger,
  systemClock,
  type Clock,
  type Logger,
} from '@ghostbot/core';
import type { Config } from '@ghostbot/protocol';
import type { RandomSource } from '@ghostbot/security';
import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';

import { AuthStore, type PasswordHasher } from './auth-store.js';
import { SESSION_COOKIE, createAuthHook, createSignedHook } from './auth.js';
import { assertBootPolicy } from './boot.js';
import { HttpError, registerErrorHandler } from './errors.js';
import type { SessionHub } from './hub.js';
import { LoginThrottle } from './login-throttle.js';
import { ROUTE_MANIFEST } from './manifest.js';
import { AutomationStore } from './automation-store.js';
import { NotificationStore } from './notifications.js';
import type { SchedulerPort } from './scheduler.js';
import type { ServerRuntime } from './runtime.js';
import {
  PROTOCOL_COMPONENTS,
  jsonSchemaTransform,
  jsonSerializerCompiler,
  zodValidatorCompiler,
} from './schema.js';
import { createRoutes } from './routes.js';
import { SERVER_VERSION } from './version.js';

export { SERVER_VERSION } from './version.js';

/** Long enough for a signed token over a deep workspace path, and no longer. */
const MAX_PARAM_LENGTH = 2048;

export interface ServerOptions {
  /**
   * The boot settings.
   *
   * Read once, here, for everything baked into the listener: the bind, the rate
   * limits, whether the auth hook checks anything. `runtime.config()` is the
   * live tree a settings save moves, and the routes read that one — but a live
   * toggle of `server.auth.enabled` is a request to unauthenticate an
   * already-authenticated session, so this one wins for the questions the hooks
   * ask.
   */
  readonly config: Config;
  /**
   * Everything below the transport, as an interface — see `runtime.ts` for why
   * this package states one rather than importing the composition root.
   */
  readonly runtime: ServerRuntime;
  /**
   * The hub the socket route serves.
   *
   * Built by the caller, not here: the hub needs an approval gate, and the gate
   * has to exist before the runtime is constructed — `createRuntime({ approvals })`
   * is what threads it into the loop. Untying that knot from inside this
   * function is not possible, and a hub built here would be a second one.
   */
  readonly hub: SessionHub;
  /**
   * A built single-page app to serve, and the SPA fallback that goes with it.
   *
   * Absent serves the API alone, which is what a test and a headless install
   * want. It is an option rather than a separate `app.register` afterwards
   * because `createServer` awaits `app.ready()` — after that Fastify accepts no
   * further routes, so anything the UI needs has to be decided here.
   */
  readonly ui?: UiOptions;
  /**
   * The connection `SessionStore` and the scheduler share.
   *
   * Required rather than opened here: one WAL is the point, and a server that
   * quietly opened its own would put auth writes in a second connection to the
   * same file and reintroduce the lock contention the sharing avoids.
   */
  readonly database: DatabaseSync;
  /**
   * The engine, read lazily.
   *
   * A getter rather than a value because of a knot: the scheduler is built over
   * the `AutomationStore` and `NotificationStore` that *this function* creates,
   * so it cannot exist before the call. The caller passes `() => scheduler`
   * over a binding it fills in afterwards — the same shape, for the same
   * reason, as `RouteDeps.openapiDocument`.
   *
   * Absent means no engine: the CRUD routes still work and only `run` refuses,
   * which is what a route test that never wanted a timer needs.
   */
  readonly scheduler?: () => SchedulerPort | undefined;
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
  /**
   * Sets the login name, and only in the same breath as `password`.
   *
   * This is `--username` and `GHOSTAI_USERNAME`. Alone it is a configuration
   * error rather than a no-op: rotating a name without a password would leave
   * sessions minted under the old credential alive, and silently ignoring the
   * flag would leave an operator convinced they had changed something.
   */
  readonly username?: string;
  /** Injected by tests; argon2id is ~50 ms per call by design. */
  readonly hasher?: PasswordHasher;
}

export interface UiOptions {
  /** The directory holding `index.html` and the hashed asset bundle. */
  readonly root: string;
  /**
   * The document a client-routed path falls back to. Defaults to `index.html`.
   *
   * The fallback is deliberately not applied under `/api` or `/ws`: a mistyped
   * route there is a 404 a client can read, and answering it with an HTML page
   * turns a typo into "the JSON parser failed", which is a much longer bug.
   */
  readonly index?: string;
}

interface ListenOptions {
  readonly host?: string;
  /** Overrides `server.port`. `0` asks the OS for a free one. */
  readonly port?: number;
}

export interface GhostServer {
  readonly app: FastifyInstance;
  readonly auth: AuthStore;
  /** Raised by the scheduler and the hub; read over `/api/notifications`. */
  readonly notifications: NotificationStore;
  /**
   * The jobs and runs the scheduler drives.
   *
   * Returned so the caller can build a `Scheduler` over it — the engine needs a
   * hub and a runtime that this function does not have, so it is constructed
   * outside and handed back in through `ServerOptions.scheduler`.
   */
  readonly automation: AutomationStore;
  readonly config: Config;
  /** Resolves to the bound address. */
  listen(options?: ListenOptions): Promise<string>;
  close(): Promise<void>;
}

/** Paths that must 404 as JSON rather than falling back to the SPA shell. */
const API_PREFIXES: readonly string[] = ['/api', '/ws'];

/**
 * Serves the built UI, and routes everything the router did not match to it.
 *
 * A single-page app owns its own URLs — `/settings`, `/session/abc` — and none
 * of them exist on the server, so a reload of any page but `/` is a 404 unless
 * the shell is served for it. That is the whole of the fallback, and its one
 * rule is the exclusion below: an unknown `/api` path is a client bug, and
 * answering it with HTML makes it surface as a JSON parse error somewhere else
 * entirely.
 */
async function registerUi(app: FastifyInstance, ui: UiOptions): Promise<void> {
  await app.register(fastifyStatic, {
    root: ui.root,
    // The API owns `/api`; the UI owns the rest of the origin. `index: false`
    // because the not-found fallback serves the shell, and letting the static
    // plugin do it too would mean two paths to the same file.
    index: false,
    wildcard: false,
  });
}

/** The fallback itself, installed into the one not-found handler. */
function spaFallback(
  ui: UiOptions,
): (request: FastifyRequest, reply: FastifyReply) => boolean {
  const index = ui.index ?? 'index.html';
  return (request, reply) => {
    if (
      request.method !== 'GET' ||
      API_PREFIXES.some((prefix) => request.url.startsWith(prefix))
    ) {
      return false;
    }
    void reply.sendFile(index);
    return true;
  };
}

/**
 * Builds the server. Throws rather than starting on a configuration that must
 * not be served — see `assertBootPolicy`.
 */
export async function createServer(
  options: ServerOptions,
): Promise<GhostServer> {
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

  if (options.password !== undefined) {
    await auth.setPassword(
      options.password,
      ...(options.username === undefined ? [] : [options.username]),
    );
  } else if (options.username !== undefined) {
    // A username with no password is refused rather than half-applied. Changing
    // the login name is changing a credential, and `setPassword` is the only
    // method that does it — deliberately, so a name can never move without the
    // sessions minted under the old one being revoked with it.
    throw new GhostError(
      'config',
      'A username can only be set alongside a password. Pass --password as well.',
    );
  }
  assertBootPolicy({ config });
  // A process that was down past a token's expiry comes back with dead rows and
  // no request that would ever look them up again.
  auth.purgeExpired();

  const app = Fastify({
    loggerInstance: logger,
    // Under `routerOptions` rather than at the top level: the flat form is
    // deprecated in Fastify 5 and warns once per route, which is a page of
    // FSTDEP022 on every boot and every test run.
    routerOptions: {
      // Fastify's default is 100 characters, which two routes here exceed as a
      // matter of course: a signed media token is a base64url payload naming a
      // workspace path plus a 43-character MAC, and a session key is whatever
      // the channel that opened it chose. Both would answer 414 to a perfectly
      // ordinary request.
      maxParamLength: MAX_PARAM_LENGTH,
    },
  });

  // Zod validates and Zod documents; Fastify's AJV is handed nothing. See
  // `schema.ts` for why feeding it draft-2020-12 output is the worse trade.
  app.setValidatorCompiler(zodValidatorCompiler);
  app.setSerializerCompiler(jsonSerializerCompiler);
  registerErrorHandler(
    app,
    options.ui === undefined ? {} : { onNotFound: spaFallback(options.ui) },
  );

  // Anything that is not JSON arrives as a `Buffer`, which is what makes the
  // upload a plain `POST` of the file rather than a multipart parser and the
  // dependency behind it. A browser sends a `File` this way with no encoding
  // step, and a base64 envelope would inflate every upload by a third to
  // restate what `Content-Type` already says.
  //
  // It is a catch-all, so it only ever sees a content type no other parser
  // claimed — and the global `bodyLimit` still applies to every route that did
  // not raise its own.
  app.addContentTypeParser(
    '*',
    { parseAs: 'buffer' },
    (request, body, done) => {
      done(null, body);
    },
  );

  await app.register(cookie);

  // Registered before the routes, because the plugin works through an `onRoute`
  // hook: a route declaring `wsHandler` before this ran would be an ordinary
  // GET that answers 426 to an upgrade request nobody reads.
  await app.register(websocket);

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
    errorResponseBuilder: (request, context) =>
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
        description: 'Generated from the Zod schemas in @ghostbot/protocol.',
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

  const clock = options.clock ?? systemClock;
  const notifications = new NotificationStore({
    database,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });

  // Built here rather than by the caller, so the two callers that compose a
  // server — `ghost serve` and the e2e harness — both get the automation
  // surface without either remembering to. `createServer` awaits `app.ready()`,
  // after which no route can be added, so anything the routes need is decided
  // at this point or not at all.
  const automation = new AutomationStore({
    database,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });

  // On the same connection as the sessions it guards, so a restart does not
  // hand an attacker a fresh counter — see `login-throttle.ts`.
  const loginThrottle = new LoginThrottle({
    database,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });

  const authenticate = createAuthHook({ config, auth });
  const verifySignature = createSignedHook({
    auth,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });

  const routes = createRoutes({
    config,
    runtime: options.runtime,
    hub: options.hub,
    auth,
    loginThrottle,
    notifications,
    automation,
    database,
    openapiDocument: () => app.swagger(),
    startedAt: clock.monotonic(),
    ...(options.scheduler === undefined
      ? {}
      : { scheduler: options.scheduler }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });

  for (const spec of ROUTE_MANIFEST) {
    const route = routes[spec.id];
    const hook =
      spec.auth === 'required'
        ? authenticate
        : spec.auth === 'signed'
          ? verifySignature
          : undefined;
    app.route({
      method: spec.method,
      url: spec.url,
      schema: {
        ...route.schema,
        summary: route.summary,
        operationId: spec.id,
        // Either carrier satisfies it, which is what a list of two alternatives
        // means in OpenAPI. A `signed` route lists neither: its credential is
        // the path, and a document that named a scheme here would tell a client
        // to attach one that is not accepted.
        security:
          spec.auth === 'required'
            ? [{ cookieAuth: [] }, { bearerAuth: [] }]
            : [],
      },
      ...(hook === undefined ? {} : { onRequest: hook }),
      ...(route.wsHandler === undefined ? {} : { wsHandler: route.wsHandler }),
      ...(route.bodyLimit === undefined ? {} : { bodyLimit: route.bodyLimit }),
      ...(route.rateLimit === undefined
        ? {}
        : {
            config: {
              rateLimit: {
                max: route.rateLimit.max,
                timeWindow: route.rateLimit.timeWindowMs,
              },
            },
          }),
      handler: route.handler,
    });
  }

  if (options.ui !== undefined) await registerUi(app, options.ui);

  await app.ready();

  return {
    app,
    auth,
    notifications,
    automation,
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
