/**
 * Every route the server serves, and what it takes to reach it.
 *
 * The router registers *from* this array rather than beside it, which is the
 * whole reason it exists: the auth matrix test iterates the same list, so a
 * route that appears here in any state other than the one it was written for
 * fails a test, and a route that does not appear here is not served at all.
 * "Remembered to add the auth hook" is not a property a codebase can hold onto
 * across a hundred routes; "cannot be registered without saying which it is"
 * is.
 *
 * `id` is what ties an entry to its implementation. `createRoutes` returns a
 * `Record<RouteId, RouteDefinition>`, so a manifest entry with no handler and a
 * handler with no manifest entry are both type errors rather than a 404 found
 * later.
 */

/**
 * - `public` — no credential needed, ever. Two routes qualify: the liveness
 *   probe, and the login that mints the credential.
 * - `required` — a valid session cookie or bearer token, unless authentication
 *   is disabled for the whole server.
 * - `signed` — the credential is in the URL: an HMAC-signed, expiring token
 *   naming one workspace path. Exactly one route uses it, because `<img src>`
 *   can carry neither a header nor, reliably, a `SameSite=Strict` cookie. A
 *   session is *not* accepted there and a signature is not accepted anywhere
 *   else, so neither carrier widens the other's reach.
 */
export type RouteAuth = 'public' | 'required' | 'signed';

export type RouteMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

