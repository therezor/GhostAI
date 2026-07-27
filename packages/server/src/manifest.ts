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
 *
 * `signed` — the HMAC-signed media URL an `<img src>` can carry — arrives in
 * Step 13 alongside the code that verifies a signature. A variant that nothing
 * can enforce is worse than one that does not exist yet.
 */
export type RouteAuth = 'public' | 'required';

export type RouteMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

const MANIFEST = [
  { id: 'system.health', method: 'GET', url: '/api/health', auth: 'public' },
  { id: 'system.openapi', method: 'GET', url: '/api/openapi.json', auth: 'required' },
  { id: 'auth.login', method: 'POST', url: '/api/auth/login', auth: 'public' },
  { id: 'auth.logout', method: 'POST', url: '/api/auth/logout', auth: 'required' },
  { id: 'auth.me', method: 'GET', url: '/api/auth/me', auth: 'required' },
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
