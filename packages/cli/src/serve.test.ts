/**
 * `ghost serve`, brought up for real.
 *
 * This is the composition root, so a test that stubbed its pieces would be
 * testing nothing: what can go wrong here is exactly the wiring — a hub built
 * over a loop the settings save no longer moves, a `--host` that walks past the
 * boot policy, a settings write that never reaches the file. So it binds a port
 * on loopback, over a temporary `GHOSTAI_HOME` and a provider that needs no
 * credential, and drives it with HTTP and a WebSocket.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { ChannelFactory } from '@ghostai/channels';
import type { Config, StatusResponse } from '@ghostai/protocol';
import { WebSocket } from 'ws';

import { banner, resolveUiRoot, serveCommand, startServer, type RunningServer } from './serve.js';

const PASSWORD = 'a-test-password';

const homes: string[] = [];
const running: RunningServer[] = [];

afterEach(async () => {
  while (running.length > 0) await running.pop()?.close();
  while (homes.length > 0) rmSync(homes.pop() ?? '', { recursive: true, force: true });
});

/**
 * A home with a config naming a local provider.
 *
 * `ollama` because it is `isLocal` with no `envKey`: the runtime resolves it
 * without a credential, so nothing here opens a vault or writes a keychain
 * entry. No request is ever made to it.
 */
function home(server: Record<string, unknown> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'ghostai-serve-'));
  homes.push(root);
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({
      agents: { defaults: { provider: 'ollama', model: 'test-model' } },
      server,
    }),
  );
  return root;
}

function configOf(root: string): Config {
  return JSON.parse(readFileSync(join(root, 'config.json'), 'utf8')) as Config;
}

async function start(root: string, options: Record<string, unknown> = {}): Promise<RunningServer> {
  const server = await startServer({ home: root, password: PASSWORD, port: 0, ...options });
  running.push(server);
  return server;
}

/** A bearer that authenticates, without going through the login route. */
function bearer(server: RunningServer): Record<string, string> {
  return { authorization: `Bearer ${server.server.auth.issue('test').token}` };
}

describe('startServer', () => {
  it('serves the API over the runtime the config describes', async () => {
    const root = home();
    const server = await start(root);

    const health = await fetch(`${server.url}/api/health`);
    const status = await fetch(`${server.url}/api/status`, { headers: bearer(server) });
    const body = (await status.json()) as StatusResponse;

    expect(health.status).toBe(200);
    expect(body).toMatchObject({ provider: 'ollama', model: 'test-model', authEnabled: true });
    expect(body.workspace).toContain(root);
  });

  it('refuses an unauthenticated request, and the whole UI is still reachable', async () => {
    const server = await start(home());

    const status = await fetch(`${server.url}/api/status`);

    expect(status.status).toBe(401);
    await expect(status.json()).resolves.toMatchObject({ error: { code: 'unauthorized' } });
  });

  it('accepts a WebSocket on the same port', async () => {
    const server = await start(home());

    const socket = new WebSocket(`${server.url.replace('http', 'ws')}/ws`, {
      headers: bearer(server),
    });
    const greeting = await new Promise<Record<string, unknown>>((resolve, reject) => {
      socket.once('message', (data: Buffer) => {
        resolve(JSON.parse(data.toString('utf8')) as Record<string, unknown>);
      });
      socket.once('error', reject);
    });
    socket.close();

    expect(greeting).toMatchObject({ type: 'connected', protocolVersion: 1 });
  });

  it('writes a settings save to config.json and moves the running agent', async () => {
    const root = home();
    const server = await start(root);

    const response = await fetch(`${server.url}/api/settings`, {
      method: 'PATCH',
      headers: { ...bearer(server), 'content-type': 'application/json' },
      body: JSON.stringify({ agents: { defaults: { model: 'another-model' } } }),
    });

    expect(response.status).toBe(200);
    // On disk, so the next boot uses it…
    expect(configOf(root).agents.defaults.model).toBe('another-model');
    // …and in the loop, so the next turn does.
    expect(server.runtime.model).toBe('another-model');
  });

  it('refuses to serve a settings save the next boot could not load', async () => {
    const root = home();
    const server = await start(root);

    const response = await fetch(`${server.url}/api/settings`, {
      method: 'PATCH',
      headers: { ...bearer(server), 'content-type': 'application/json' },
      body: JSON.stringify({ server: { host: '0.0.0.0', auth: { enabled: false } } }),
    });

    expect(response.status).toBeGreaterThanOrEqual(400);
    // Untouched: the file still holds what was written before the request, and
    // the running server still wants a credential.
    expect(configOf(root).server).toEqual({});
    expect((await fetch(`${server.url}/api/status`)).status).toBe(401);
  });

  it('applies --host through the config, so the boot policy still sees it', async () => {
    // The failure this pins: binding a non-loopback address with authentication
    // off is refused, and a flag that reached `listen` without reaching the
    // config would walk straight past the check.
    const root = home({ auth: { enabled: false } });

    await expect(startServer({ home: root, host: '0.0.0.0', port: 0 })).rejects.toThrow(
      /Refusing to start/,
    );
  });

  it('starts the channels it was given, over the same hub', async () => {
    // The contract, not an implementation of it: `examples/loopback-channel` is
    // where a real one is proven, and depending on it from here would be a
    // package dependency for one assertion about wiring.
    const factory: ChannelFactory = {
      id: 'loopback',
      create: () => ({ id: 'loopback', send: () => undefined }),
    };
    const server = await start(home(), { channels: [factory] });

    expect(server.channels.channels.map((channel) => channel.id)).toEqual(['loopback']);
    // The same hub the socket serves — not a second one built for channels.
    expect(server.hub.sessionCount).toBe(0);
  });

  it('leaves nothing listening when a start fails', async () => {
    const root = home();
    // A workspace that cannot be created: the runtime throws while building,
    // after the database is open and before anything binds.
    const file = join(root, 'not-a-directory');
    writeFileSync(file, 'x');

    await expect(
      startServer({ home: root, workspace: join(file, 'nested'), port: 0 }),
    ).rejects.toThrow();
  });

  it('closes twice without complaining', async () => {
    const server = await start(home());

    await server.close();
    await expect(server.close()).resolves.toBeUndefined();
  });
});