const MANIFEST = [
  // Status and health
  { id: 'system.health', method: 'GET', url: '/api/health', auth: 'public' },
  { id: 'system.status', method: 'GET', url: '/api/status', auth: 'required' },
  { id: 'system.openapi', method: 'GET', url: '/api/openapi.json', auth: 'required' },

  // The socket. In the manifest like everything else, and `required` like
  // almost everything else: an unauthenticated upgrade is a shell-capable agent
  // that anyone who can reach the port may drive, which is the exact failure
  // `assertBootPolicy` refuses to start for.
  { id: 'ws.connect', method: 'GET', url: '/ws', auth: 'required' },

  // Auth
  { id: 'auth.login', method: 'POST', url: '/api/auth/login', auth: 'public' },
  { id: 'auth.logout', method: 'POST', url: '/api/auth/logout', auth: 'required' },
  { id: 'auth.me', method: 'GET', url: '/api/auth/me', auth: 'required' },

  // First-run setup. Two of the three are `public`, which is deliberate and is
  // the only widening of the public surface since it was two routes:
  // `setup.status` answers one bit an attacker learns anyway by watching every
  // login fail, and `setup.claim` is the login for an install that has no
  // password yet — it spends a single-use code that only the operator's own
  // terminal ever saw. Both stop existing the moment a password is set.
  { id: 'setup.status', method: 'GET', url: '/api/setup', auth: 'public' },
  { id: 'setup.claim', method: 'POST', url: '/api/setup/claim', auth: 'public' },
  { id: 'setup.password', method: 'POST', url: '/api/setup/password', auth: 'required' },

  // Settings and credentials
  { id: 'settings.get', method: 'GET', url: '/api/settings', auth: 'required' },
  { id: 'settings.patch', method: 'PATCH', url: '/api/settings', auth: 'required' },
  { id: 'settings.credential', method: 'PUT', url: '/api/settings/credentials', auth: 'required' },
  // A POST because it is not idempotent in the way that matters: it rebuilds
  // the provider, the loops and the tool registry, and doing that twice is two
  // rebuilds. Under `/api/settings` rather than `/api/system` because what it
  // re-reads is the settings file — the process it belongs to keeps running.
  { id: 'settings.reload', method: 'POST', url: '/api/settings/reload', auth: 'required' },

  // Providers and models
  { id: 'providers.list', method: 'GET', url: '/api/providers', auth: 'required' },
  // A POST because it opens a socket to somewhere else, and not
  // `/api/providers/:id/test` because the thing most worth testing is a
  // connection that has not been saved yet — an id-shaped route would force a
  // write before the check the check exists to precede.
  { id: 'providers.test', method: 'POST', url: '/api/providers/test', auth: 'required' },
  { id: 'models.list', method: 'GET', url: '/api/models', auth: 'required' },
  { id: 'models.refresh', method: 'POST', url: '/api/models/refresh', auth: 'required' },

  // Sessions, messages, context
  { id: 'sessions.list', method: 'GET', url: '/api/sessions', auth: 'required' },
  { id: 'sessions.create', method: 'POST', url: '/api/sessions', auth: 'required' },
  { id: 'sessions.get', method: 'GET', url: '/api/sessions/:key', auth: 'required' },
  { id: 'sessions.update', method: 'PATCH', url: '/api/sessions/:key', auth: 'required' },
  { id: 'sessions.delete', method: 'DELETE', url: '/api/sessions/:key', auth: 'required' },
  { id: 'sessions.messages', method: 'GET', url: '/api/sessions/:key/messages', auth: 'required' },
  { id: 'sessions.clear', method: 'DELETE', url: '/api/sessions/:key/messages', auth: 'required' },
  { id: 'sessions.context', method: 'GET', url: '/api/sessions/:key/context', auth: 'required' },
  { id: 'sessions.branch', method: 'POST', url: '/api/sessions/:key/branch', auth: 'required' },
  { id: 'sessions.turns', method: 'GET', url: '/api/sessions/:key/turns', auth: 'required' },

  // Agents and tools. Both read-only: an agent is a subtree of the settings
  // tree, so it is created and edited through `settings.patch`.
  { id: 'agents.list', method: 'GET', url: '/api/agents', auth: 'required' },
  { id: 'tools.list', method: 'GET', url: '/api/tools', auth: 'required' },
  { id: 'toolboxes.list', method: 'GET', url: '/api/toolboxes', auth: 'required' },

  // Files, upload and signed media
  { id: 'files.list', method: 'GET', url: '/api/files', auth: 'required' },
  { id: 'files.delete', method: 'DELETE', url: '/api/files', auth: 'required' },
  { id: 'files.upload', method: 'POST', url: '/api/files/upload', auth: 'required' },
  { id: 'files.read', method: 'GET', url: '/api/files/text', auth: 'required' },
  { id: 'files.write', method: 'PUT', url: '/api/files/text', auth: 'required' },
  { id: 'files.mkdir', method: 'POST', url: '/api/files/directory', auth: 'required' },
  { id: 'files.move', method: 'POST', url: '/api/files/move', auth: 'required' },
  { id: 'files.sign', method: 'POST', url: '/api/files/signed-url', auth: 'required' },
  { id: 'media.get', method: 'GET', url: '/api/media/:token', auth: 'signed' },

  // Workspaces
  { id: 'workspaces.list', method: 'GET', url: '/api/workspaces', auth: 'required' },
  { id: 'workspaces.create', method: 'POST', url: '/api/workspaces', auth: 'required' },
  { id: 'workspaces.update', method: 'PATCH', url: '/api/workspaces/:id', auth: 'required' },
  { id: 'workspaces.delete', method: 'DELETE', url: '/api/workspaces/:id', auth: 'required' },
  {
    id: 'workspaces.moveSessions',
    method: 'POST',
    url: '/api/workspaces/:id/sessions/move',
    auth: 'required',
  },

  // Notifications
  { id: 'notifications.list', method: 'GET', url: '/api/notifications', auth: 'required' },
  { id: 'notifications.readAll', method: 'POST', url: '/api/notifications/read', auth: 'required' },
  {
    id: 'notifications.read',
    method: 'POST',
    url: '/api/notifications/:id/read',
    auth: 'required',
  },
  { id: 'notifications.delete', method: 'DELETE', url: '/api/notifications/:id', auth: 'required' },
] as const;

export type RouteId = (typeof MANIFEST)[number]['id'];

export interface RouteSpec {
  readonly id: RouteId;
  readonly method: RouteMethod;
  readonly url: string;
  readonly auth: RouteAuth;
}

/**
 * Exported as the wide type, not the literal one.
 *
 * `as const satisfies readonly RouteSpec[]` is what this wants to be, and
 * `isolatedDeclarations` cannot emit a declaration for it (TS9010). The literal
 * array stays private for `RouteId`; this is the view to read, and the
 * assignment is what type-checks every entry.
 */
export const ROUTE_MANIFEST: readonly RouteSpec[] = MANIFEST;
