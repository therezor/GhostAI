/**
 * Serving the built UI, and the one rule the fallback has.
 *
 * A single-page app owns URLs the server has never heard of, so anything the
 * router did not match has to become the shell — except under `/api` and `/ws`,
 * where a 404 is a client bug and answering it with HTML turns "no such route"
 * into "the JSON parser failed" somewhere unrelated.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { startTestServer, type TestServer } from './testkit/server.js';

const running: TestServer[] = [];
const roots: string[] = [];

afterEach(async () => {
  while (running.length > 0) await running.pop()?.close();
  while (roots.length > 0) rmSync(roots.pop() ?? '', { recursive: true, force: true });
});

/** A `dist/` as Vite would leave one: a shell and a hashed asset. */
function bundle(): string {
  const root = mkdtempSync(join(tmpdir(), 'ghostai-ui-'));
  roots.push(root);
  writeFileSync(join(root, 'index.html'), '<!doctype html><title>GhostAI</title>');
  mkdirSync(join(root, 'assets'));
  writeFileSync(join(root, 'assets', 'app-abc123.js'), 'console.log(1);\n');
  return root;
}

async function start(ui?: string): Promise<TestServer> {
  const test = await startTestServer(ui === undefined ? {} : { ui: { root: ui } });
  running.push(test);
  return test;
}

describe('the built UI', () => {
  it('serves the shell at the root', async () => {
    const test = await start(bundle());

    const response = await test.server.app.inject({ method: 'GET', url: '/' });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('<title>GhostAI</title>');
  });

  it('serves the shell for a path only the client knows about', async () => {
    const test = await start(bundle());

    const response = await test.server.app.inject({ method: 'GET', url: '/session/abc-123' });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('<title>GhostAI</title>');
  });

  it('serves the asset bundle from disk', async () => {
    const test = await start(bundle());

    const response = await test.server.app.inject({ method: 'GET', url: '/assets/app-abc123.js' });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('console.log(1);\n');
  });

  it('leaves an unknown API path as a JSON 404', async () => {
    const test = await start(bundle());

    const response = await test.server.app.inject({ method: 'GET', url: '/api/nope' });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: { code: 'not_found', message: expect.any(String) },
    });
  });

  it('does not answer a POST with the shell', async () => {
    const test = await start(bundle());

    const response = await test.server.app.inject({ method: 'POST', url: '/anything' });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: { code: 'not_found', message: expect.any(String) },
    });
  });

  it('is not served at all when no bundle was given', async () => {
    const test = await start();

    const response = await test.server.app.inject({ method: 'GET', url: '/' });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: { code: 'not_found', message: expect.any(String) },
    });
  });

  it('serves the shell without a credential, since the app itself is the login', async () => {
    const test = await start(bundle());

    const response = await test.server.app.inject({ method: 'GET', url: '/settings' });

    // The UI is a static asset; every byte of data behind it is authenticated,
    // and a login screen that needed a session to load could never be reached.
    expect(response.statusCode).toBe(200);
  });
});
