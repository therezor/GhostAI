/**
 * What a route is, and what every route may reach.
 *
 * Split out of `routes.ts` so the handler modules and the composer can both
 * import it without importing each other. Nothing here registers anything: a
 * `RouteDefinition` is inert until the router joins it to a `ROUTE_MANIFEST`
 * entry by id.
 */

import type { DatabaseSync } from 'node:sqlite';

import type { WebSocket } from '@fastify/websocket';
import type { Clock, Logger } from '@ghostbot/core';
import type { Config } from '@ghostbot/protocol';
import type { FastifyReply, FastifyRequest, FastifySchema } from 'fastify';

import type { AutomationStore } from '../automation-store.js';
import type { AuthStore } from '../auth-store.js';
import type { SessionHub } from '../hub.js';
import type { LoginThrottle } from '../login-throttle.js';
import type { RouteId } from '../manifest.js';
import type { NotificationStore } from '../notifications.js';
import type { ServerRuntime } from '../runtime.js';
import type { SchedulerPort } from '../scheduler.js';

/**
 * One module's slice of the route table, keyed by the ids it owns.
 *
 * Spelling the ids out is what keeps the manifest↔handler join a type error
 * rather than a 404: a group typed as `Record<string, RouteDefinition>` would
 * satisfy the composer no matter which routes it forgot, because a string index
 * signature covers every key.
 */
export type RouteGroup<K extends RouteId> = Readonly<
  Record<K, RouteDefinition>
>;

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
   * Overrides Fastify's 1 MiB body cap for this route only.
   *
   * Only the upload wants it. Raising the global limit instead would let every
   * other route buffer the same amount before anything has looked at it.
   */
  readonly bodyLimit?: number;
  /**
   * A property rather than a method, and it matters: the router passes this
   * function to `app.route` detached from the object it was declared on, which
   * a method shorthand makes a `this`-scoping hazard.
   */
  readonly handler: (request: FastifyRequest, reply: FastifyReply) => unknown;
  /**
   * Handles the request when it is a WebSocket upgrade.
   *
   * Declared beside `handler` rather than replacing it, which is what
   * `{ websocket: true }` would do: that form hides the route from the
   * generated document and answers a plain GET with a bare 404, and both are
   * things this repo checks. With both present the ordinary handler still runs
   * for an ordinary request — 426, in the one error envelope — and the route
   * stays in the manifest, in the auth matrix and in the OpenAPI document.
   */
  readonly wsHandler?: (socket: WebSocket, request: FastifyRequest) => void;
}

export interface RouteDeps {
  /**
   * The settings the *listener* was built with.
   *
   * Deliberately distinct from `runtime.config()`, which is live. Host, port,
   * rate limits and `auth.enabled` were read once at boot and are baked into
   * plugins and hooks; reporting a patched value for them would describe a
   * server that is not running. Everything a route reads for its own answer
   * comes from `runtime.config()` instead.
   */
  readonly config: Config;
  readonly runtime: ServerRuntime;
  /**
   * The one hub in the process.
   *
   * Required, not optional: it is what the socket route serves, and a server
   * built without one would register `GET /ws` — which the manifest says is
   * served — over nothing. Building it is the caller's job because the approval
   * gate has to exist before the runtime that the hub then drives.
   */
  readonly hub: SessionHub;
  readonly auth: AuthStore;
  /**
   * The brute-force throttle the credential routes share.
   *
   * One instance, and shared rather than one per route, because the account
   * scope is only meaningful if every guess at the account lands in it — a
   * login and a setup code are two credentials for the same single account, and
   * two throttles would give an attacker two budgets.
   */
  readonly loginThrottle: LoginThrottle;
  readonly notifications: NotificationStore;
  readonly automation: AutomationStore;
  /**
   * The engine, deferred for the reason `openapiDocument` is.
   *
   * It is built over the notification store `createServer` returns, so it does
   * not exist when `createRoutes` runs. Absent means this build has no engine —
   * the CRUD routes still work, so an operator can author jobs, and only
   * `automation.run` refuses.
   */
  readonly scheduler?: () => SchedulerPort | undefined;
  /** Pinged by the health check, which is the only honest liveness signal. */
  readonly database: DatabaseSync;
  /** Deferred: the document does not exist until the app is ready. */
  readonly openapiDocument: () => unknown;
  /** Monotonic, from the injected clock, so `uptimeMs` survives an NTP step. */
  readonly startedAt: number;
  readonly clock?: Clock;
  readonly logger?: Logger;
}
