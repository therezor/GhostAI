import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { ConfigSchema, type Config } from '@ghostai/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { SERVER_VERSION, createServer, type GhostServer } from '#src/app.js';
import type { PasswordHasher } from '#src/auth-store.js';
import { SESSION_COOKIE } from '#src/auth.js';
import type { SessionHub } from '#src/hub.js';
import { LoginThrottle } from '#src/login-throttle.js';
import { ROUTE_MANIFEST, type RouteSpec } from '#src/manifest.js';
import { AutomationStore } from '#src/automation-store.js';
import { NotificationStore } from '#src/notifications.js';
import { createRoutes } from '#src/routes.js';
import { createTestHub } from '#testkit/hub.js';
import { createFakeRuntime } from '#testkit/runtime.js';

const PASSWORD = 'a-test-password';
const USERNAME = 'ghost';

/** argon2id is ~50 ms a call by design; a matrix that logs in 25 times cannot pay it. */
const fakeHasher: PasswordHasher = {
  hash: async (password) => `fake:${password}`,
  verify: async (digest, password) => digest === `fake:${password}`,
};

const started: GhostServer[] = [];
const opened: DatabaseSync[] = [];
const workspaces: string[] = [];
const hubs: SessionHub[] = [];

afterEach(async () => {
  while (hubs.length > 0) hubs.pop()?.close();
  while (started.length > 0) await started.pop()?.close();
  while (opened.length > 0) opened.pop()?.close();
  while (workspaces.length > 0) rmSync(workspaces.pop() ?? '', { recursive: true, force: true });
});

function config(server: Record<string, unknown> = {}): Config {
  return ConfigSchema.parse({ server });
}

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'ghostai-app-'));
  workspaces.push(root);
  return root;
}

/**
 * The two collaborators `createServer` will not build for itself, as a pair.
 *
 * The hub is required because the socket route is in the manifest; the tests
 * below are about boot policy and health, so neither is anything they have an
 * opinion about.
 */
function collaborators(
  database: DatabaseSync,
  settings: Config = config(),
): { runtime: ReturnType<typeof createFakeRuntime>; hub: SessionHub } {
  const runtime = createFakeRuntime({ database, workspace: workspace(), config: settings });
  const { hub } = createTestHub(runtime.store, settings);
  hubs.push(hub);
  return { runtime, hub };
}

interface StartOptions {
  readonly config?: Config;
  readonly password?: string | null;
}

async function start(options: StartOptions = {}): Promise<GhostServer> {
  const database = new DatabaseSync(':memory:');
  opened.push(database);
  const settings = options.config ?? config();
  const runtime = createFakeRuntime({ database, workspace: workspace(), config: settings });
  const { hub } = createTestHub(runtime.store, settings);
  hubs.push(hub);
  const server = await createServer({
    config: settings,
    runtime,
    hub,
    database,
    hasher: fakeHasher,
    ...(options.password === null ? {} : { password: options.password ?? PASSWORD }),
  });
  started.push(server);
  return server;
}

// ---------------------------------------------------------------------------
// The auth matrix
// ---------------------------------------------------------------------------

type StateName = 'no credential' | 'bad cookie' | 'good cookie' | 'bad bearer' | 'good bearer';

const STATES: readonly StateName[] = [
  'no credential',
  'bad cookie',
  'good cookie',
  'bad bearer',
  'good bearer',
];

const ACCEPTED: ReadonlySet<StateName> = new Set<StateName>(['good cookie', 'good bearer']);

function headersFor(state: StateName, token: string): Record<string, string> {
  switch (state) {
    case 'no credential':
      return {};
    case 'bad cookie':
      return { cookie: `${SESSION_COOKIE}=deadbeef.notatoken` };
    case 'good cookie':
      return { cookie: `${SESSION_COOKIE}=${token}` };
    case 'bad bearer':
      return { authorization: 'Bearer deadbeef.notatoken' };
    case 'good bearer':
      return { authorization: `Bearer ${token}` };
  }
}

