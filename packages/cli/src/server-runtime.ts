/**
 * `GhostRuntime` as the server's routes want it.
 *
 * `@ghostbot/server` states a narrow `ServerRuntime` port rather than importing
 * the composition root, so that a route test needs neither a provider nor a
 * vault nor a workspace. This is the adapter on the other side of that port,
 * and it lives here because `ghost serve` is where the two halves are wired
 * together in the first place.
 *
 * It is not a pass-through. Five things the port promises are implemented
 * *here* rather than in the runtime:
 *
 *  - **A settings save persists.** `GhostRuntime.reconfigure` deliberately does
 *    not write `config.json` — previewing a patch and saving one are different
 *    operations — so `applySettings` is reconfigure-then-write. The write runs
 *    after the rebuild, so a patch that cannot be built leaves both the running
 *    server and the file on the settings that worked.
 *  - **Deleting a provider instance takes its credential with it.** The config
 *    is only half of an instance; the other half is a vault entry keyed by the
 *    same id, and leaving it behind means the next instance to reuse that id
 *    silently inherits somebody else's key.
 *  - **A credential written over HTTP is usable on the next turn.** The vault
 *    is written and then the runtime is rebuilt with an empty patch, which
 *    re-reads it: the provider adapter is keyed on a digest of the key, so a
 *    new key is a new adapter and the turn after the save uses it.
 *  - **The vault is opened only when there is one, or when one is being
 *    written.** `resolveVaultKey` mints a keychain entry the first time it
 *    runs, and an install that talks to a local model and never stores a
 *    credential should not acquire one because someone opened the settings
 *    panel.
 *  - **Model lists come from the endpoints themselves.** Every OpenAI-compatible
 *    server answers `GET /models`, which is most of them and all of the local
 *    ones — so the settings panel and the setup wizard can offer a real
 *    catalogue instead of a text box.
 */

import { existsSync } from 'node:fs';

import { DEFAULT_AGENT_ID, GhostError, saveConfig } from '@ghostbot/core';
import type {
  Config,
  ConfigPatch,
  ExtensionCommand,
  ExtensionStatus,
  McpServerStatus,
  ModelsResponse,
  ProviderTestRequest,
  ProviderTestResponse,
  RunCommandResponse,
  SetCredentialRequest,
  ToolDefinition,
} from '@ghostbot/protocol';
import {
  findProvider,
  listInstances,
  resolveConnection,
  type ChatResult,
} from '@ghostbot/providers';
import { ExtensionStore, ToolboxStore } from '@ghostbot/security';
import { openVault, resolveAgent, type GhostRuntime } from '@ghostbot/runtime';
import type {
  AgentSummary,
  AgentView,
  ServerRuntime,
  ExtensionCounts,
} from '@ghostbot/server';
import type { CredentialVault, FetchImplementation } from '@ghostbot/security';

import { createModelCatalogue } from './models.js';

interface ServerRuntimeOptions {
  /** Defaults to `process.env`; the presence flags read provider key variables. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Replaces the on-disk vault. Injected by tests, which have no keychain. */
  readonly vault?: CredentialVault;
  /** Injected by tests so nothing here opens a socket. */
  readonly fetchImpl?: FetchImplementation;
  /** Injected so a test does not wait out a real timeout. */
  readonly modelTimeoutMs?: number;
  /**
   * Rebuilds what only `ghost serve` owns, after an extension was loaded.
   *
   * The knot this unties: approving an extension can bring a `ChannelFactory`
   * with it, and `ChannelManager` fixes its factories at construction and
   * refuses `register` after `start`. Rebuilding the manager is `serve.ts`'s
   * job — it owns the hub, the bus and the shutdown order — and this adapter is
   * the only thing the route can reach. So `serve.ts` passes the callback in,
   * the same late binding `ServerOptions.scheduler` uses for the same knot.
   */
  readonly onExtensionsChanged?: () => Promise<void> | void;
}

