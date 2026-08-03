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
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';

import {
  DEFAULT_AGENT_ID,
  GhostError,
  assistantMessage,
  saveConfig,
  silentLogger,
  userMessage,
} from '@ghostai/core';
import {
  ConfigSchema,
  DEFAULT_AGENT_TOOLS,
  DEFAULT_USERNAME,
  type Config,
  type ConfigPatch,
  type SetCredentialRequest,
} from '@ghostai/protocol';
import type { ChatProvider } from '@ghostai/providers';
import type { AutomationResolver } from '@ghostai/tools';
import {
  ProviderCache,
  createRuntime,
  resolveAgent,
  resolveAgentOrDefault,
  type GhostRuntime,
} from '@ghostai/runtime';
import {
  HubApprovalGate,
  Scheduler,
  SessionHub,
  createAutomationResolver,
  createServer,
  type AgentSummary,
  type AgentView,
  type GhostServer,
  type ServerRuntime,
  type ExtensionCounts,
} from '@ghostai/server';

import { routedProvider } from './provider.js';
import { ROUTES, waitTool } from './script.js';

/** argon2id is ~50 ms a call by design; a suite cannot pay it per login. */
const HASHER = {
  hash: (password: string) => Promise.resolve(`fake:${password}`),
  verify: (digest: string, password: string) =>
    Promise.resolve(digest === `fake:${password}`),
};

export const PASSWORD = 'e2e-password';

/**
 * The login name the harness signs in with.
 *
 * The default rather than a chosen one, because that is what an install the
 * harness never reconfigured actually has — a constant here that disagreed with
 * `DEFAULT_USERNAME` would be a test suite proving a login that no fresh install
 * can perform.
 */
export const USERNAME = DEFAULT_USERNAME;

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
  /** The engine, so a spec can drive a job without waiting out a timer. */
  readonly scheduler: Scheduler;
  /** The jail root, for a spec that wants to look at what a tool wrote. */
  readonly workspace: string;
  /** The one-time code, on an unclaimed harness. `undefined` once claimed. */
  readonly setupCode: string | undefined;
  /**
   * Writes `config.json` behind the server's back, the way a hand edit does.
   *
   * The settings route validates and heals what it is given — that is its job —
   * so a spec about a file nobody validated cannot go through it. This is the
   * only way to reach the state a text editor can leave the install in, which
   * is exactly the state that used to stop it booting.
   *
   * Pair it with `POST /api/settings/reload`, which is what an operator presses
   * after editing the file.
   */
  writeConfig(patch: Record<string, unknown>): void;
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
  const root = join(
    dirname(require.resolve('@ghostai/web/package.json')),
    'dist',
  );
  return root;
}

