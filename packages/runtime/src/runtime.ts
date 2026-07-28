/**
 * The composition root.
 *
 * Every package below this one takes its collaborators as constructor options
 * and constructs none of them; this is the single place where a config file
 * becomes a provider, a jail, a store, a registry and a loop. That is what keeps
 * the rest of the repo testable without a filesystem — and it is why this file
 * is the only one that touches the vault, the database and the keychain.
 *
 * It lives in its own package rather than in the CLI because there is more than
 * one consumer: `ghost chat`, the HTTP server, the scheduler and every channel
 * all need the same wiring, and wiring implemented twice is wiring that differs
 * in exactly the case nobody tested.
 *
 * The decisions here that are not obvious:
 *
 *  - **Provider resolution is `@ghostai/providers`' order, not a second one.**
 *    `resolveProvider` runs explicit id → gateway/local detection → model name,
 *    and returns `null` rather than guessing. Exactly one step follows that
 *    null: a provider whose `envKey` is set in the environment. An exported
 *    credential is an operator saying which provider they mean, and
 *    `OPENAI_API_KEY=… ghost chat` should not need a config file to work. What
 *    it will not do is fall back to *some* provider, because a request landing
 *    at an endpoint nobody chose fails as a 401 from somewhere unexpected.
 *
 *  - **`close()` closes the store, and the store decides what that means.** A
 *    `SessionStore` given a `database` does not close it — whoever opened the
 *    connection owns its lifetime — so a server sharing one `DatabaseSync`
 *    between the auth store, the scheduler and here can build and discard a
 *    runtime without taking the connection with it.
 *
 *  - **A construction-time `provider`/`model` override outlives a
 *    reconfigure.** `ghost chat --model x` is a statement about this process,
 *    and a settings save from a browser must not silently move the terminal
 *    session onto another model. A caller that wants config to drive the model
 *    — the server does — simply passes neither.
 *
 *  - **`reconfigure` rebuilds everything derived and keeps everything owned.**
 *    The store, the tool registry and the steering queue survive; the provider,
 *    the jail and the loop are rebuilt. A turn already running keeps the loop it
 *    started on, which is the only coherent answer: its provider request is in
 *    flight and its tool definitions are already in the model's context.
 */

import type { DatabaseSync } from 'node:sqlite';

import { AgentLoop, SteeringQueue, type ApprovalGate } from '@ghostai/agent';
import {
  GhostError,
  SessionStore,
  WorkspaceStore,
  loadConfig,
  resolveGhostPaths,
  silentLogger,
  type Clock,
  type GhostPaths,
  type Logger,
} from '@ghostai/core';
import type { AgentDefaults, Config, ConfigPatch } from '@ghostai/protocol';
import {
  PROVIDERS,
  resolveConnection,
  resolveProvider,
  type ProviderSpec,
} from '@ghostai/providers';
import type {
  CredentialVault,
  FetchImplementation,
  JailResolver,
  WorkspaceJail,
} from '@ghostai/security';
import { ToolRegistry, registerBuiltins } from '@ghostai/tools';

import { findCredential } from './credentials.js';
import { JailCache } from './jail-cache.js';
import { mergeConfigPatch } from './merge.js';
import { ProviderCache } from './provider-cache.js';

export interface RuntimeOptions {
  /** `GHOSTAI_HOME` override. */
  readonly home?: string | undefined;
  /** Wins over `agents.defaults.workspace`, and keeps winning after a patch. */
  readonly workspace?: string | undefined;
  /** Pins the model for this process; config cannot move it. */
  readonly model?: string | undefined;
  /** Pins the provider for this process; config cannot move it. */
  readonly provider?: string | undefined;
  /** `false` starts the loop with no tools at all. */
  readonly tools?: boolean;
  /**
   * Who to ask before a tool whose risk band is set to `ask` runs.
   *
   * Survives a reconfigure: the gate belongs to the process that built the
   * runtime — a WebSocket hub, a channel — not to the settings, which only say
   * which risk bands need asking about. Absent means nothing is asked, which is
   * what a terminal session wants and what a browser-facing server must not do.
   */
  readonly approvals?: ApprovalGate | undefined;
  readonly logger?: Logger;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Injected by tests so nothing here opens a socket. */
  readonly fetchImpl?: FetchImplementation | undefined;
  /** `false` skips the credential vault; a value replaces it. */
  readonly vault?: CredentialVault | false | undefined;
  /**
   * A connection to share.
   *
   * The auth store, the scheduler and the knowledge base live in the same file;
   * handing them one `DatabaseSync` keeps every write in a single WAL and makes
   * cross-table transactions possible. A borrowed connection is not closed by
   * `close()`.
   */
  readonly database?: DatabaseSync | undefined;
  readonly clock?: Clock | undefined;
  /** Shared between runtimes in a process that builds more than one. */
  readonly providers?: ProviderCache | undefined;
}