/**
 * A body good enough to get past validation, per route.
 *
 * The matrix is about *reaching* a handler, not about what it answers, so every
 * route with a required body needs one that parses — otherwise a 422 from the
 * validator would be indistinguishable from a rejection by the auth hook.
 */
const PAYLOADS: Readonly<Record<string, Record<string, unknown>>> = {
  'auth.login': { username: USERNAME, password: PASSWORD },
  'setup.claim': { code: 'AAAA-BBBB-CCCC' },
  'setup.password': { password: 'set-from-the-matrix', currentPassword: PASSWORD },
  'settings.patch': { agents: { defaults: { temperature: 0.5 } } },
  'settings.credential': { namespace: 'providers', key: 'openai', value: 'sk-test' },
  'sessions.create': { title: 'from the matrix' },
  'sessions.update': { title: 'renamed' },
  'files.sign': { path: 'note.txt' },
  'files.write': { path: 'note.txt', content: 'from the matrix' },
  'files.mkdir': { path: 'from-the-matrix' },
};

/** Query parameters a route needs before its handler is reached. */
const QUERIES: Readonly<Record<string, string>> = {
  'files.delete': '?path=note.txt',
  'files.upload': '?path=note.txt',
  'files.read': '?path=note.txt',
};

/** The path as the document spells it: Fastify's `:key` is OpenAPI's `{key}`. */
function documentPath(url: string): string {
  return url.replaceAll(/:(\w+)/g, '{$1}');
}

function urlFor(spec: RouteSpec): string {
  return (
    spec.url.replace(':key', 'a-session').replace(':id', 'an-id').replace(':token', 'not.a.token') +
    (QUERIES[spec.id] ?? '')
  );
}

/**
 * The table-driven matrix.
 *
 * It iterates `ROUTE_MANIFEST` rather than a list written beside it, so a route
 * added to the manifest is covered the moment it exists — and one that is not in
 * the manifest is not served at all.
 *
 * What it asserts is deliberately narrow: an unauthenticated caller gets a 401,
 * and an authenticated one gets *something other than* a 401. Insisting on a 2xx
 * would make this a test of every handler's happy path — needing a seeded
 * session, an existing file and a real notification id — and it would then fail
 * for reasons that have nothing to do with authentication, which is the one
 * property the manifest exists to guarantee.
 */
describe('auth matrix', () => {
  describe.each(ROUTE_MANIFEST)('$method $url ($auth)', (spec: RouteSpec) => {
    it.each(STATES)('%s', async (state) => {
      const server = await start();
      // A fresh token per case: `auth.logout` revokes the one it was given.
      const token = server.auth.issue('test').token;
      const response = await server.app.inject({
        method: spec.method,
        url: urlFor(spec),
        headers: headersFor(state, token),
        ...(spec.id in PAYLOADS ? { payload: PAYLOADS[spec.id] } : {}),
      });

      // A signed route's credential is in the URL, and the matrix never has a
      // valid one — so a session must not open it, in any state.
      if (spec.auth === 'signed') {
        expect(response.statusCode).toBe(401);
        return;
      }

      if (spec.auth === 'public' || ACCEPTED.has(state)) {
        expect(response.statusCode).not.toBe(401);
      } else {
        expect(response.statusCode).toBe(401);
        expect(response.json()).toEqual({
          error: { code: 'unauthorized', message: expect.any(String) },
        });
      }
    });
  });

  it('lets every route through when authentication is disabled', async () => {
    const server = await start({
      config: config({ auth: { enabled: false } }),
      password: null,
    });

    for (const spec of ROUTE_MANIFEST) {
      const response = await server.app.inject({
        method: spec.method,
        url: urlFor(spec),
        ...(spec.id in PAYLOADS ? { payload: PAYLOADS[spec.id] } : {}),
      });
      // The signature is not a login and is not switched off with one.
      const expected = spec.auth === 'signed' ? 401 : 'not 401';
      expect({ id: spec.id, status: response.statusCode === 401 ? 401 : 'not 401' }).toEqual({
        id: spec.id,
        status: expected,
      });
    }
  });

  it('rejects a token that expired since it was issued', async () => {
    const server = await start({ config: config({ auth: { sessionTtlMs: 1 } }) });
    const token = server.auth.issue().token;
    await new Promise((resolve) => setTimeout(resolve, 5));

    const response = await server.app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(401);
  });

  // Both directions of the manifest↔handler join. The type checker enforces it
  // too, but only for code that compiles; this fails the same way at runtime.
  it('has exactly one handler per manifest entry', async () => {
    const server = await start();
    const database = new DatabaseSync(':memory:');
    opened.push(database);
    const runtime = createFakeRuntime({ database, workspace: workspace() });
    const { hub } = createTestHub(runtime.store);
    hubs.push(hub);
    const ids = Object.keys(
      createRoutes({
        config: server.config,
        runtime,
        hub,
        auth: server.auth,
        loginThrottle: new LoginThrottle({ database }),
        notifications: new NotificationStore({ database }),
        automation: new AutomationStore({ database }),
        database,
        openapiDocument: () => ({}),
        startedAt: 0,
      }),
    );

    expect(ids.sort()).toEqual(ROUTE_MANIFEST.map((spec) => spec.id).sort());
  });
});

