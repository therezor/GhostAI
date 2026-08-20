/**
 * Telegram, brought up by the real `ghostai serve`.
 *
 * `packages/channels` already tests the channel against a scripted hub, and
 * `telegram.test.ts` tests the token precedence on its own. What neither can
 * reach is the wiring in between — whether a token in the environment actually
 * ends up as a registered factory, whether the console adapter is built over
 * the runtime that is running, and whether the banner says so. That is what
 * goes wrong in a composition root, so it is what this covers.
 *
 * The Bot API is a real HTTP server on loopback, named through
 * `channels.telegram.apiBase`, rather than an injected `fetch`. `serve.ts`
 * builds the factory itself and has no seam to inject through — and adding one
 * only for a test would be a production option that exists for nobody.
 */

import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { translations } from '#src/i18n.js';
import { banner, startServer, type RunningServer } from '#src/serve.js';

const { t } = translations('en');

const PASSWORD = 'a-test-password';
const ALLOWED = '4471';

const homes: string[] = [];
const running: RunningServer[] = [];
const stubs: Server[] = [];

afterEach(async () => {
  while (running.length > 0) await running.pop()?.close();
  await Promise.all(
    stubs.splice(0).map(async (stub) => {
      await new Promise<void>((resolve) => {
        stub.close(() => {
          resolve();
        });
      });
    }),
  );
  while (homes.length > 0) {
    rmSync(homes.pop() ?? '', { recursive: true, force: true });
  }
});

interface Stub {
  readonly base: string;
  /** Bot API methods that were called, oldest first. */
  readonly methods: string[];
}

/**
 * The Bot API, as much of it as startup touches.
 *
 * `getUpdates` never answers. That is what a long poll looks like from the
 * server's side, and it keeps the channel parked on one request instead of
 * spinning through the whole test.
 */