export function createServerRuntime(
  runtime: GhostRuntime,
  options: ServerRuntimeOptions = {},
): ServerRuntime {
  const env = options.env ?? process.env;
  let vault: CredentialVault | undefined = options.vault;

  /** `create` is what separates reading presence from storing a key. */
  const openIfUseful = (create: boolean): CredentialVault | undefined => {
    if (vault !== undefined) return vault;
    if (!create && !existsSync(runtime.paths.vaultFile)) return undefined;
    vault = openVault(runtime.paths);
    return vault;
  };

  const extensionStore = (): ExtensionStore =>
    new ExtensionStore({
      database: runtime.store.database,
      dir: runtime.paths.extensionsDir,
    });

  /**
   * Loads what the approval just changed, then lets `serve.ts` catch up.
   *
   * Two steps and they are not interchangeable: the runtime has to reconcile
   * first, because the channel factories `serve.ts` is about to collect only
   * exist once the extension has been activated.
   */
  const reloadExtensions = async (): Promise<void> => {
    await runtime.reloadExtensions();
    await options.onExtensionsChanged?.();
  };

  const readCredential = (
    instanceId: string,
    envKey: string | undefined,
  ): string | undefined => {
    const stored = openIfUseful(false)?.get('providers', instanceId);
    if (stored !== undefined && stored !== '') return stored;
    const fromEnv = envKey === undefined ? undefined : env[envKey];
    return fromEnv === '' ? undefined : fromEnv;
  };

  /**
   * Model listing, which is no longer this file's job.
   *
   * It reads the same config and dials the same endpoints the REPL's `/model`
   * does, so it lives in `models.ts` and both consume it. `readCredential` is
   * passed in rather than a vault, because opening the vault is a decision this
   * file makes and the catalogue must not.
   */
  const catalogue = createModelCatalogue(runtime, {
    credentialFor: (instance) =>
      readCredential(instance.id, instance.spec.envKey),
    ...(options.fetchImpl === undefined
      ? {}
      : { fetchImpl: options.fetchImpl }),
    ...(options.modelTimeoutMs === undefined
      ? {}
      : { timeoutMs: options.modelTimeoutMs }),
  });

  return {
    config: () => runtime.config,

    /**
     * Read from disk on every call, deliberately.
     *
     * A profile edited after approval must stop reporting as usable the moment it
     * changes, and a list cached at boot would keep saying it was fine until a
     * restart. Constructing the store per call is a table check and a `readdir`.
     */
    toolboxes: () =>
      new ToolboxStore({
        database: runtime.store.database,
        dir: runtime.paths.toolboxesDir,
      }).list(),

    applySettings: (patch: ConfigPatch): Config => {
      const before = new Set(Object.keys(runtime.config.providers));
      const merged = runtime.reconfigure(patch);

      // After the rebuild, so a patch that could not be built has not already
      // destroyed a credential on its way to failing.
      const removed = [...before].filter((id) => !(id in merged.providers));
      if (removed.length > 0) {
        const store = openIfUseful(false);
        for (const id of removed) store?.delete('providers', id);
        // The catalogue named instances that no longer exist.
        catalogue.invalidate();
      }

      return saveConfig(runtime.file, merged);
    },

    // A declared capability with no source yet, stated rather than left absent.
    // `loadConfig` throws on an unreadable file, so a running server has no load
    // error to report — there is no tolerant-boot path for it to describe. It
    // was simply missing before, which the optional signature let pass: `GET
    // /api/settings` never reported a load error at all.
    loadError: (): string | undefined => undefined,

    // `ready` and not merely "configured": the count answers "how many servers
    // could a turn actually reach", which is the question the status line is
    // asking. A server that is retrying is not one of them.
    extensions: (): ExtensionCounts => ({
      mcpServersConnected: runtime
        .mcpServers()
        .filter((server) => server.state === 'ready').length,
      // `ready` here too, and for the same reason: an extension that is
      // installed, unapproved or broken is not one a turn can use.
      extensionsLoaded: runtime.extensions?.loadedCount ?? 0,
    }),

    mcpServers: (): readonly McpServerStatus[] => runtime.mcpServers(),

    extensionStatuses: (): readonly ExtensionStatus[] =>
      runtime.extensions?.status() ?? [],

    approveExtension: async (id: string): Promise<void> => {
      // Through a store of its own rather than the host's, for the reason
      // `ToolboxStore` is constructed per use: it is a thin object over the
      // shared connection, and passing the host's out would make the approval
      // gate reachable from anything holding a host.
      extensionStore().approve(id);
      await reloadExtensions();
    },

    revokeExtension: async (id: string): Promise<void> => {
      extensionStore().revoke(id);
      await reloadExtensions();
    },

    commands: (): readonly ExtensionCommand[] =>
      runtime.extensions?.commands() ?? [],

    runCommand: async (id, input): Promise<RunCommandResponse> => {
      const host = runtime.extensions;
      if (host === undefined) {
        throw new GhostError('not_found', `No command called "${id}"`);
      }
      const result = await host.runCommand(id, {
        args: input.args,
        sessionKey: input.sessionKey,
        signal: input.signal,
      });
      return { message: result.message, ok: result.ok ?? true };
    },

    configWarnings: () => runtime.configWarnings,

    reload: (): Config => {
      const next = runtime.reload();
      // The file is the source here, so there is nothing to write back — and
      // writing would turn a reload into a save, which is how a config edited
      // by hand gets reformatted by the button that was meant to read it.
      //
      // The catalogue goes, though: a reload is how an operator picks up an
      // endpoint that moved or a model they have just pulled, and serving a
      // list fetched before the reload would answer with what they changed.
      catalogue.invalidate();
      return next;
    },

    credentialsPresent: (): Readonly<Record<string, boolean>> => {
      const stored = openIfUseful(false);
      const present: Record<string, boolean> = {};
      // By instance, not by provider type: two endpoints of one type can hold
      // different keys, and reporting the type would light both up for one.
      for (const instance of listInstances(runtime.config.providers)) {
        const envKey = instance.spec.envKey;
        const fromEnv = envKey === undefined ? undefined : env[envKey];
        present[instance.id] =
          (fromEnv !== undefined && fromEnv !== '') ||
          stored?.has('providers', instance.id) === true;
      }
      return present;
    },

    setCredential: (request: SetCredentialRequest): void => {
      const store = openIfUseful(true);
      if (store === undefined) {
        throw new Error('The credential vault could not be opened');
      }
      if (request.value === null) store.delete(request.namespace, request.key);
      else store.set(request.namespace, request.key, request.value);
      // An empty patch is not a no-op: the rebuild re-reads the credential, and
      // without it the loop keeps the provider it was built with — so a key
      // saved in the UI would not take effect until a restart.
      runtime.reconfigure({});
      // A key is often what stood between an endpoint and its catalogue.
      catalogue.invalidate();
    },

    store: runtime.store,
    workspaces: runtime.workspaces,

    releaseWorkspace: (workspaceId: string): void => {
      runtime.evictWorkspace(workspaceId);
    },

    agent: (agentId?: string): AgentView => {
      // Resolution throws for an id naming nothing runnable, which the route
      // turns into a 404 — the alternative, silently describing the default,
      // would report tools and a prompt for an agent nobody asked about.
      const agent = resolveAgent(runtime.config, agentId);
      const loop = runtime.loopFor(agentId);
      const isDefault = agent.id === DEFAULT_AGENT_ID;

      return {
        id: agent.id,
        label: agent.label,
        // Empty rather than a sentinel on an unconfigured install: `configured`
        // is the flag to branch on, so nothing has to read meaning into a string.
        provider: runtime.instance?.id ?? '',
        model: loop?.model ?? (runtime.configured ? runtime.model : ''),
        configured: isDefault ? runtime.configured : loop !== null,
        jail: runtime.jail,
        jailFor: (workspaceId) => runtime.jails.forWorkspace(workspaceId),
        // The loop's own list, for the same reason `systemPrompt` below defers to
        // it. `runtime.tools.select(agent.tools)` is the built-ins narrowed by the
        // allow-list — correct as far as it goes, and blind to the toolbox tools
        // that `withToolboxTools` composes on top of that scope when the agent has
        // a toolbox. Rebuilt here, a researcher's `search` and `fetch` were absent
        // from the context inspector and from its token count.
        //
        // The fallback covers an unconfigured install, where there is no loop and
        // so no turn to describe; the narrowed registry is the honest answer
        // there — except when the agent advertises no tools at all, which the
        // registry cannot know and which would otherwise have the panel list a
        // toolset no turn on this agent would ever send.
        tools:
          loop?.toolDefinitions ??
          (agent.defaults.toolsEnabled
            ? runtime.tools.select(agent.tools).definitions()
            : []),
        contextWindowTokens: agent.defaults.contextWindowTokens,
        // The loop's own composition, not a second assembly of it: memory and
        // skills arrive as contributors attached to that object, and a
        // reimplementation here could not see them.
        systemPrompt: async (input) => {
          if (loop === null) {
            // The context route asks for this to show what a turn would carry.
            // With no model there is no turn and no prompt, and throwing would
            // make one unconfigured panel break a screen that otherwise works.
            return {
              staticPrompt:
                'No model is configured, so no system prompt has been assembled yet.',
              runtimeBlock: '',
            };
          }
          return await loop.previewPrompt(input);
        },
      };
    },

    // The bare registry, narrowed by nobody. Built-ins, MCP registrations and
    // extension tools — everything an agent could be granted. Toolbox programs are
    // absent because they belong to a toolbox rather than the registry, and the
    // editor reads those from `GET /api/toolboxes` under their own heading.
    registeredTools: (): readonly ToolDefinition[] =>
      runtime.tools.definitions(),

    agents: (): readonly AgentSummary[] =>
      runtime.agents.map((agent) => ({
        id: agent.id,
        label: agent.label,
        // After inheritance, and after any process-wide pin, so a picker shows
        // what a turn would actually use rather than what the file says.
        model: runtime.loopFor(agent.id)?.model ?? agent.defaults.model,
        provider: runtime.instance?.id ?? '',
      })),

    models: async (modelOptions): Promise<ModelsResponse> =>
      await catalogue.list(modelOptions),

    testProvider: async (
      request: ProviderTestRequest,
    ): Promise<ProviderTestResponse> => {
      const spec = findProvider(request.type);
      if (spec === null) {
        return {
          ok: false,
          models: [],
          reason: 'unsupported',
          message: `There is no provider type called “${request.type}”.`,
        };
      }

      // An omitted key means "whatever is stored", which is how a saved row
      // re-tests without the client having to hold the credential to do it. An
      // *empty* one is a different question — "does this answer with no key at
      // all" — and both are ones an operator asks, so they are not collapsed.
      const apiKey =
        request.apiKey ??
        (request.instanceId === undefined
          ? undefined
          : readCredential(request.instanceId, spec.envKey));

      const result = await catalogue.probe({
        spec,
        ...resolveConnection(spec, {
          type: request.type,
          label: '',
          apiBase: request.apiBase,
          extraHeaders: request.extraHeaders,
          models: [],
          enabled: true,
        }),
        apiKey: apiKey === '' ? undefined : apiKey,
      });

      if ('reason' in result) {
        return {
          ok: false,
          models: [],
          reason: result.reason,
          message: result.message,
        };
      }

      // A successful probe has just learned this endpoint's catalogue first
      // hand, which makes the cached one out of date by definition. Dropping it
      // is what turns "fetch this provider's models" into something the rest of
      // the app sees: without it the Agent panel would go on offering a 60 s
      // old list that predates the endpoint the operator just fixed.
      catalogue.invalidate();

      // Ids only. The probe's job is "can this be reached, and what is on it" —
      // the shaped catalogue is what `models.list` serves.
      return { ok: true, models: result.models.map((model) => model.id) };
    },

    /**
     * One provider request outside a turn — the heartbeat's forced `skip | run`
     * decision, and nothing else.
     *
     * `providerFor` resolves the same endpoint, credential and model a turn for
     * this agent would use, with `model` overriding so a heartbeat can run on
     * something cheaper than the agent's own. It refuses rather than falling
     * back on an unconfigured install: a heartbeat that could not ask has to be
     * a recorded error, because the alternative is guessing "run" and starting
     * an unbounded turn every interval forever.
     */
    chat: async (input): Promise<ChatResult> => {
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