// ---------------------------------------------------------------------------
// First-run setup
// ---------------------------------------------------------------------------

describe('setup', () => {
  it('reports an install with no password as needing to be claimed', async () => {
    const server = await start({ password: null });
    const response = await server.app.inject({ method: 'GET', url: '/api/setup' });

    expect(response.statusCode).toBe(200);
    // One bit and nothing else. An unauthenticated caller learns this anyway by
    // watching every login fail; describing an unclaimed agent any further
    // would be telling whoever asked first what they had found.
    expect(response.json()).toEqual({ required: true });
  });

  it('reports a claimed install as not needing setup', async () => {
    const server = await start();
    const response = await server.app.inject({ method: 'GET', url: '/api/setup' });
    expect(response.json()).toEqual({ required: false });
  });

  it('reports no setup needed when authentication is off', async () => {
    // There is nothing to claim: the server is reachable without a credential
    // by design, and asking for a password that would never be checked is
    // security theatre with a login form.
    const server = await start({ config: config({ auth: { enabled: false } }), password: null });
    const response = await server.app.inject({ method: 'GET', url: '/api/setup' });
    expect(response.json()).toEqual({ required: false });
  });

  it('exchanges the one-time code for a session that works', async () => {
    const server = await start({ password: null });
    const code = server.auth.issueSetupCode();

    const claim = await server.app.inject({
      method: 'POST',
      url: '/api/setup/claim',
      payload: { code },
    });

    expect(claim.statusCode).toBe(200);
    const token = claim.cookies.find((entry) => entry.name === SESSION_COOKIE)?.value ?? '';
    expect(token).not.toBe('');
    // The code is a login, so it gets the same cookie treatment: a token in the
    // body is a token an injected script can read.
    expect(claim.payload).not.toContain(token);
    expect(claim.payload).not.toContain(code);

    const me = await server.app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: `${SESSION_COOKIE}=${token}` },
    });
    expect(me.statusCode).toBe(200);
  });

  it('refuses a wrong code with a 401 and no cookie', async () => {
    const server = await start({ password: null });
    server.auth.issueSetupCode();

    const response = await server.app.inject({
      method: 'POST',
      url: '/api/setup/claim',
      payload: { code: 'ZZZZ-ZZZZ-ZZZZ' },
    });

    expect(response.statusCode).toBe(401);
    expect(response.cookies).toHaveLength(0);
  });

  it('refuses to claim an install that already has a password', async () => {
    const server = await start();
    const response = await server.app.inject({
      method: 'POST',
      url: '/api/setup/claim',
      payload: { code: 'AAAA-BBBB-CCCC' },
    });

    // Not a 401: the code is not wrong, the install is claimed and the caller
    // should be signing in with the password.
    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toMatch(/already has a password/);
  });

  it('sets the password and keeps the caller signed in', async () => {
    const server = await start({ password: null });
    const code = server.auth.issueSetupCode();
    const claim = await server.app.inject({
      method: 'POST',
      url: '/api/setup/claim',
      payload: { code },
    });
    const claimed = claim.cookies.find((entry) => entry.name === SESSION_COOKIE)?.value ?? '';

    const set = await server.app.inject({
      method: 'POST',
      url: '/api/setup/password',
      headers: { cookie: `${SESSION_COOKIE}=${claimed}` },
      payload: { password: 'chosen-in-the-wizard' },
    });

    expect(set.statusCode).toBe(200);
    // `setPassword` revokes every session including the caller's own, so
    // without a re-issue the browser is signed out mid-wizard with the code it
    // would need to get back in already spent.
    const reissued = set.cookies.find((entry) => entry.name === SESSION_COOKIE)?.value ?? '';
    expect(reissued).not.toBe('');
    expect(reissued).not.toBe(claimed);

    const me = await server.app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: `${SESSION_COOKIE}=${reissued}` },
    });
    expect(me.statusCode).toBe(200);

    // And the old one is genuinely dead.
    const stale = await server.app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: `${SESSION_COOKIE}=${claimed}` },
    });
    expect(stale.statusCode).toBe(401);
  });

  /**
   * A session is not enough to rotate the credential it was minted from.
   *
   * The cookie is `httpOnly`, but this application renders markdown a language
   * model wrote, and the failure being closed here is an injection that changes
   * the password and locks the operator out of their own agent.
   */
  it('demands the current password once one exists', async () => {
    const server = await start();
    const token = server.auth.issue('test').token;

    const missing = await server.app.inject({
      method: 'POST',
      url: '/api/setup/password',
      headers: { authorization: `Bearer ${token}` },
      payload: { password: 'chosen-in-the-panel' },
    });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error.message).toMatch(/current password/);

    const wrong = await server.app.inject({
      method: 'POST',
      url: '/api/setup/password',
      headers: { authorization: `Bearer ${token}` },
      payload: { password: 'chosen-in-the-panel', currentPassword: 'not-the-old-one' },
    });
    expect(wrong.statusCode).toBe(401);

    // The old password still works, because neither refusal wrote anything.
    expect(await server.auth.verifyLogin('ghost', PASSWORD)).toBe(true);
  });

  it('rotates the password and the username together', async () => {
    const server = await start();
    const token = server.auth.issue('test').token;

    const response = await server.app.inject({
      method: 'POST',
      url: '/api/setup/password',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        username: 'Operator',
        password: 'chosen-in-the-panel',
        currentPassword: PASSWORD,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(server.auth.username()).toBe('operator');
    expect(await server.auth.verifyLogin('operator', 'chosen-in-the-panel')).toBe(true);
    expect(await server.auth.verifyLogin('ghost', 'chosen-in-the-panel')).toBe(false);
  });

  it('refuses a password below the minimum before it reaches the store', async () => {
    const server = await start();
    const token = server.auth.issue('test').token;

    const response = await server.app.inject({
      method: 'POST',
      url: '/api/setup/password',
      headers: { authorization: `Bearer ${token}` },
      payload: { password: 'short', currentPassword: PASSWORD },
    });

    expect(response.statusCode).toBe(422);
    expect(Object.keys(response.json().error.details)).toEqual(['/password']);
  });

  it('closes setup once the password is set', async () => {
    const server = await start({ password: null });
    const code = server.auth.issueSetupCode();
    const claim = await server.app.inject({
      method: 'POST',
      url: '/api/setup/claim',
      payload: { code },
    });
    const claimed = claim.cookies.find((entry) => entry.name === SESSION_COOKIE)?.value ?? '';

    await server.app.inject({
      method: 'POST',
      url: '/api/setup/password',
      headers: { cookie: `${SESSION_COOKIE}=${claimed}` },
      payload: { password: 'chosen-in-the-wizard' },
    });

    const status = await server.app.inject({ method: 'GET', url: '/api/setup' });
    expect(status.json()).toEqual({ required: false });
  });
});

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