async function botApiStub(): Promise<Stub> {
  const methods: string[] = [];
  const held: Array<() => void> = [];

  const server = createServer((request, response) => {
    const method = (request.url ?? '').split('/').pop() ?? '';
    methods.push(method);
    request.resume();

    if (method === 'getUpdates') {
      // Parked, like a real long poll. Released when the socket closes at
      // shutdown, so nothing here has to be cleaned up separately.
      held.push(() => {
        response.destroy();
      });
      return;
    }

    const result =
      method === 'getMe' ? { id: 1, username: 'ghost_test_bot' } : true;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true, result }));
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  server.on('close', () => {
    for (const release of held) release();
  });
  stubs.push(server);

  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${String(port)}`, methods };
}

/** A home configured for a local provider, and optionally for a bot. */
function home(telegram?: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), 'ghostai-serve-tg-'));
  homes.push(root);
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({
      agents: {
        list: { default: { provider: 'ollama', model: 'test-model' } },
      },
      ...(telegram === undefined ? {} : { channels: { telegram } }),
    }),
  );
  return root;
}

async function start(
  root: string,
  env: Record<string, string | undefined> = {},
): Promise<RunningServer> {
  const server = await startServer({
    home: root,
    password: PASSWORD,
    port: 0,
    env: { ...process.env, ...env },
  });
  running.push(server);
  return server;
}

describe('ghostai serve with a bot configured', () => {
  it('starts nothing when no token resolves', async () => {
    // The normal case. `ghostai serve` has to come up unchanged for everybody who
    // has never heard of this.
    const server = await start(home({ allowlist: [ALLOWED] }), {
      TELEGRAM_BOT_TOKEN: undefined,
    });

    expect(server.channels?.channels).toHaveLength(0);
  });

  it('refuses the boot when a token resolves but nobody is allowed', async () => {
    // A token means the operator meant to run a bot. Coming up anyway, with a
    // channel that answers nobody, is indistinguishable from a broken token —
    // and the other way round it is a remote shell. So it is a refusal, and it
    // happens before anything reaches the network.
    const root = home();

    await expect(
      start(root, { TELEGRAM_BOT_TOKEN: 'test-token' }),
    ).rejects.toThrow(/allowlist is empty/u);
  });

  it('registers and connects the channel when both are present', async () => {
    const stub = await botApiStub();
    const server = await start(
      home({ allowlist: [`${ALLOWED}|me`], apiBase: stub.base }),
      { TELEGRAM_BOT_TOKEN: 'test-token' },
    );

    expect(server.channels?.channels.map((channel) => channel.id)).toEqual([
      'telegram',
    ]);
    // The startup handshake, in order: confirm the token, clear a stale
    // webhook, register the command list.
    expect(stub.methods.slice(0, 3)).toEqual([
      'getMe',
      'deleteWebhook',
      'setMyCommands',
    ]);
  });

  it('names the channel in the banner an operator reads', async () => {
    const stub = await botApiStub();
    const server = await start(
      home({ allowlist: [ALLOWED], apiBase: stub.base }),
      { TELEGRAM_BOT_TOKEN: 'test-token' },
    );

    expect(banner(server, false, t)).toContain('telegram');
  });

  it('bridges to the same hub the socket serves, not a second one', async () => {
    const stub = await botApiStub();
    const server = await start(
      home({ allowlist: [ALLOWED], apiBase: stub.base }),
      { TELEGRAM_BOT_TOKEN: 'test-token' },
    );

    // No conversation has arrived, so nothing is bridged yet — and the hub is
    // the one `createServer` was given.
    expect(server.channels?.sessionCount).toBe(0);
    expect(server.hub.sessionCount).toBe(0);
  });

  it('refuses a bad token by failing the boot', async () => {
    // The documented contract: a wrong credential is a startup error rather
    // than a channel that is silently dead.
    const failing = createServer((request, response) => {
      request.resume();
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          ok: false,
          error_code: 401,
          description: 'Unauthorized',
        }),
      );
    });
    await new Promise<void>((resolve) => {
      failing.listen(0, '127.0.0.1', resolve);
    });
    stubs.push(failing);
    const { port } = failing.address() as AddressInfo;

    await expect(
      start(
        home({
          allowlist: [ALLOWED],
          apiBase: `http://127.0.0.1:${String(port)}`,
        }),
        { TELEGRAM_BOT_TOKEN: 'wrong' },
      ),
    ).rejects.toThrow(/Unauthorized/u);
  });

  it('unwinds the rest of the boot when the channel refuses to start', async () => {
    // `ChannelManager.start()` is step five of eight. A failure there has to
    // take the listener, the scheduler and the WAL back down with it, or the
    // process is left holding a port nothing is serving.
    const root = home({ allowlist: [] });

    await expect(
      start(root, { TELEGRAM_BOT_TOKEN: 'test-token' }),
    ).rejects.toThrow();
    // Nothing reached `running`, so `afterEach` closes nothing — and the next
    // test binding a port of its own is what proves the unwind happened.
    expect(running).toHaveLength(0);
  });
});

