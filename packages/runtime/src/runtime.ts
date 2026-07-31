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

import {
  AgentLoop,
  type PromptToolbox,
  SteeringQueue,
  subagentMap,
  type ApprovalGate,
} from '@ghostai/agent';
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
import type { Config, ConfigPatch, ToolPermissions } from '@ghostai/protocol';
import {
  PROVIDERS,
  resolveConnection,
  resolveInstance,
  type ChatProvider,
  type ProviderInstance,
  type ProviderSpec,
} from '@ghostai/providers';
import {
  ToolboxStore,
  assertNetworkWithinCeiling,
  type CredentialVault,
  type FetchImplementation,
  type JailResolver,
  type WorkspaceJail,
} from '@ghostai/security';
import {
  ToolRegistry,
  registerBuiltins,
  toolboxPermissions,
  toolboxTools,
  withToolboxTools,
  type AnyTool,
  type AutomationResolver,
  type RunnerResolver,
} from '@ghostai/tools';

import {
  assertWritableAgentIds,
  pruneDanglingSubagents,
  resolveAgent,
  resolveAgents,
  toolPromptWarnings,
  type AgentConfigWarning,
  type EffectiveAgent,
} from './agents.js';
import { PROVIDER_CREDENTIAL_NAMESPACE, findCredential, openVault } from './credentials.js';
import { JailCache } from './jail-cache.js';
import { ToolboxPool, dockerEngine, type ContainerEngine } from './toolbox-pool.js';
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
  /**
   * How sandbox containers are started. Defaults to the `docker` CLI.
   *
   * Injected so a test can exercise the pool — and the refusals around it —
   * without a daemon, and so an install can point at `podman` instead.
   */
  readonly containerEngine?: ContainerEngine | undefined;
  /**
   * Supplies the scheduler a turn's `automation` tool writes through.
   *
   * Injected rather than built here, because the store it needs is created by
   * `createServer` — which happens *after* this runtime exists. `ghost serve`
   * passes a resolver that delegates to one it fills in afterwards, the same
   * late binding `ServerOptions.scheduler` uses for the same knot.
   */
  readonly automation?: AutomationResolver | undefined;
  /**
   * Translates GhostAI's view of the workspace into the *daemon's*.
   *
   * Identity when GhostAI runs on the host. A containerised GhostAI must supply
   * this: a bind path is resolved by the daemon, so asking for its own
   * `/data/workspace` would mount the host's path of that name — silently, and
   * usually as an empty directory.
   */
  readonly hostWorkspacePath?: ((workspaceRoot: string) => string) | undefined;
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
  /**
   * Drops the cached jail for one workspace, after its folder has moved.
   *
   * A method here rather than `evict` on `JailResolver`: that interface is
   * `@ghostai/security`'s, it is what decides whether a path may be touched,
   * and widening it with a cache operation would put "forget this" in front of
   * every implementation of a containment boundary.
   */
  evictWorkspace(workspaceId: string): void;
  /** The registry: listing, naming, moving and detaching. Never a path. */
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
  /**
   * What the settings asked for and this build could not honour. Empty is healthy.
   *
   * Never a reason to refuse the build: the commonest entry here is a
   * delegation to an agent someone deleted, which is not a fault of whoever is
   * starting the process now.
   */
  readonly configWarnings: readonly AgentConfigWarning[];
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
   * One agent's resolved provider and model, for a request that is not a turn.
   *
   * The one caller is the heartbeat's forced `skip | run` decision. See the
   * implementation for why this is narrow on purpose — everything a turn gets
   * is bypassed here.
   */
  providerFor(
    agentId: string | undefined,
    model?: string,
  ): { readonly provider: ChatProvider; readonly model: string } | null;
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
  /**
   * Re-reads `config.json` and rebuilds everything derived from it.
   *
   * The counterpart to `reconfigure`, and the difference is where the settings
   * come from: a patch is what a client just sent, and this is what the file
   * says now. It is for the edits a running server cannot see — a config
   * hand-edited in an editor, a plugin dropped into the directory, an MCP
   * server whose command changed — which otherwise wait for a restart.
   *
   * The whole file, not a merge over what is in memory. A settings save that
   * was rolled back by hand has to actually come back, and a merge would keep
   * the value that is no longer written anywhere.
   *
   * Same failure contract as `reconfigure`: a file that cannot be built throws
   * and changes nothing, leaving the runtime serving what it was already
   * serving. A turn already running keeps the loop it started on.
   */
  reload(): Config;
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
  /**
   * What the settings asked for and this build had to ignore. Empty is healthy.
   *
   * Held beside the agents rather than thrown, because every one of these is
   * survivable and at least one of them — a delegation to an agent someone
   * deleted — is not the fault of whoever is starting the server now.
   */
  readonly warnings: readonly AgentConfigWarning[];
  readonly paths: GhostPaths;
  readonly jails: JailCache;
  /**
   * Live sandbox containers, or `null` when no enabled agent asks for one.
   *
   * Built only when something needs it, so an install with no sandboxed agent
   * never probes for a container runtime — and one that *does* discovers an
   * unreachable daemon here, during an all-or-nothing rebuild, rather than in
   * the middle of a turn.
   */
  readonly toolboxPool: ToolboxPool | null;
  /** Each sandboxed agent's toolbox contents, for its static prompt. */
  readonly toolboxPrompts: ReadonlyMap<string, PromptToolbox>;
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

  evictWorkspace(workspaceId: string): void {
    this.#current.jails.evict(workspaceId);
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

  /**
   * One agent's resolved provider and model, for a request that is **not** a
   * turn.
   *
   * Deliberately narrow, and worth naming its one caller: the heartbeat's
   * forced `skip | run` decision, which is a single request carrying one tool
   * and no history. Everything a turn gets — the tool registry, the approval
   * gate, history windowing, the turn-stats row — is bypassed here, which is
   * correct for a classification and wrong for anything that looks like work.
   * A second caller wanting "just one completion" is a sign it wants a turn.
   *
   * `model` overrides what the agent would otherwise use, which is how
   * `scheduler.heartbeat.model` gets to be a cheaper one than the agent's.
   */
  providerFor(
    agentId: string | undefined,
    model?: string,
  ): { readonly provider: ChatProvider; readonly model: string } | null {
    const config = this.config;
    const agent = resolveAgent(config, agentId ?? DEFAULT_AGENT_ID);
    const resolved = this.#resolveProvider(
      config,
      model === undefined || model === ''
        ? agent
        : { ...agent, defaults: { ...agent.defaults, model } },
      this.paths,
    );
    if (resolved.provider === null) return null;
    return { provider: resolved.provider, model: resolved.model };
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

  /**
   * What the current settings asked for and could not have. Empty is healthy.
   *
   * Served rather than logged because the operator who can fix it is looking at
   * the settings page, not at the process output — and because these survive a
   * restart, so a warning nobody surfaced is one nobody ever sees.
   */
  get configWarnings(): readonly AgentConfigWarning[] {
    return this.#current.warnings;
  }

  requireLoop(): AgentLoop {
    const loop = this.#current.loop;
    if (loop !== null) return loop;
    // Prepared during `#build`, where it is still known *which* half is
    // missing. Reconstructing it here would have to re-derive that.
    throw this.#current.unconfigured ?? noProviderError(this.file);
  }

  /**
   * Merge a patch, heal what it orphaned, and rebuild — or change nothing.
   *
   * The order matters and each step earns its place:
   *
   *  1. **merge** — the generic tree merge, which knows nothing about agents.
   *  2. **`assertWritableAgentIds`** — refuses an id nothing downstream could
   *     use, comparing against the current config so an odd key already on disk
   *     stays deletable.
   *  3. **`pruneDanglingSubagents`** — strips delegations to agents this patch
   *     just deleted. The *pruned* config is what this returns, and callers
   *     save the return value, so the file is written already healed. Without
   *     this step, deleting a delegated-to agent threw during the rebuild below
   *     and — since the rebuild happens before the write — reported a 500 and
   *     left the file untouched.
   *  4. **build** — where an unbuildable agent is still refused outright.
   *
   * All-or-nothing throughout: any throw leaves `#current` exactly as it was.
   */
  reconfigure(patch: ConfigPatch): Config {
    const merged = mergeConfigPatch(this.#current.config, patch);
    assertWritableAgentIds(this.#current.config, merged);
    const { config: next } = pruneDanglingSubagents(merged);
    const previous = this.#current;
    this.#current = this.#build(next, previous);
    // After the build, never before: `#build` can throw, and a reconfigure that
    // failed must leave the runtime serving exactly what it was serving — with
    // its containers still alive. Stopping them first would make a *refused*
    // save kill the toolboxPool of every running session.
    this.#retireToolboxes(previous);
    return next;
  }

  reload(): Config {
    // The constructor's own arguments, so a runtime built against a home or a
    // workspace override re-reads the same file it was built from rather than
    // whichever one the environment happens to name now.
    const loaded = loadConfig({
      ...(this.#options.home === undefined ? {} : { root: this.#options.home }),
      ...(this.#options.workspace === undefined ? {} : { workspace: this.#options.workspace }),
      env: this.#env,
    });
    const previous = this.#current;
    this.#current = this.#build(loaded.config, previous);
    this.#retireToolboxes(previous);
    return loaded.config;
  }

  close(): void {
    this.#current.toolboxPool?.close();
    this.store.close();
    if (this.#ownsProviders) this.#providers.clear();
  }

  /**
   * Stops the containers a superseded build owned.
   *
   * A profile can change under a running pool, and a container started from the
   * manifest that was approved *before* a save must not outlive it. Guarded on
   * identity because `#build` reuses the pool when nothing about it moved, and
   * closing the one now in use would stop the toolboxPool it just kept.
   */
  #retireToolboxes(previous: Resolved | undefined): void {
    const stale = previous?.toolboxPool;
    if (stale !== undefined && stale !== null && stale !== this.#current.toolboxPool) stale.close();
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
    const { agents, warnings } = resolveAgents(config);
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

    // Before the mutations below, because every failure it can produce — an
    // unapproved profile, a manifest edited since approval, a capability the
    // machinery will not grant, an unreachable daemon — must leave the runtime
    // serving on the settings that worked a moment ago.
    const built = this.#buildToolboxes(agents, paths);
    const toolboxPool = built.pool;

    // Here rather than in `resolveAgents`, because only now is the full set of
    // names an agent can advertise known: the toolbox's own programs are merged
    // over its map in `#createLoop`, and warning without them would fire on every
    // override a toolboxed agent has.
    const promptWarnings = agents.flatMap((agent) =>
      toolPromptWarnings(
        agent,
        new Set([
          ...Object.keys(built.toolboxPerms.get(agent.id) ?? {}),
          ...Object.keys(agent.tools),
          ...agent.subagents.map((binding) => binding.toolName),
        ]),
      ),
    );

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
    // Annotated rather than inferred, because the resolver below refers to
    // `loops` from inside its own initialiser: a loop's subagents are resolved
    // through the same cache that built it. Legal at runtime — `create` is only
    // ever *called* from `loops.get`, by which point the binding exists — but
    // inference cannot see that and gives up with an implicit `any`.
    const loops: LoopCache = new LoopCache({
      create: (agentId): AgentLoop | null =>
        this.#createLoop(config, agentId, paths, jails, toolboxPool ?? undefined, built, (id) =>
          loops.get(id),
        ),
    });
    const loop = loops.get(DEFAULT_AGENT_ID);

    return {
      config,
      agents,
      warnings: promptWarnings.length === 0 ? warnings : [...warnings, ...promptWarnings],
      paths,
      jails,
      toolboxPool,
      toolboxPrompts: built.prompts,
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
    runners: RunnerResolver | undefined,
    built: {
      readonly prompts: ReadonlyMap<string, PromptToolbox>;
      readonly exposed: ReadonlyMap<string, readonly AnyTool[]>;
      readonly toolboxPerms: ReadonlyMap<string, ToolPermissions>;
    },
    resolveLoop: (agentId: string) => AgentLoop | null,
  ): AgentLoop | null {
    const agent = resolveAgent(config, agentId);
    const { provider, model } = this.#resolveProvider(config, agent, paths);
    if (provider === null) return null;

    // One map, built once, used for both halves of the scope below — so a name
    // cannot be enabled in the definitions the model sees and refused by the
    // gate, or the reverse. The toolbox's manifest supplies defaults for its own
    // programs and the agent's own map wins over them: a manifest is the box
    // author's opinion about a program that `exec` can reach anyway, not a
    // containment boundary. (`toolbox.network.maxMode` is the boundary, and it
    // is intersected rather than overridden — see `assertNetworkWithinCeiling`.)
    const permissions: ToolPermissions = {
      ...built.toolboxPerms.get(agent.id),
      ...agent.tools,
    };

    return new AgentLoop({
      provider,
      // A view of the one shared registry, not a registry of its own: an MCP
      // server is one connection however many agents are configured.
      // The overlay, not the registry: a toolbox's programs are this agent's
      // alone, so they are laid over its view rather than registered globally
      // where two toolboxes holding `curl` would collide.
      tools: withToolboxTools(
        this.tools.select(permissions),
        built.exposed.get(agent.id) ?? [],
        permissions,
      ),
      store: this.store,
      jails,
      toolbox: agent.toolbox,
      ...toolboxPromptOf(built.prompts, agent.id),
      config: agent.defaults,
      toolsConfig: agent.toolsConfig,
      // The delegation half of what this agent may do. Beside `tools` and for
      // the same reason: both are resolved once, here, so a turn never asks the
      // config who it is allowed to call.
      subagents: subagentMap(agent.subagents),
      resolveLoop,
      model,
      agent: {
        id: agent.id,
        label: agent.label,
        systemPrompt: agent.systemPrompt,
        livePrompt: agent.livePrompt,
        wrapUpPrompt: agent.wrapUpPrompt,
        platformPrompt: agent.platformPrompt,
        toolboxPrompt: agent.toolboxPrompt,
        toolPolicyPrompt: agent.toolPolicyPrompt,
        promptMode: agent.promptMode,
        toolPrompts: agent.toolPrompts,
      },
      logger: this.#logger,
      steering: this.steering,
      env: this.#env,
      ...(this.#options.approvals === undefined ? {} : { approvals: this.#options.approvals }),
      ...(this.#options.clock === undefined ? {} : { clock: this.#options.clock }),
      ...(runners === undefined ? {} : { runners }),
      ...(this.#options.automation === undefined ? {} : { automation: this.#options.automation }),
    });
  }

  /**
   * The pool, when any enabled agent names a profile.
   *
   * `null` otherwise, and that is not an optimisation: probing for a container
   * runtime on an install that has no sandboxed agent would turn "docker is not
   * running" into a boot failure for people who never asked for a container.
   */
  #buildToolboxes(
    agents: readonly EffectiveAgent[],
    paths: GhostPaths,
  ): {
    pool: ToolboxPool | null;
    prompts: ReadonlyMap<string, PromptToolbox>;
    exposed: ReadonlyMap<string, readonly AnyTool[]>;
    toolboxPerms: ReadonlyMap<string, ToolPermissions>;
  } {
    const boxed = agents.filter((agent) => agent.toolbox.name !== '');
    if (boxed.length === 0) {
      return { pool: null, prompts: new Map(), exposed: new Map(), toolboxPerms: new Map() };
    }

    const toolboxes = new ToolboxStore({
      database: this.store.database,
      dir: paths.toolboxesDir,
      ...(this.#options.clock === undefined ? {} : { clock: this.#options.clock }),
    });

    // Every toolboxed agent resolved *here*, so an unapproved toolbox, one
    // edited since approval, or a network request above its ceiling is a refusal
    // on the save rather than a turn that dies on its first `exec`. The prompt
    // sections fall out of the same pass, which is why this is not two walks.
    const prompts = new Map<string, PromptToolbox>();
    const exposed = new Map<string, readonly AnyTool[]>();
    const toolboxPerms = new Map<string, ToolPermissions>();
    for (const agent of boxed) {
      const approved = toolboxes.require(agent.toolbox.name);
      assertNetworkWithinCeiling(approved.toolbox, agent.toolbox.network, agent.id);
      exposed.set(agent.id, toolboxTools(approved.toolbox));
      toolboxPerms.set(agent.id, toolboxPermissions(approved.toolbox));
      prompts.set(agent.id, {
        name: approved.toolbox.name,
        workdir: approved.toolbox.workdir,
        tools: approved.toolbox.tools,
        notes: approved.toolbox.notes,
        docs: approved.docs,
      });
    }

    // **The daemon is deliberately not probed here.** Whether a profile is
    // installed, approved and internally coherent is static config, and belongs
    // in an all-or-nothing rebuild. Whether a container runtime is *running* is
    // not: it changes while the server is up, an operator may start Docker after
    // GhostAI, and one sandboxed agent must not make the daemon a precondition
    // for the web UI, the settings screen and every other agent. Probing here
    // did exactly that — an install with a research agent would not boot at all
    // without Docker. The pool probes on first use instead, and refuses that
    // turn.
    const engine = this.#options.containerEngine ?? dockerEngine();

    const pool = new ToolboxPool({
      toolboxes,
      engine,
      runsDir: paths.runsDir,
      ...(this.#options.hostWorkspacePath === undefined
        ? {}
        : { hostPath: this.#options.hostWorkspacePath }),
      ...(this.#options.clock === undefined ? {} : { clock: this.#options.clock }),
      logger: this.#logger,
    });

    return { pool, prompts, exposed, toolboxPerms };
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

/**
 * The `toolboxPrompt` spread, or nothing.
 *
 * A helper rather than an inline ternary because `exactOptionalPropertyTypes`
 * treats `{ toolboxPrompt: PromptToolbox | undefined }` as different from the
 * property being absent, and a `Map.get` narrowed in the condition widens again
 * in the branch.
 */
function toolboxPromptOf(
  prompts: ReadonlyMap<string, PromptToolbox>,
  agentId: string,
): { toolboxPrompt?: PromptToolbox } {
  const prompt = prompts.get(agentId);
  return prompt === undefined ? {} : { toolboxPrompt: prompt };
}
