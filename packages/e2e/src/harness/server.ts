/**
 * The whole stack, on a port, with a model that cannot reach the network.
 *
 * This is `ghost serve`'s composition with two substitutions and nothing else:
 * the provider comes from a script instead of an HTTP adapter, and credentials
 * live in a `Map` instead of the OS keychain. Everything between the browser
 * and those two seams is the shipping code — the real `AgentLoop`, the real
 * `SessionHub` with its queue and replay ring, the real approval gate, the real
 * Fastify app serving the real built bundle. A harness that faked any of that
 * would be testing the harness.
 *
 * Why the credentials are a `Map`: `openVault` mints a keychain entry the first
 * time it runs, and a test suite must not touch the operator's keychain — nor
 * can CI answer a keychain prompt. The vault's own behaviour is
 * `@ghostai/security`'s to prove, at a coverage bar no browser test could
 * approach. What the browser suite is actually asserting about credentials is
 * that a key typed into the settings panel goes to exactly one request and
 * comes back as a boolean, and a `Map` behind the port shows that as clearly as
 * a keychain does.
 *
 * Everything else is per-test: a fresh in-memory database, a fresh temp
 * workspace, a fresh listener on a port the OS picks. Specs therefore share no
 * state at all, which is what lets them run in parallel and lets each one
 * choose its own settings — the approval matrix in particular, since a spec
 * about the prompt and a spec about Stop want opposite answers from it.
 */

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';

import { assistantMessage, saveConfig, silentLogger, userMessage } from '@ghostai/core';
import {
  ConfigSchema,
  type Config,
  type ConfigPatch,
  type SetCredentialRequest,
} from '@ghostai/protocol';
import type { ChatProvider, CreateProviderOptions } from '@ghostai/providers';
import { ProviderCache, createRuntime, type GhostRuntime } from '@ghostai/runtime';
import {
  HubApprovalGate,
  SessionHub,
  createServer,
  type AgentView,
  type GhostServer,
  type ServerRuntime,
} from '@ghostai/server';

import { routedProvider } from './provider.js';
import { ROUTES, waitTool } from './script.js';

/** argon2id is ~50 ms a call by design; a suite cannot pay it per login. */
const HASHER = {
  hash: (password: string) => Promise.resolve(`fake:${password}`),
  verify: (digest: string, password: string) => Promise.resolve(digest === `fake:${password}`),
};

export const PASSWORD = 'e2e-password';

/** The workspace the file browser and `list_dir` both see. */
const FIXTURE_FILES: Readonly<Record<string, string>> = {
  'notes.md': '# Notes\n\nOne file, so the browser has something to list.\n',
  'src/main.ts': 'export const answer = 42;\n',
};

export interface HarnessOptions {
  /**
   * Merged over the defaults before anything is built.
   *
   * The approval matrix is the setting specs actually move: the prompt spec
   * wants `exec: 'ask'` (which is the default, and what a browser-facing server
   * ships with), and a spec that only needs a tool to run wants it out of the
   * way.
   */
  readonly config?: ConfigPatch;
  /** Sessions to write into the store before the browser connects. */
  readonly sessions?: readonly SeedSession[];
  /** Notifications the centre should already be holding. */
  readonly notifications?: readonly SeedNotification[];
  /**
   * `null` starts the server unclaimed, as a first run.
   *
   * The default sets one, because every other spec wants to be past the door.
   * A spec about the setup wizard wants the state the wizard exists for: no
   * password, and a one-time code on `Harness.setupCode`.
   */
  readonly password?: string | null;
}

export interface SeedSession {
  readonly key: string;
  readonly title?: string;
  /** Alternating user/assistant text, starting with the user. */
  readonly turns?: readonly string[];
}

export interface SeedNotification {
  readonly title: string;
  readonly body?: string;
  readonly level?: 'info' | 'warning' | 'error';
}

export interface Harness {
  /** The origin to point a browser at. */
  readonly url: string;
  /** A token that authenticates, for seeding through the API. */
  readonly token: string;
  readonly server: GhostServer;
  readonly runtime: GhostRuntime;
  readonly hub: SessionHub;
  /** The jail root, for a spec that wants to look at what a tool wrote. */
  readonly workspace: string;
  /** The one-time code, on an unclaimed harness. `undefined` once claimed. */
  readonly setupCode: string | undefined;
  close(): Promise<void>;
}

/**
 * The built SPA.
 *
 * Resolved through the package graph exactly as `ghost serve` resolves it, so
 * "the UI is not built" fails here with a sentence rather than as a blank page
 * forty assertions later.
 */
export function uiRoot(): string {
  const require = createRequire(import.meta.url);
  const root = join(dirname(require.resolve('@ghostai/web/package.json')), 'dist');
  return root;
}