export interface GhostRuntime {
  /** The current settings tree. Replaced wholesale by `reconfigure`. */
  readonly config: Config;
  /** Resolved against the config, so a patched workspace moves it. */
  readonly paths: GhostPaths;
  /** The config file that was read, or would have been. */
  readonly file: string;
  readonly store: SessionStore;
  /** Survives a reconfigure, so MCP and plugin registrations are not lost. */
  readonly tools: ToolRegistry;
  /** Survives a reconfigure, so a steer queued mid-turn is not dropped. */
  readonly steering: SteeringQueue;
  /**
   * The default workspace's jail — the banner, and the file routes' fallback.
   *
   * Kept alongside `jails` rather than replaced by it because most callers want
   * "the workspace" and only the ones that are workspace-aware want a resolver.
   */
  readonly jail: WorkspaceJail;
  /** Every workspace's jail, keyed by id. Rebuilt only when the root moves. */
  readonly jails: JailResolver;
  /** The registry: listing, naming and detaching. Never a path. */
  readonly workspaces: WorkspaceStore;
  /** Rebuilt by `reconfigure`; a running turn keeps the one it started on. */
  readonly loop: AgentLoop;
  readonly spec: ProviderSpec;
  readonly model: string;
  /** Whether a credential was found, without saying what it was. */
  readonly hasCredential: boolean;
  /**
   * Applies a settings patch and rebuilds what depends on it.
   *
   * Returns the merged config, which is what a caller persists to
   * `config.json` — the runtime deliberately does not write it, because
   * previewing a patch and saving one are different operations.
   *
   * Throws without changing anything if the patch produces settings that
   * cannot be built: an unknown provider or an unusable workspace leaves the
   * runtime exactly as it was, still serving turns.
   */
  reconfigure(patch: ConfigPatch): Config;
  close(): void;
}

/** Everything a config produces. Replaced as a unit, so a failure changes none of it. */
interface Resolved {
  readonly config: Config;
  readonly paths: GhostPaths;
  readonly jails: JailCache;
  readonly loop: AgentLoop;
  readonly spec: ProviderSpec;
  readonly model: string;
  readonly hasCredential: boolean;
}

/**
 * A provider whose `envKey` is exported, used only after `resolveProvider`
 * returns `null`. Table order decides ties, which puts gateways first — the
 * same precedence `findGateway` applies.
 */
function providerFromEnv(env: Readonly<Record<string, string | undefined>>): ProviderSpec | null {
  for (const spec of PROVIDERS) {
    const key = spec.envKey;
    if (key !== undefined && (env[key] ?? '') !== '') return spec;
  }
  return null;
}

function noProviderError(configFile: string): GhostError {
  const ids = PROVIDERS.map((spec) => spec.id).join(', ');
  return new GhostError(
    'config',
    'No provider could be resolved.\n' +
      "  Pass --provider <id> --model <model>, export the provider's API key variable,\n" +
      `  or set agents.defaults in ${configFile}.\n` +
      `  Known providers: ${ids}`,
  );
}

/**
 * Where a config's paths land.
 *
 * The same precedence `loadConfig` applies — an explicit workspace, then the
 * config file, then `<root>/workspace` — restated here because a reconfigure
 * has a new config and no file read to hang it off.
 */
function pathsFor(config: Config, options: RuntimeOptions): GhostPaths {
  const configured = config.agents.defaults.workspace;
  const workspace = options.workspace ?? (configured === '' ? undefined : configured);
  return resolveGhostPaths({
    ...(options.home === undefined ? {} : { root: options.home }),
    ...(workspace === undefined ? {} : { workspace }),
    ...(options.env === undefined ? {} : { env: options.env }),
  });
}

class Runtime implements GhostRuntime {
  readonly store: SessionStore;
  readonly workspaces: WorkspaceStore;
  readonly tools: ToolRegistry;
  readonly steering: SteeringQueue;
  readonly file: string;

  readonly #options: RuntimeOptions;
  readonly #env: Readonly<Record<string, string | undefined>>;
  readonly #logger: Logger;
  readonly #providers: ProviderCache;
  /** An injected cache outlives this runtime; closing its adapters is not ours to do. */
  readonly #ownsProviders: boolean;
  #current: Resolved;