describe('login', () => {
  it('exchanges the password for a session cookie', async () => {
    const server = await start();
    const response = await server.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: USERNAME, password: PASSWORD },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, expiresAtMs: expect.any(Number) });

    const cookie = response.cookies.find((entry) => entry.name === SESSION_COOKIE);
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite).toBe('Strict');
    expect(cookie?.path).toBe('/');
  });

  // A token in the body is a token an injected script can read, and this
  // application renders markdown a language model wrote.
  it('never puts the token in the response body', async () => {
    const server = await start();
    const response = await server.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: USERNAME, password: PASSWORD },
    });
    const token = response.cookies.find((entry) => entry.name === SESSION_COOKIE)?.value;

    expect(token).toBeTruthy();
    expect(response.payload).not.toContain(token);
    expect(response.payload).not.toContain(PASSWORD);
  });

  it('issues a cookie that then authenticates', async () => {
    const server = await start();
    const login = await server.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: USERNAME, password: PASSWORD },
    });
    const token = login.cookies.find((entry) => entry.name === SESSION_COOKIE)?.value ?? '';

    const me = await server.app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: `${SESSION_COOKIE}=${token}` },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toEqual({
      authenticated: true,
      authEnabled: true,
      expiresAtMs: expect.any(Number),
      username: 'ghost',
    });
  });

  it('refuses the wrong password with a 401 and no cookie', async () => {
    const server = await start();
    const response = await server.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: USERNAME, password: 'wrong' },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('unauthorized');
    expect(response.cookies).toHaveLength(0);
  });

  it('reports a malformed body as a 422 pointing at the field', async () => {
    const server = await start();
    const response = await server.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: USERNAME, password: 42 },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe('bad_request');
    expect(Object.keys(response.json().error.details)).toEqual(['/password']);
  });

  it('refuses a login when authentication is disabled', async () => {
    const server = await start({ config: config({ auth: { enabled: false } }), password: null });
    const response = await server.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: USERNAME, password: PASSWORD },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toMatch(/disabled/);
  });

  it('cannot be used after a logout', async () => {
    const server = await start();
    const token = server.auth.issue().token;
    const headers = { authorization: `Bearer ${token}` };

    expect(
      (await server.app.inject({ method: 'POST', url: '/api/auth/logout', headers })).statusCode,
    ).toBe(204);
    expect(
      (await server.app.inject({ method: 'GET', url: '/api/auth/me', headers })).statusCode,
    ).toBe(401);
  });

  it('answers /api/auth/me without a session when authentication is off', async () => {
    const server = await start({ config: config({ auth: { enabled: false } }), password: null });
    const response = await server.app.inject({ method: 'GET', url: '/api/auth/me' });

    expect(response.json()).toEqual({ authenticated: true, authEnabled: false });
  });
});

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