function seedWorkspace(root: string): void {
  for (const [relative, contents] of Object.entries(FIXTURE_FILES)) {
    const path = join(root, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
  }
}

export async function startHarness(options: HarnessOptions = {}): Promise<Harness> {
  const home = mkdtempSync(join(tmpdir(), 'ghostai-e2e-home-'));
  const workspace = mkdtempSync(join(tmpdir(), 'ghostai-e2e-work-'));
  seedWorkspace(workspace);

  // Written before the runtime reads it, so `createRuntime` and the settings
  // panel are looking at the same file rather than at a patch applied after.
  const config: Config = ConfigSchema.parse({
    ...(options.config ?? {}),
    agents: {
      ...(options.config?.agents ?? {}),
      defaults: {
        provider: 'ollama',
        model: 'qwen3',
        workspace,
        ...(options.config?.agents?.defaults ?? {}),
      },
    },
    // The host is a config decision — `assertBootPolicy` refuses a non-loopback
    // bind with authentication off, and it reads the config it was handed. The
    // port is not: `0` means "ask the OS", which the schema cannot express, so
    // it belongs to `listen` exactly as it does in `ghost serve`.
    server: { ...(options.config?.server ?? {}), host: '127.0.0.1' },
  });
  const configFile = join(home, 'config.json');
  mkdirSync(home, { recursive: true });
  saveConfig(configFile, config);

  const database = new DatabaseSync(':memory:');
  const approvals = new HubApprovalGate({ logger: silentLogger });

  // One instance, handed back whatever the cache is asked for: the settings
  // panel can move the model mid-suite, and a second script would then be
  // answering while the first held the conversation.
  const provider: ChatProvider = routedProvider(ROUTES);
  const providers = new ProviderCache({ create: (_options: CreateProviderOptions) => provider });

  const runtime = createRuntime({
    home,
    workspace,
    database,
    approvals,
    providers,
    // No keychain, and no `findCredential` reading one. The scripted provider
    // needs no key, and minting a keychain entry from a test suite is not a
    // thing a test suite may do.
    vault: false,
    logger: silentLogger,
    env: { PATH: process.env.PATH ?? '', HOME: home },
  });

  // `source: 'plugin'` rather than `'builtin'`, because every reconfigure calls
  // `unregisterBySource('builtin')` — a settings save in the middle of a spec
  // would otherwise take the wait tool out from under the turn using it.
  runtime.tools.register(waitTool, 'plugin');

  const hub = new SessionHub({
    config: runtime.config,
    loop: () => runtime.loop,
    store: runtime.store,
    approvals,
    logger: silentLogger,
  });

  const server = await createServer({
    config: runtime.config,
    runtime: harnessRuntime(runtime, configFile),
    hub,
    database,
    logger: silentLogger,
    hasher: HASHER,
    ...(options.password === null ? {} : { password: options.password ?? PASSWORD }),
    ui: { root: uiRoot() },
  });

  // The same condition `ghost serve` mints on, so a spec sees the code the
  // terminal would have printed.
  const setupCode = server.auth.hasPassword() ? undefined : server.auth.issueSetupCode();

  for (const session of options.sessions ?? []) seedSession(runtime, session);
  for (const notification of options.notifications ?? []) server.notifications.create(notification);

  const url = await server.listen({ host: '127.0.0.1', port: 0 });

  return {
    url,
    token: server.auth.issue('e2e').token,
    setupCode,
    server,
    runtime,
    hub,
    workspace,
    close: async () => {
      hub.close();
      await server.close();
      runtime.close();
      database.close();
      rmSync(home, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    },
  };
}

function seedSession(runtime: GhostRuntime, session: SeedSession): void {
  runtime.store.ensureSession(session.key, {
    ...(session.title === undefined ? {} : { title: session.title }),
  });
  const messages = (session.turns ?? []).map((text, index) =>
    index % 2 === 0 ? userMessage(text) : assistantMessage(text),
  );
  if (messages.length > 0) runtime.store.appendMany(session.key, messages);
}

/**
 * The `ServerRuntime` port, over the real runtime and an in-memory vault.
 *
 * A near-copy of the adapter `ghost serve` uses, and deliberately kept as one:
 * the parts a browser can observe — a settings save that persists and takes
 * effect on the next turn, a credential that becomes a boolean and nothing else
 * — are the parts reproduced exactly. What is not reproduced is `openVault`,
 * for the reason at the top of this file.
 */
function harnessRuntime(runtime: GhostRuntime, configFile: string): ServerRuntime {
  const credentials = new Map<string, string>();

  return {
    config: () => runtime.config,

    applySettings: (patch: ConfigPatch): Config =>
      saveConfig(configFile, runtime.reconfigure(patch)),

    credentialsPresent: (): Readonly<Record<string, boolean>> => {
      const present: Record<string, boolean> = {};
      for (const key of credentials.keys()) {
        const [namespace, name] = key.split(' ');
        if (namespace === 'providers' && name !== undefined) present[name] = true;
      }
      return present;
    },

    setCredential: (request: SetCredentialRequest): void => {
      const key = `${request.namespace} ${request.key}`;
      if (request.value === null) credentials.delete(key);
      else credentials.set(key, request.value);
      // The same empty-patch rebuild the real adapter does. It re-reads the
      // credential, which is what makes a key saved in the UI usable on the
      // next turn instead of after a restart.
      runtime.reconfigure({});
    },

    store: runtime.store,
    workspaces: runtime.workspaces,

    agent: (): AgentView => ({
      // The instance id, and empty when nothing resolved — the same shape the
      // real adapter reports, so a spec about the unconfigured state sees what
      // a browser would.
      provider: runtime.instance?.id ?? '',
      model: runtime.configured ? runtime.model : '',
      configured: runtime.configured,
      jail: runtime.jail,
      jailFor: (workspaceId) => runtime.jails.forWorkspace(workspaceId),
      tools: runtime.tools.definitions(),
      systemPrompt: async (input) =>
        (await runtime.loop?.previewPrompt(input)) ??
        'No model is configured, so no system prompt has been assembled yet.',
    }),
  };
}