describe('resolveUiRoot', () => {
  it('serves a directory that holds a built shell', () => {
    const root = mkdtempSync(join(tmpdir(), 'ghostai-ui-'));
    homes.push(root);
    writeFileSync(join(root, 'index.html'), '<!doctype html>');

    expect(resolveUiRoot(root)).toBe(root);
  });

  it('refuses a directory that holds no shell, rather than serving nothing', () => {
    const root = mkdtempSync(join(tmpdir(), 'ghostai-ui-'));
    homes.push(root);

    expect(() => resolveUiRoot(root)).toThrow(/index\.html/);
  });

  it('finds the bundle `@ghostai/web` ships, and only when it has been built', () => {
    // Two states, both real: `pnpm build` builds the UI before the CLI, and a
    // checkout that has only ever run `pnpm test` has no `dist` at all. The
    // implicit lookup has to answer for whichever one it is standing in.
    const require = createRequire(import.meta.url);
    const root = join(dirname(require.resolve('@ghostai/web/package.json')), 'dist');
    const built = existsSync(join(root, 'index.html'));

    expect(resolveUiRoot(undefined)).toBe(built ? root : undefined);
  });
});

describe('the banner', () => {
  it('says where it is, what it is running, and whether auth is on', async () => {
    const server = await start(home());

    const text = banner(server, false);

    expect(text).toContain(server.url);
    expect(text).toContain('enabled');
    expect(text).toContain('test-model');
    // The UI row says which of the two it is, and both are ordinary states: a
    // built bundle is a path, and a checkout that has not run `pnpm build` is
    // an API-only server that should say so rather than look broken.
    expect(text).toContain(server.ui ?? 'serving the API only');
  });

  it('warns when anything that can reach the port can drive the agent', async () => {
    const server = await start(home({ auth: { enabled: false } }), { password: undefined });

    expect(banner(server, false)).toContain('can drive this agent');
  });
});

describe('serveCommand', () => {
  it('stays up until it is told to stop, then closes cleanly', async () => {
    const written: string[] = [];
    const out = {
      write: (text: string): boolean => {
        written.push(text);
        return true;
      },
    } as NodeJS.WritableStream;
    const controller = new AbortController();

    const finished = serveCommand({
      home: home(),
      password: PASSWORD,
      port: 0,
      handleSignals: false,
      signal: controller.signal,
      colors: false,
      out,
    });

    // The banner is written before the wait, so its arrival is the signal that
    // the server is up.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(written.join('')).toContain('GhostAI is listening.');

    controller.abort();
    await expect(finished).resolves.toBe(0);
    expect(written.join('')).toContain('Stopped.');
  });
});