describe('rate limiting', () => {
  async function hammer(
    server: GhostServer,
    url: string,
    times: number,
    password = 'wrong',
  ): Promise<number[]> {
    const codes: number[] = [];
    for (let i = 0; i < times; i += 1) {
      const response = await server.app.inject({
        method: url.endsWith('login') ? 'POST' : 'GET',
        url,
        payload: { username: USERNAME, password },
      });
      codes.push(response.statusCode);
    }
    return codes;
  }

  /**
   * The throttle bites long before the per-minute limiter does, and that
   * ordering is the point: ten guesses a minute is 14,400 a day, and the
   * throttle turns the fifth wrong answer into a wait.
   */
  it('stops guessing at the fifth attempt, well inside the per-minute limit', async () => {
    const server = await start({ config: config({ auth: { rateLimitPerMinute: 0 } }) });
    const codes = await hammer(server, '/api/auth/login', 6);

    expect(codes.slice(0, 4)).toEqual([401, 401, 401, 401]);
    expect(codes.slice(4)).toEqual([429, 429]);
  });

  it('says how long to wait, in the header and in the body', async () => {
    const server = await start();
    await hammer(server, '/api/auth/login', 5);
    const response = await server.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: USERNAME, password: 'wrong' },
    });

    expect(response.statusCode).toBe(429);
    expect(response.headers['retry-after']).toBe('1');
    expect(response.json()).toEqual({
      error: { code: 'rate_limited', message: expect.stringContaining('1s') },
    });
  });

  /**
   * The distributed case, which is the whole reason the throttle exists beside
   * the per-address limiter. `inject` reports every request as coming from
   * `127.0.0.1`, so this cannot vary the address — what it can show is that the
   * refusal is in force for a caller whose *own* bucket is still empty, which is
   * what the account scope contributes. `login-throttle.test.ts` covers the
   * scope split directly.
   */
  it('refuses a caller once the account is throttled, on a route it never touched', async () => {
    // Unclaimed, so the setup code is the live credential and the login is the
    // route that has seen no attempts at all.
    const server = await start({ password: null });
    for (let i = 0; i < 5; i += 1) {
      await server.app.inject({
        method: 'POST',
        url: '/api/setup/claim',
        payload: { code: 'AAAA-BBBB-CCCC' },
      });
    }

    const login = await server.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: USERNAME, password: 'wrong' },
    });
    expect(login.statusCode).toBe(429);
  });

  // The general limit protects the process from load; the login's own limit
  // protects a single password from being guessed, and it is not the same
  // setting. A correct password does not trip the throttle, so this is what
  // reaches the plugin's own counter.
  it('limits login attempts even with the global limit disabled', async () => {
    const server = await start({ config: config({ auth: { rateLimitPerMinute: 0 } }) });
    const codes = await hammer(server, '/api/auth/login', 11, PASSWORD);

    expect(codes.slice(0, 10).every((code) => code === 200)).toBe(true);
    expect(codes.at(-1)).toBe(429);
  });

  it('answers a rate-limited request in the standard error envelope', async () => {
    const server = await start();
    await hammer(server, '/api/auth/login', 10, PASSWORD);
    const response = await server.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: USERNAME, password: PASSWORD },
    });

    expect(response.statusCode).toBe(429);
    expect(response.json()).toEqual({
      error: { code: 'rate_limited', message: expect.stringContaining('Retry in') },
    });
  });

  it('applies the configured global limit to every other route', async () => {
    const server = await start({ config: config({ auth: { rateLimitPerMinute: 2 } }) });
    const codes = await hammer(server, '/api/health', 3);

    expect(codes).toEqual([200, 200, 429]);
  });

  it('leaves other routes unlimited when the setting is zero', async () => {
    const server = await start({ config: config({ auth: { rateLimitPerMinute: 0 } }) });
    const codes = await hammer(server, '/api/health', 20);

    expect(codes.every((code) => code === 200)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Errors, health, boot, and the document
// ---------------------------------------------------------------------------

describe('errors', () => {
  it('answers an unknown route in the error envelope', async () => {
    const server = await start();
    const response = await server.app.inject({ method: 'GET', url: '/api/nope' });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: { code: 'not_found', message: expect.stringContaining('/api/nope') },
    });
  });

  it('reports a malformed JSON body as a 400, not a 500', async () => {
    const server = await start();
    const response = await server.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: '{not json',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('bad_request');
  });
});

describe('health', () => {
  it('reports ok while the database answers', async () => {
    const server = await start();
    const response = await server.app.inject({ method: 'GET', url: '/api/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: 'ok',
      checks: [{ name: 'database', status: 'ok', detail: '' }],
    });
  });

  it('reports fail once the database is gone', async () => {
    const database = new DatabaseSync(':memory:');
    const server = await createServer({
      config: config(),
      ...collaborators(database),
      database,
      hasher: fakeHasher,
      password: PASSWORD,
    });
    started.push(server);
    database.close();

    const response = await server.app.inject({ method: 'GET', url: '/api/health' });
    expect(response.json().status).toBe('fail');
  });
});

describe('boot', () => {
  it('refuses a non-loopback bind with authentication off', async () => {
    const database = new DatabaseSync(':memory:');
    opened.push(database);

    await expect(
      createServer({
        config: config({ host: '0.0.0.0', auth: { enabled: false } }),
        ...collaborators(database),
        database,
        hasher: fakeHasher,
      }),
    ).rejects.toThrow(/Refusing to start/);
  });

  it('starts with authentication on and no password, and refuses every session route', async () => {
    // It used to refuse, which left the one interface that could set a password
    // unreachable on a fresh machine. It now starts unclaimed: `setup.status`
    // says so, and everything that needs a session is still a 401 until the
    // one-time code is spent.
    const database = new DatabaseSync(':memory:');
    opened.push(database);

    const server = await createServer({
      config: config(),
      ...collaborators(database),
      database,
      hasher: fakeHasher,
    });
    started.push(server);

    const setup = await server.app.inject({ method: 'GET', url: '/api/setup' });
    expect(setup.json()).toEqual({ required: true });

    const status = await server.app.inject({ method: 'GET', url: '/api/status' });
    expect(status.statusCode).toBe(401);
  });

  it('accepts a password that was already set on a previous boot', async () => {
    const database = new DatabaseSync(':memory:');
    opened.push(database);

    const first = await createServer({
      config: config(),
      ...collaborators(database),
      database,
      hasher: fakeHasher,
      password: PASSWORD,
    });
    await first.close();

    const second = await createServer({
      config: config(),
      ...collaborators(database),
      database,
      hasher: fakeHasher,
    });
    started.push(second);

    const response = await second.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: USERNAME, password: PASSWORD },
    });
    expect(response.statusCode).toBe(200);
  });

  it('listens on a real socket and stops', async () => {
    const server = await start();
    const address = await server.listen({ port: 0 });

    expect(address).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it('states a version that matches the manifest', () => {
    const manifest: unknown = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    );
    expect((manifest as { version: string }).version).toBe(SERVER_VERSION);
  });
});