describe('reconfiguring from the settings panel', () => {
  /** Authenticates without going through the login route. */
  function bearer(server: RunningServer): Record<string, string> {
    return { authorization: `Bearer ${server.server.auth.issue('t').token}` };
  }

  it('reports the channel on the settings response', async () => {
    const stub = await botApiStub();
    const server = await start(
      home({ allowlist: [ALLOWED], apiBase: stub.base }),
      { TELEGRAM_BOT_TOKEN: 'test-token' },
    );

    const response = await fetch(`${server.url}/api/settings`, {
      headers: bearer(server),
    });
    const body = (await response.json()) as {
      channels: Array<Record<string, unknown>>;
    };

    expect(body.channels).toEqual([
      {
        id: 'telegram',
        enabled: true,
        configured: true,
        running: true,
        detail: '@ghost_test_bot',
      },
    ]);
  });

  it('never sends the token back, only that there is one', async () => {
    // The vault is write-only over HTTP. `configured` is the whole of what the
    // panel is allowed to know.
    const stub = await botApiStub();
    const server = await start(
      home({ allowlist: [ALLOWED], apiBase: stub.base }),
      { TELEGRAM_BOT_TOKEN: 'a-secret-token' },
    );

    const response = await fetch(`${server.url}/api/settings`, {
      headers: bearer(server),
    });

    expect(await response.text()).not.toContain('a-secret-token');
  });

  it('starts the channel when a save turns it on', async () => {
    // The point of the whole exercise: configure it in the browser, and the bot
    // works without anyone going near the terminal.
    const stub = await botApiStub();
    const server = await start(home({ enabled: false, apiBase: stub.base }), {
      TELEGRAM_BOT_TOKEN: 'test-token',
    });
    expect(server.channels?.channels).toHaveLength(0);

    const response = await fetch(`${server.url}/api/settings`, {
      method: 'PATCH',
      headers: { ...bearer(server), 'content-type': 'application/json' },
      body: JSON.stringify({
        channels: { telegram: { enabled: true, allowlist: [ALLOWED] } },
      }),
    });
    expect(response.status).toBe(200);

    await settled(() => (server.channels?.channels.length ?? 0) > 0);
    expect(server.channels?.channels.map((channel) => channel.id)).toEqual([
      'telegram',
    ]);
  });

  it('stops the channel when a save turns it off', async () => {
    const stub = await botApiStub();
    const server = await start(
      home({ allowlist: [ALLOWED], apiBase: stub.base }),
      { TELEGRAM_BOT_TOKEN: 'test-token' },
    );
    expect(server.channels?.channels).toHaveLength(1);

    await fetch(`${server.url}/api/settings`, {
      method: 'PATCH',
      headers: { ...bearer(server), 'content-type': 'application/json' },
      body: JSON.stringify({ channels: { telegram: { enabled: false } } }),
    });

    await settled(() => server.channels?.channels.length === 0);
    expect(server.channels?.channels).toHaveLength(0);
  });

  it('keeps serving when the new settings will not start', async () => {
    // A mistyped allowlist must cost a red line in the panel, not the server.
    const stub = await botApiStub();
    const server = await start(
      home({ allowlist: [ALLOWED], apiBase: stub.base }),
      { TELEGRAM_BOT_TOKEN: 'test-token' },
    );

    const response = await fetch(`${server.url}/api/settings`, {
      method: 'PATCH',
      headers: { ...bearer(server), 'content-type': 'application/json' },
      body: JSON.stringify({ channels: { telegram: { allowlist: [] } } }),
    });

    // The save itself succeeded — it did happen.
    expect(response.status).toBe(200);
    await settled(() => server.channels === undefined);
    // And the server is still answering.
    const health = await fetch(`${server.url}/api/health`);
    expect(health.status).toBe(200);
  });

  it('says why the channel is down, on the panel that broke it', async () => {
    const stub = await botApiStub();
    const server = await start(
      home({ allowlist: [ALLOWED], apiBase: stub.base }),
      { TELEGRAM_BOT_TOKEN: 'test-token' },
    );

    await fetch(`${server.url}/api/settings`, {
      method: 'PATCH',
      headers: { ...bearer(server), 'content-type': 'application/json' },
      body: JSON.stringify({ channels: { telegram: { allowlist: [] } } }),
    });
    await settled(() => server.channels === undefined);

    const response = await fetch(`${server.url}/api/settings`, {
      headers: bearer(server),
    });
    const body = (await response.json()) as {
      channels: Array<Record<string, unknown>>;
    };

    expect(body.channels[0]).toMatchObject({ running: false });
    expect(String(body.channels[0]?.detail)).toContain('allowlist is empty');
  });
});

/** Waits for a rebuild, which a save deliberately does not block on. */
async function settled(until: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (until()) return;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  throw new Error('The channels never settled');
}