function seedWorkspace(root: string): void {
  for (const [relative, contents] of Object.entries(FIXTURE_FILES)) {
    const path = join(root, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
  }
}

export async function startHarness(
  options: HarnessOptions = {},
): Promise<Harness> {
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
      // The default agent gets an explicit tool map, because permission is per
      // tool and absent means disabled — the seed covers the built-ins, and
      // `e2e_wait` is registered below by the harness itself, so nothing else
      // would ever enable it and every spec that waits would stall.
      list: {
        ...(options.config?.agents?.list ?? {}),
        default: {
          tools: { ...DEFAULT_AGENT_TOOLS, e2e_wait: 'allow' },
          ...(options.config?.agents?.list?.default ?? {}),
        },
      },
    },
    // The host is a config decision — `assertBootPolicy` refuses a non-loopback
    // bind with authentication off, and it reads the config it was handed. The
    // port is not: `0` means "ask the OS", which the schema cannot express, so
    // it belongs to `listen` exactly as it does in `ghost serve`.
    server: { ...(options.config?.server ?? {}), host: '127.0.0.1' },
    // The install's own answer, pinned for the same reason the browser's is:
    // once a session exists, `config.ui.locale` outranks `Accept-Language`, so
    // leaving it to the schema default would make the language the suite asserts
    // in depend on which side of sign-in a spec happens to be.
    ui: { ...(options.config?.ui ?? {}), locale: 'en' },
  });
  const configFile = join(home, 'config.json');
  mkdirSync(home, { recursive: true });
  saveConfig(configFile, config);

  const database = new DatabaseSync(':memory:');
  const approvals = new HubApprovalGate({ logger: silentLogger });

  // Late-bound exactly as `serve.ts` binds it, and wired here for the reason the
  // scheduler is: this file is the *other* composition root, and anything only
  // `serve.ts` knows about is invisible to every e2e run.
  const automationHolder: { current: AutomationResolver | undefined } = {
    current: undefined,
  };
  const automation: AutomationResolver = {
    forTurn: (request) => automationHolder.current?.forTurn(request),
  };

  // One instance, handed back whatever the cache is asked for: the settings
  // panel can move the model mid-suite, and a second script would then be
  // answering while the first held the session.
  const provider: ChatProvider = routedProvider(ROUTES);
  const providers = new ProviderCache({
    create: () => provider,
  });

  const runtime = createRuntime({
    home,
    workspace,
    database,
    approvals,
    automation,
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
    // The real rule, off the live config, exactly as `serve.ts` wires it: a
    // spec that deletes an agent has to see the fallback a browser would.
    resolveAgentId: (agentId) => {
      const { agent, miss } = resolveAgentOrDefault(runtime.config, agentId);
      return { agentId: agent.id, miss };
    },
    store: runtime.store,
    approvals,
    logger: silentLogger,
  });

  const serverRuntime = harnessRuntime(runtime, configFile);
  const directChat = serverRuntime.chat?.bind(serverRuntime);

  // Wired here and not only in `serve.ts`, because this file is the *other*
  // composition root: it builds the stack itself and never calls `startServer`.
  // A scheduler wired only over there would leave every e2e run without one,
  // which is the class of miss `CLAUDE.md` warns about for auth.
  const engine: { current: Scheduler | undefined } = { current: undefined };

  const server = await createServer({
    config: runtime.config,
    runtime: serverRuntime,
    hub,
    database,
    logger: silentLogger,
    hasher: HASHER,
    scheduler: () => engine.current,
    ...(options.password === null
      ? {}
      : { password: options.password ?? PASSWORD }),
    ui: { root: uiRoot() },
  });

  automationHolder.current = createAutomationResolver({
    jobs: server.automation,
    sessions: runtime.store,
    timezone: () => runtime.config.ui.timezone,
    refresh: () => {
      engine.current?.refresh();
    },
  });

  const scheduler = new Scheduler({
    jobs: server.automation,
    config: () => runtime.config,
    connect: (connectOptions) => hub.connect(connectOptions),
    broadcast: (event) => {
      hub.broadcast(event);
    },
    raise: (input) => server.notifications.create(input),
    deleteSession: (sessionKey) => {
      runtime.store.deleteSession(sessionKey);
    },
    // Over the scripted provider, which is what lets a spec cover a heartbeat
    // without an endpoint.
    ...(directChat === undefined ? {} : { chat: directChat }),
    readFile: async (path, maxBytes) =>
      await readJailed(runtime, path, maxBytes),
    logger: silentLogger,
  });
  engine.current = scheduler;
  scheduler.start();

  // The same condition `ghost serve` mints on, so a spec sees the code the
  // terminal would have printed.
  const setupCode = server.auth.hasPassword()
    ? undefined
    : server.auth.issueSetupCode();

  for (const session of options.sessions ?? []) seedSession(runtime, session);
  for (const notification of options.notifications ?? []) {
    server.notifications.create(notification);
  }

  const url = await server.listen({ host: '127.0.0.1', port: 0 });

  return {
    url,
    token: server.auth.issue('e2e').token,
    setupCode,
    server,
    runtime,
    hub,
    scheduler,
    workspace,
    writeConfig: (patch) => {
      saveConfig(configFile, ConfigSchema.parse({ ...config, ...patch }));
    },
    close: async () => {
      // Before the hub, exactly as `serve.ts` orders it: the scheduler drives
      // its turns through the hub, so stopping the hub first would leave a run
      // row `pending` with nothing left to close it.
      await scheduler.stop();
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
/**
 * The `Map` stands in for a namespaced vault, so its keys carry both parts.
 *
 * `\0` as an escape rather than the raw byte it used to be written as. The
 * character is the same one — it is the separator precisely because no
 * namespace or credential id can contain it — but a source file holding an
 * actual NUL reads as *binary* to `grep`, which then silently matches nothing
 * in it. Two of these keys are built and one is parsed, and building a third by
 * hand with a space in it is a bug that costs an afternoon: it compiles, it
 * type-checks, and it deletes nothing.
 */
const CREDENTIAL_SEPARATOR = '\0';

const credentialKey = (namespace: string, key: string): string =>
  `${namespace}${CREDENTIAL_SEPARATOR}${key}`;

function harnessRuntime(
  runtime: GhostRuntime,
  configFile: string,
): ServerRuntime {
  const credentials = new Map<string, string>();

  return {
    // The harness runs no containers; an empty listing is the honest answer.
    toolboxes: () => [],
    config: () => runtime.config,

    applySettings: (patch: ConfigPatch): Config => {
      const before = new Set(Object.keys(runtime.config.providers));
      const merged = runtime.reconfigure(patch);

      // Deleting an instance takes its credential with it, exactly as the real
      // adapter does. A `Map` instead of the vault is the one substitution this
      // harness makes; *when* an entry is dropped is behaviour a browser can
      // observe through `credentialsPresent`, so it is reproduced rather than
      // approximated. Without it, a credential outliving its provider — which
      // would hand it to whatever next reuses the id — is invisible to e2e.
      //
      // After the rebuild, so a patch that could not be built has not already
      // destroyed a credential on its way to failing.
      for (const id of before) {
        if (!(id in merged.providers)) {
          credentials.delete(credentialKey('providers', id));
        }
      }

      return saveConfig(configFile, merged);
    },

    // No write back, exactly as the real adapter does not: the file is the
    // source here, and saving what was just read would turn a reload into a
    // save. It re-reads `configFile`, because that is the config the harness
    // built this runtime's `home` around.
    reload: (): Config => runtime.reload(),

    credentialsPresent: (): Readonly<Record<string, boolean>> => {
      const present: Record<string, boolean> = {};
      for (const key of credentials.keys()) {
        const [namespace, name] = key.split(CREDENTIAL_SEPARATOR);
        if (namespace === 'providers' && name !== undefined) {
          present[name] = true;
        }
      }
      return present;
    },

    setCredential: (request: SetCredentialRequest): void => {
      const key = credentialKey(request.namespace, request.key);
      if (request.value === null) credentials.delete(key);
      else credentials.set(key, request.value);
      // The same empty-patch rebuild the real adapter does. It re-reads the
      // credential, which is what makes a key saved in the UI usable on the
      // next turn instead of after a restart.
      runtime.reconfigure({});
    },

    store: runtime.store,
    workspaces: runtime.workspaces,

    // Wired like the real adapter, and it has to be: a folder move that left a
    // stale jail behind would only show up in a browser, which is what this
    // harness is for.
    releaseWorkspace: (workspaceId: string): void => {
      runtime.evictWorkspace(workspaceId);
    },

    agent: (agentId?: string): AgentView => {
      // Through the real resolver, like the real adapter: a spec that
      // configures a second agent has to see the same inheritance a browser
      // would, not a fixture's approximation of it.
      const agent = resolveAgent(runtime.config, agentId);
      const loop = runtime.loopFor(agentId);

      return {
        id: agent.id,
        label: agent.label,
        // The instance id, and empty when nothing resolved — the same shape the
        // real adapter reports, so a spec about the unconfigured state sees what
        // a browser would.
        provider: runtime.instance?.id ?? '',
        model: loop?.model ?? (runtime.configured ? runtime.model : ''),
        configured:
          agent.id === DEFAULT_AGENT_ID ? runtime.configured : loop !== null,
        jail: runtime.jail,
        jailFor: (workspaceId) => runtime.jails.forWorkspace(workspaceId),
        // Empty when the agent advertises no tools, matching the real adapter:
        // a harness that reported a toolset the model would never be sent would
        // make the context panel pass here and be wrong in a browser.
        tools: agent.defaults.toolsEnabled
          ? runtime.tools.select(agent.tools).definitions()
          : [],
        contextWindowTokens: agent.defaults.contextWindowTokens,
        systemPrompt: async (input) =>
          (await loop?.previewPrompt(input)) ?? {
            staticPrompt:
              'No model is configured, so no system prompt has been assembled yet.',
            runtimeBlock: '',
          },
      };
    },

    // The catalogue the agent editor picks from, unnarrowed — including the
    // harness's own `e2e_wait`, which is registered as a plugin tool.
    registeredTools: () => runtime.tools.definitions(),

    // Wired here as well as in the real adapter, because this harness has its
    // own `RuntimePort` — the field is optional, so forgetting it breaks no
    // build and simply leaves the settings page with nothing to report.
    // See `createServerRuntime`: declared capabilities with no source. Stated
    // here too, so the harness and the real thing answer alike.
    loadError: (): string | undefined => undefined,
    extensions: (): ExtensionCounts => ({
      mcpServersConnected: 0,
      pluginsLoaded: 0,
    }),

    configWarnings: () => runtime.configWarnings,

    agents: (): readonly AgentSummary[] =>
      runtime.agents.map((agent) => ({
        id: agent.id,
        label: agent.label,
        model: runtime.loopFor(agent.id)?.model ?? agent.defaults.model,
        provider: runtime.instance?.id ?? '',
      })),

    // Over the scripted provider, like everything else here. This is what lets
    // an automation spec cover a heartbeat's forced decision without an
    // endpoint — and, since the field is optional, what stops the harness
    // silently reporting "this build has no provider access" for every
    // heartbeat run.
    chat: async (input) => {
      const resolved = runtime.providerFor(input.agentId, input.model);
      if (resolved === null) {
        throw new GhostError(
          'not_found',
          'No provider is configured to answer with.',
        );
      }
      return await resolved.provider.chat({
        model: resolved.model,
        messages: input.messages,
        tools: input.tools,
        toolChoice: input.toolChoice,
        ...(input.maxTokens === undefined
          ? {}
          : { maxTokens: input.maxTokens }),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
    },
  };
}

/**
 * Reads a workspace file through the jail, as `serve.ts` does.
 *
 * Duplicated rather than shared because the two composition roots deliberately
 * do not import each other — and because the thing being reproduced is a
 * *policy* (a heartbeat's file goes through the jail, a missing one is
 * `not_found` rather than a fault), which a spec has to see hold here too.
 */
async function readJailed(
  runtime: GhostRuntime,
  path: string,
  maxBytes: number,
): Promise<string> {
  const verdict = runtime.jail.check(path);
  if (!verdict.ok) {
    throw new GhostError(
      'jail_escape',
      `Cannot read ${path}: ${verdict.message}`,
    );
  }
  try {
    return (await readFile(verdict.path, 'utf8')).slice(0, maxBytes);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new GhostError('not_found', `No ${path} in the workspace.`);
    }
    throw error;
  }
}