describe('the generated document', () => {
  async function document(): Promise<Record<string, never>> {
    const server = await start();
    const response = await server.app.inject({
      method: 'GET',
      url: '/api/openapi.json',
      headers: { authorization: `Bearer ${server.auth.issue().token}` },
    });
    return await response.json();
  }

  it('is OpenAPI 3.1 with the protocol schemas as its component pool', async () => {
    const doc = await document();

    expect(doc).toMatchObject({ openapi: '3.1.0', info: { version: SERVER_VERSION } });
    const schemas = (doc as unknown as { components: { schemas: Record<string, unknown> } })
      .components.schemas;
    expect(Object.keys(schemas).length).toBeGreaterThan(50);
    expect(schemas).toHaveProperty('LoginRequest');
    expect(schemas).toHaveProperty('AuthSessionResponse');
  });

  it('describes every manifest route once', async () => {
    const doc = (await document()) as unknown as { paths: Record<string, Record<string, unknown>> };

    for (const spec of ROUTE_MANIFEST) {
      expect(doc.paths[documentPath(spec.url)]?.[spec.method.toLowerCase()]).toBeDefined();
    }
  });

  // The point of the `$defs` pool: a response that *is* a protocol schema
  // references it rather than restating it, so the two cannot drift.
  it('references the pool from a response rather than inlining it', async () => {
    const doc = (await document()) as unknown as {
      paths: Record<
        string,
        { get?: { responses: Record<string, { content: Record<string, { schema: unknown }> }> } }
      >;
    };
    const schema =
      doc.paths['/api/auth/me']?.get?.responses['200']?.content['application/json']?.schema;

    expect(schema).toEqual({ $ref: '#/components/schemas/AuthSessionResponse' });
  });

  // Input mode, so a field carrying `.default()` is not advertised as required.
  it('inlines a request body in input mode', async () => {
    const doc = (await document()) as unknown as {
      paths: Record<
        string,
        { post?: { requestBody: { content: Record<string, { schema: Record<string, unknown> }> } } }
      >;
    };
    const schema =
      doc.paths['/api/auth/login']?.post?.requestBody.content['application/json']?.schema;

    expect(schema).toMatchObject({ type: 'object', required: ['username', 'password'] });
  });

  it('marks the authenticated routes as authenticated', async () => {
    const doc = (await document()) as unknown as {
      paths: Record<string, Record<string, { security?: unknown[] }>>;
    };

    for (const spec of ROUTE_MANIFEST) {
      const operation = doc.paths[documentPath(spec.url)]?.[spec.method.toLowerCase()];
      const security = operation?.security ?? [];
      expect({ id: spec.id, secured: security.length > 0 }).toEqual({
        id: spec.id,
        secured: spec.auth === 'required',
      });
    }
  });
});
