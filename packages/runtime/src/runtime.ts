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
 *    `resolveInstance` runs explicit instance → provider type → the `auto`
 *    order, and returns `null` rather than guessing. Exactly one step follows
 *    that null: a provider whose `envKey` is set in the environment. An
 *    exported credential is an operator saying which provider they mean, and
 *    `OPENAI_API_KEY=… ghost chat` should not need a config file to work. What
 *    it will not do is fall back to *some* provider, because a request landing
 *    at an endpoint nobody chose fails as a 401 from somewhere unexpected.
 *
 *  - **An unconfigured install is a state, not an error.** A runtime with no
 *    resolvable provider, or none with a model, builds anyway: `loop` is
 *    `null`, `configured` is false, and everything that does not need a model —
 *    the store, the workspaces, the tool registry, every HTTP route but the
 *    turn — works. This is what lets `ghost serve` come up on a bare machine
 *    and serve the settings UI that fixes it; refusing to construct meant the
 *    only cure for a missing config was to hand-write one. `requireLoop()` is
 *    where the refusal moved to, so a terminal turn still fails with the same
 *    message it always did.
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

import { existsSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';

import { AgentLoop, SteeringQueue, type ApprovalGate } from '@ghostai/agent';
import {
  DEFAULT_AGENT_ID,
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
import type { Config, ConfigPatch } from '@ghostai/protocol';
import {
  PROVIDERS,
  resolveConnection,
  resolveInstance,
  type ChatProvider,
  type ProviderInstance,
  type ProviderSpec,
} from '@ghostai/providers';
import type {
  CredentialVault,
  FetchImplementation,
  JailResolver,
  WorkspaceJail,
} from '@ghostai/security';
import { ToolRegistry, registerBuiltins } from '@ghostai/tools';

import { listAgents, resolveAgent, type EffectiveAgent } from './agents.js';
import { PROVIDER_CREDENTIAL_NAMESPACE, findCredential, openVault } from './credentials.js';
import { JailCache } from './jail-cache.js';
import { LoopCache } from './loop-cache.js';
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
  /**
   * Rebuilt by `reconfigure`; a running turn keeps the one it started on.
   *
   * `null` when nothing is configured. Read it through `requireLoop()` unless
   * the caller genuinely has something to do with its absence — the server
   * does, and reports it as a `not_configured` error on the one frame that
   * needs a model rather than failing every route.
   */
  readonly loop: AgentLoop | null;
  /**
   * Every agent that can run a turn, the default one first.
   *
   * Resolved — each entry's inherited fields are already folded in — so a
   * caller listing agents for a picker never has to know the inheritance rule.
   */
  readonly agents: readonly EffectiveAgent[];
  /** The endpoint a turn would use, or `null` on an unconfigured install. */
  readonly instance: ProviderInstance | null;
  /** The provider type behind `instance`. Derived, and `null` for the same reason. */
  readonly spec: ProviderSpec | null;
  /** Empty when no model is configured. */
  readonly model: string;
  /** Whether a turn can run at all: a provider and a model both resolved. */
  readonly configured: boolean;
  /** Whether a credential was found, without saying what it was. */
  readonly hasCredential: boolean;
  /**
   * The loop, or the `config` error explaining what is missing.
   *
   * The refusal that used to happen in the constructor, moved to the one call
   * that cannot proceed without an answer. A terminal turn gets the message it
   * always got; a server gets to start.
   */
  requireLoop(): AgentLoop;
  /**
   * The loop for one agent, built on first use and cached.
   *
   * `undefined` is the default agent, which is what a turn from a session
   * nobody has bound carries. Throws for an id that names nothing runnable —
   * ask `hasAgent` first if the id came off the wire.
   */
  loopFor(agentId: string | undefined): AgentLoop | null;
  /** `loopFor`, with the same refusal `requireLoop` makes. */
  requireLoopFor(agentId: string | undefined): AgentLoop;
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

/**
 * Everything a config produces. Replaced as a unit, so a failure changes none
 * of it — and `loop`/`instance` are null together, never one without the other.
 */
interface Resolved {
  readonly config: Config;
  /** Every enabled agent, resolved. Rebuilt with the config it came from. */
  readonly agents: readonly EffectiveAgent[];
  readonly paths: GhostPaths;
  readonly jails: JailCache;
  /** One loop per agent, built on first use. Dropped whole on a reconfigure. */
  readonly loops: LoopCache;
  readonly loop: AgentLoop | null;
  readonly instance: ProviderInstance | null;
  readonly model: string;
  readonly hasCredential: boolean;
  /** The error `requireLoop` throws, prepared where the reason is still known. */
  readonly unconfigured: GhostError | null;
}

/**
 * A provider whose `envKey` is exported, used only after `resolveInstance`
 * returns `null`. Table order decides ties, which puts gateways first — the
 * same precedence `findGateway` applies.
 *
 * Returned as a synthetic instance rather than a bare spec: everything past
 * resolution now speaks in instances, and this one's id matches its provider
 * id, which is where a pre-instance install's vault entry already lives.
 */
function instanceFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): ProviderInstance | null {
  for (const spec of PROVIDERS) {
    const key = spec.envKey;
    if (key !== undefined && (env[key] ?? '') !== '') {
      return {
        id: spec.id,
        spec,
        config: { type: spec.id, label: '', extraHeaders: {}, models: [], enabled: true },
      };
    }
  }
  return null;
}

function noProviderError(configFile: string): GhostError {
  const ids = PROVIDERS.map((spec) => spec.id).join(', ');
  return new GhostError(
    'config',
    'No provider could be resolved.\n' +
      '  Run `ghost init` to configure one interactively, pass --provider <id> --model <model>,\n' +
      `  export the provider's API key variable, or set agents.defaults in ${configFile}.\n` +
      `  Known providers: ${ids}`,
  );
}

function noModelError(instance: ProviderInstance, configFile: string): GhostError {
  return new GhostError(
    'config',
    `No model configured for ${instance.spec.displayName}.\n` +
      '  Run `ghost init`, pass --model <model>, or set agents.defaults.model in ' +
      `${configFile}.`,
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

  get loop(): AgentLoop | null {
    return this.#current.loop;
  }

  get agents(): readonly EffectiveAgent[] {
    return this.#current.agents;
  }

  loopFor(agentId: string | undefined): AgentLoop | null {
    if (agentId === undefined || agentId === '' || agentId === DEFAULT_AGENT_ID) {
      return this.#current.loop;
    }
    // Throws for an unknown or disabled id, which is the caller's to catch —
    // the hub turns it into an error on one frame rather than a dead socket.
    return this.#current.loops.get(agentId);
  }

  requireLoopFor(agentId: string | undefined): AgentLoop {
    const loop = this.loopFor(agentId);
    if (loop !== null) return loop;
    throw this.#current.unconfigured ?? noProviderError(this.file);
  }

  get instance(): ProviderInstance | null {
    return this.#current.instance;
  }

  get spec(): ProviderSpec | null {
    return this.#current.instance?.spec ?? null;
  }

  get model(): string {
    return this.#current.model;
  }

  get configured(): boolean {
    return this.#current.loop !== null;
  }

  get hasCredential(): boolean {
    return this.#current.hasCredential;
  }

  requireLoop(): AgentLoop {
    const loop = this.#current.loop;
    if (loop !== null) return loop;
    // Prepared during `#build`, where it is still known *which* half is
    // missing. Reconstructing it here would have to re-derive that.
    throw this.#current.unconfigured ?? noProviderError(this.file);
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
   * an unusable workspace throws while the tool registry still holds the
   * built-ins that were working a moment ago.
   *
   * A missing provider or model is *not* one of those failures. It produces a
   * runtime with a null loop, because everything else this builds — the jails,
   * the tool registry, the paths — is useful without a model, and refusing to
   * build them is what used to make an unconfigured install unserveable.
   */
  #build(config: Config, previous: Resolved | undefined): Resolved {
    // Every enabled agent, resolved. This is where an entry naming a sandbox
    // with no backend, or settings that will not merge, throws — before
    // anything below mutates, so a bad save leaves the runtime exactly as it
    // was. Only the *default* agent's loop is constructed here; the rest are
    // built on first use, because an install with six agents and one in use
    // should not open six provider connections at boot.
    const agents = listAgents(config);
    const paths = pathsFor(config, this.#options);

    const resolved = this.#resolveProvider(config, resolveAgent(config, DEFAULT_AGENT_ID), paths);

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
    this.tools.timeoutMs = resolved.agent.defaults.toolTimeoutMs;
    // Exact by source: an `exec` switched off in the settings panel has to
    // disappear from the definitions the model sees, and MCP and plugin tools
    // registered on this same registry must survive that.
    this.tools.unregisterBySource('builtin');
    if (this.#options.tools !== false) registerBuiltins(this.tools, config.tools);

    // A fresh cache per build: every loop in the old one was derived from the
    // settings that just changed. A turn already running keeps the loop it
    // started on, because it holds the object rather than looking it up again.
    const loops = new LoopCache({
      create: (agentId) => this.#createLoop(config, agentId, paths, jails),
    });
    const loop = loops.get(DEFAULT_AGENT_ID);

    return {
      config,
      agents,
      paths,
      jails,
      loops,
      loop,
      instance: resolved.instance,
      model: resolved.model,
      hasCredential: resolved.hasCredential,
      unconfigured: resolved.unconfigured,
    };
  }

  /**
   * One agent's endpoint, model and credential.
   *
   * Split out of `#build` because two callers need it and they must not answer
   * differently: the default agent, whose answer *is* `configured`/`model`/
   * `instance` on the runtime, and every other agent on first use.
   *
   * A construction-time `--provider` / `--model` pin wins for every agent, not
   * just the default. `ghost chat --model x` is a statement about this process,
   * and an agent that quietly ignored it would be the more surprising rule.
   */
  #resolveProvider(
    config: Config,
    agent: EffectiveAgent,
    paths: GhostPaths,
  ): {
    readonly agent: EffectiveAgent;
    readonly provider: ChatProvider | null;
    readonly instance: ProviderInstance | null;
    readonly model: string;
    readonly hasCredential: boolean;
    readonly unconfigured: GhostError | null;
  } {
    const model = this.#options.model ?? agent.defaults.model;
    const providerId = this.#options.provider ?? agent.defaults.provider;

    const instance =
      resolveInstance({
        providers: config.providers,
        provider: providerId,
        model,
        hasCredential: (id) => this.#hasStoredCredential(config, id),
      }) ?? instanceFromEnv(this.#env);

    const unconfigured =
      instance === null
        ? noProviderError(this.file)
        : model === ''
          ? noModelError(instance, this.file)
          : null;

    // Re-read on every build rather than cached: a key saved in the settings UI
    // has to be usable on the next turn, and the vault is the store it landed in.
    const apiKey =
      instance === null
        ? undefined
        : findCredential(instance, paths, this.#env, this.#options.vault);

    const provider =
      instance === null || unconfigured !== null
        ? null
        : this.#providers.get({
            instanceId: instance.id,
            spec: instance.spec,
            model,
            ...resolveConnection(instance.spec, instance.config),
            apiKey,
            fetchImpl: this.#options.fetchImpl,
          });

    return { agent, provider, instance, model, hasCredential: apiKey !== undefined, unconfigured };
  }

  /** The loop for one agent, or `null` when nothing can run a turn. */
  #createLoop(
    config: Config,
    agentId: string,
    paths: GhostPaths,
    jails: JailCache,
  ): AgentLoop | null {
    const agent = resolveAgent(config, agentId);
    const { provider, model } = this.#resolveProvider(config, agent, paths);
    if (provider === null) return null;

    return new AgentLoop({
      provider,
      // A view of the one shared registry, not a registry of its own: an MCP
      // server is one connection however many agents are configured.
      tools: this.tools.select(agent.tools),
      store: this.store,
      jails,
      config: agent.defaults,
      toolsConfig: agent.toolsConfig,
      model,
      agent: { id: agent.id, label: agent.label, systemPrompt: agent.systemPrompt },
      logger: this.#logger,
      steering: this.steering,
      env: this.#env,
      ...(this.#options.approvals === undefined ? {} : { approvals: this.#options.approvals }),
      ...(this.#options.clock === undefined ? {} : { clock: this.#options.clock }),
    });
  }

  /**
   * Whether an instance holds a credential, for `auto`'s tie-break only.
   *
   * Reads the vault at most once per build and never throws: resolution is
   * choosing between endpoints, and a vault that will not open is a problem for
   * the chosen one to report — with the message that names it — rather than a
   * reason to fail before anything has been chosen.
   */
  #hasStoredCredential(config: Config, instanceId: string): boolean {
    const entry = config.providers[instanceId];
    if (entry === undefined) return false;
    const envKey = PROVIDERS.find((spec) => spec.id === entry.type)?.envKey;
    if (envKey !== undefined && (this.#env[envKey] ?? '') !== '') return true;

    const vault = this.#options.vault;
    if (vault === false) return false;
    try {
      const paths = pathsFor(config, this.#options);
      if (vault === undefined && !existsSync(paths.vaultFile)) return false;
      return (vault ?? openVault(paths)).has(PROVIDER_CREDENTIAL_NAMESPACE, instanceId);
    } catch {
      return false;
    }
  }
}

export function createRuntime(options: RuntimeOptions = {}): GhostRuntime {
  return new Runtime(options);
}