  constructor(options: RuntimeOptions) {
    this.#options = options;
    this.#env = options.env ?? process.env;
    this.#logger = options.logger ?? silentLogger;
    this.#providers = options.providers ?? new ProviderCache();
    this.#ownsProviders = options.providers === undefined;

    const loaded = loadConfig({
      ...(options.home === undefined ? {} : { root: options.home }),
      ...(options.workspace === undefined ? {} : { workspace: options.workspace }),
      env: this.#env,
    });
    this.file = loaded.file;

    // The store is opened before anything can throw on a bad provider, so a
    // config error does not leave a half-built runtime holding a connection
    // nobody has a reference to close.
    this.store = new SessionStore({
      ...(options.database === undefined ? { file: loaded.paths.dbFile } : {}),
      ...(options.database === undefined ? {} : { database: options.database }),
      ...(options.clock === undefined ? {} : { clock: options.clock }),
    });
    // Over the store's own connection, so the registry and the sessions that
    // reference it are in one WAL — a workspace cannot be detached while
    // sessions still name it, and that invariant is unenforceable across two
    // connections. It survives a reconfigure: only the paths moving would
    // invalidate it, and `paths.workspace` moving is a restart-shaped change.
    this.workspaces = new WorkspaceStore({
      database: this.store.database,
      paths: loaded.paths,
      ...(options.clock === undefined ? {} : { clock: options.clock }),
    });
    this.tools = new ToolRegistry({
      timeoutMs: loaded.config.agents.defaults.toolTimeoutMs,
      logger: this.#logger,
      ...(options.clock === undefined ? {} : { clock: options.clock }),
    });
    this.steering = new SteeringQueue({ logger: this.#logger });

    try {
      this.#current = this.#build(loaded.config, undefined);
    } catch (error) {
      this.store.close();
      throw error;
    }
  }

  get config(): Config {
    return this.#current.config;
  }

  get paths(): GhostPaths {
    return this.#current.paths;
  }

  get jail(): WorkspaceJail {
    return this.#current.jails.default;
  }

  get jails(): JailResolver {
    return this.#current.jails;
  }

  get loop(): AgentLoop {
    return this.#current.loop;
  }

  get spec(): ProviderSpec {
    return this.#current.spec;
  }

  get model(): string {
    return this.#current.model;
  }

  get hasCredential(): boolean {
    return this.#current.hasCredential;
  }

  reconfigure(patch: ConfigPatch): Config {
    const next = mergeConfigPatch(this.#current.config, patch);
    this.#current = this.#build(next, this.#current);
    return next;
  }

  close(): void {
    this.store.close();
    if (this.#ownsProviders) this.#providers.clear();
  }

  /**
   * Config in, everything derived from it out.
   *
   * Ordered so that everything able to fail happens before anything mutates:
   * an unknown provider or an unusable workspace throws while the tool registry
   * still holds the built-ins that were working a moment ago.
   */
  #build(config: Config, previous: Resolved | undefined): Resolved {
    const defaults: AgentDefaults = config.agents.defaults;
    const model = this.#options.model ?? defaults.model;
    const providerId = this.#options.provider ?? defaults.provider;

    const spec = resolveProvider({ provider: providerId, model }) ?? providerFromEnv(this.#env);
    if (spec === null) throw noProviderError(this.file);

    if (model === '') {
      throw new GhostError(
        'config',
        `No model configured for ${spec.displayName}.\n` +
          `  Pass --model <model>, or set agents.defaults.model in ${this.file}.`,
      );
    }

    const paths = pathsFor(config, this.#options);
    const connection = resolveConnection(spec, config.providers[spec.id]);
    // Re-read on every build rather than cached: a key saved in the settings UI
    // has to be usable on the next turn, and the vault is the store it landed in.
    const apiKey = findCredential(spec, paths, this.#env, this.#options.vault);

    const provider = this.#providers.get({
      spec,
      model,
      apiBase: connection.apiBase,
      extraHeaders: connection.extraHeaders,
      apiKey,
      fetchImpl: this.#options.fetchImpl,
    });

    // A jail canonicalises through `realpath` and creates its root, so keeping
    // the cache when nothing moved saves that work on every workspace already
    // in use. A moved root invalidates all of them at once: every cached jail
    // was derived from the old one.
    //
    // `JailCache` builds the default in its constructor, so an unusable
    // workspace throws *here* — before any of the mutations below — which is
    // what keeps `reconfigure` all-or-nothing.
    const jails =
      previous?.paths.workspace === paths.workspace ? previous.jails : new JailCache({ paths });

    // Past here nothing throws, so the mutations below cannot leave the
    // registry describing a runtime that failed to build.
    this.tools.timeoutMs = defaults.toolTimeoutMs;
    // Exact by source: an `exec` switched off in the settings panel has to
    // disappear from the definitions the model sees, and MCP and plugin tools
    // registered on this same registry must survive that.
    this.tools.unregisterBySource('builtin');
    if (this.#options.tools !== false) registerBuiltins(this.tools, config.tools);

    const loop = new AgentLoop({
      provider,
      tools: this.tools,
      store: this.store,
      jails,
      config: defaults,
      toolsConfig: config.tools,
      model,
      logger: this.#logger,
      steering: this.steering,
      env: this.#env,
      ...(this.#options.approvals === undefined ? {} : { approvals: this.#options.approvals }),
      ...(this.#options.clock === undefined ? {} : { clock: this.#options.clock }),
    });

    return { config, paths, jails, loop, spec, model, hasCredential: apiKey !== undefined };
  }
}

export function createRuntime(options: RuntimeOptions = {}): GhostRuntime {
  return new Runtime(options);
}
