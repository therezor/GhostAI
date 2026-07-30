/**
 * `GhostRuntime` as the server's routes want it.
 *
 * `@ghostai/server` states a narrow `ServerRuntime` port rather than importing
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

import { DEFAULT_AGENT_ID, saveConfig } from '@ghostai/core';
import type {
  Config,
  ConfigPatch,
  ModelInfo,
  ModelsResponse,
  ProviderTestRequest,
  ProviderTestResponse,
  SetCredentialRequest,
} from '@ghostai/protocol';
import {
  createProvider,
  findProvider,
  isProviderError,
  listInstances,
  resolveConnection,
  type ChatProvider,
  type ProviderSpec,
} from '@ghostai/providers';
import { ToolboxStore } from '@ghostai/security';
import { openVault, resolveAgent, type GhostRuntime } from '@ghostai/runtime';
import type { AgentSummary, AgentView, ServerRuntime } from '@ghostai/server';
import type { CredentialVault, FetchImplementation } from '@ghostai/security';

/**
 * How long a fetched catalogue is served before the endpoints are asked again.
 *
 * Long enough that opening the settings panel twice does not reach a local
 * model server twice; short enough that pulling a new model and coming back is
 * not a puzzle. `POST /api/models/refresh` bypasses it outright, which is what
 * the refresh button in the UI is for.
 */
const MODEL_CACHE_TTL_MS = 60_000;

/**
 * How long one endpoint gets to answer before it is reported as unreachable.
 *
 * Short on purpose: the whole list is only as fast as its slowest member, and a
 * laptop that has closed since the config was written must not make the
 * settings panel look hung. A timeout lands in `errors` beside a real refusal,
 * which is the honest place for it.
 */
const MODEL_FETCH_TIMEOUT_MS = 5000;

export interface ServerRuntimeOptions {
  /** Defaults to `process.env`; the presence flags read provider key variables. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Replaces the on-disk vault. Injected by tests, which have no keychain. */
  readonly vault?: CredentialVault;
  /** Injected by tests so nothing here opens a socket. */
  readonly fetchImpl?: FetchImplementation;
  /** Injected so a test does not wait out a real timeout. */
  readonly modelTimeoutMs?: number;
}

export function createServerRuntime(
  runtime: GhostRuntime,
  options: ServerRuntimeOptions = {},
): ServerRuntime {
  const env = options.env ?? process.env;
  let vault: CredentialVault | undefined = options.vault;
  let cached: { atMs: number; response: ModelsResponse } | undefined;

  /** `create` is what separates reading presence from storing a key. */
  const openIfUseful = (create: boolean): CredentialVault | undefined => {
    if (vault !== undefined) return vault;
    if (!create && !existsSync(runtime.paths.vaultFile)) return undefined;
    vault = openVault(runtime.paths);
    return vault;
  };

  /**
   * Why a probe did not produce a catalogue, keeping the classification.
   *
   * `reason` is the whole value of this: `auth` means the endpoint answered and
   * refused the key, `transport` means nothing answered at all, and those send
   * an operator to two entirely different places. `errors.ts` classifies from
   * the status and the socket code, never from message text, so this passes the
   * verdict along rather than re-deriving one.
   *
   * A throw that is not a `ProviderError` came from `createProvider` before any
   * socket was opened — `assertUsableApiBase` refusing a base URL, or refusing
   * to put a key on plain HTTP to a public host. That is the submitted
   * connection being invalid, not the endpoint being unwell.
   */
  const describeFailure = (error: unknown): { reason: string; message: string } => {
    const message = error instanceof Error ? error.message : String(error);
    return { reason: isProviderError(error) ? error.reason : 'invalid_request', message };
  };

  /**
   * One connection, asked for its catalogue. The only place here that dials out.
   *
   * Takes a resolved connection rather than an instance id, because the two
   * callers want different things from it: `models` asks about something the
   * config names, and `testProvider` asks about something an operator has typed
   * and not saved yet.
   */
  const probeConnection = async (probe: {
    readonly spec: ProviderSpec;
    readonly apiBase: string;
    readonly extraHeaders: Readonly<Record<string, string>>;
    readonly apiKey: string | undefined;
  }): Promise<{ models: ModelInfo[] } | { reason: string; message: string }> => {
    if (probe.spec.supportsModelListing !== true) {
      return {
        reason: 'unsupported',
        message: `${probe.spec.displayName} does not publish a model list, so there is nothing to ask it.`,
      };
    }

    let provider: ChatProvider;
    try {
      // Deliberately not through the runtime's `ProviderCache`: that cache is
      // keyed by model as well as connection, and listing a catalogue has no
      // model. Building a bare adapter for the call keeps a settings-panel
      // refresh from evicting the adapter the next turn is going to want.
      provider = createProvider({
        provider: probe.spec,
        apiKey: probe.apiKey,
        apiBase: probe.apiBase,
        extraHeaders: probe.extraHeaders,
        ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
        // Retries and degradation are for a turn. A catalogue that does not
        // answer promptly should say so, not spend fifteen seconds insisting.
        resilience: false,
      });
    } catch (error) {
      return describeFailure(error);
    }

    const signal = AbortSignal.timeout(options.modelTimeoutMs ?? MODEL_FETCH_TIMEOUT_MS);
    try {
      return { models: await provider.listModels(signal) };
    } catch (error) {
      return describeFailure(error);
    } finally {
      await provider.close();
    }
  };

  /**
   * One instance's catalogue, as a result rather than a rejection.
   *
   * A provider that cannot be reached is a normal state — a laptop is closed, a
   * key expired — and one of them must not fail the whole list. The reason is
   * carried through to `errors` so the panel can say which endpoint went quiet
   * rather than silently showing a shorter list.
   */
  const fetchModels = async (
    instanceId: string,
  ): Promise<{ models: ModelInfo[] } | { error: string }> => {
    const config = runtime.config.providers[instanceId];
    const instance = listInstances(runtime.config.providers).find((i) => i.id === instanceId);
    if (config === undefined || instance === undefined) return { models: [] };

    const result = await probeConnection({
      spec: instance.spec,
      ...resolveConnection(instance.spec, config),
      apiKey: readCredential(instanceId, instance.spec.envKey),
    });
    // `errors` is a map of prose, so the reason is dropped here rather than
    // carried: `ModelsResponse` reports a list that came up short, and the
    // question "why exactly" is what `providers.test` exists to answer.
    if ('reason' in result) return { error: result.message };

    return {
      models: result.models.map((model) => ({
        ...model,
        providerId: instance.id,
        providerType: instance.spec.id,
      })),
    };
  };

  const readCredential = (instanceId: string, envKey: string | undefined): string | undefined => {
    const stored = openIfUseful(false)?.get('providers', instanceId);
    if (stored !== undefined && stored !== '') return stored;
    const fromEnv = envKey === undefined ? undefined : env[envKey];
    return fromEnv === '' ? undefined : fromEnv;
  };

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
        cached = undefined;
      }

      return saveConfig(runtime.file, merged);
    },

    reload: (): Config => {
      const next = runtime.reload();
      // The file is the source here, so there is nothing to write back — and
      // writing would turn a reload into a save, which is how a config edited
      // by hand gets reformatted by the button that was meant to read it.
      //
      // The catalogue goes, though: a reload is how an operator picks up an
      // endpoint that moved or a model they have just pulled, and serving a
      // list fetched before the reload would answer with what they changed.
      cached = undefined;
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
      if (store === undefined) throw new Error('The credential vault could not be opened');
      if (request.value === null) store.delete(request.namespace, request.key);
      else store.set(request.namespace, request.key, request.value);
      // An empty patch is not a no-op: the rebuild re-reads the credential, and
      // without it the loop keeps the provider it was built with — so a key
      // saved in the UI would not take effect until a restart.
      runtime.reconfigure({});
      // A key is often what stood between an endpoint and its catalogue.
      cached = undefined;
    },

    store: runtime.store,
    workspaces: runtime.workspaces,

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
        // so no turn to describe; the narrowed registry is the honest answer there.
        tools: loop?.toolDefinitions ?? runtime.tools.select(agent.tools).definitions(),
        contextWindowTokens: agent.defaults.contextWindowTokens,
        // The loop's own composition, not a second assembly of it: memory and
        // skills arrive as contributors attached to that object, and a
        // reimplementation here could not see them.
        systemPrompt: async (input) => {
          if (loop === null) {
            // The context route asks for this to show what a turn would carry.
            // With no model there is no turn and no prompt, and throwing would
            // make one unconfigured panel break a screen that otherwise works.
            return 'No model is configured, so no system prompt has been assembled yet.';
          }
          return await loop.previewPrompt(input);
        },
      };
    },

    agents: (): readonly AgentSummary[] =>
      runtime.agents.map((agent) => ({
        id: agent.id,
        label: agent.label,
        // After inheritance, and after any process-wide pin, so a picker shows
        // what a turn would actually use rather than what the file says.
        model: runtime.loopFor(agent.id)?.model ?? agent.defaults.model,
        provider: runtime.instance?.id ?? '',
      })),

    models: async (modelOptions): Promise<ModelsResponse> => {
      const now = Date.now();
      if (
        modelOptions?.refresh !== true &&
        cached !== undefined &&
        now - cached.atMs < MODEL_CACHE_TTL_MS
      ) {
        return cached.response;
      }

      const listable = listInstances(runtime.config.providers).filter(
        (instance) => instance.config.enabled && instance.spec.supportsModelListing === true,
      );

      // All at once: the list is as slow as its slowest endpoint either way,
      // and in sequence it would be as slow as their sum.
      const results = await Promise.all(
        listable.map(async (instance) => ({
          id: instance.id,
          result: await fetchModels(instance.id),
        })),
      );

      const models: ModelInfo[] = [];
      const errors: Record<string, string> = {};
      for (const { id, result } of results) {
        if ('error' in result) errors[id] = result.error;
        else models.push(...result.models);
      }

      const response: ModelsResponse = { models, errors };
      cached = { atMs: now, response };
      return response;
    },

    testProvider: async (request: ProviderTestRequest): Promise<ProviderTestResponse> => {
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

      const result = await probeConnection({
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
        return { ok: false, models: [], reason: result.reason, message: result.message };
      }

      // A successful probe has just learned this endpoint's catalogue first
      // hand, which makes the cached one out of date by definition. Dropping it
      // is what turns "fetch this provider's models" into something the rest of
      // the app sees: without it the Agent panel would go on offering a 60 s
      // old list that predates the endpoint the operator just fixed.
      cached = undefined;

      // Ids only. The probe's job is "can this be reached, and what is on it" —
      // the shaped catalogue is what `models.list` serves.
      return { ok: true, models: result.models.map((model) => model.id) };
    },
  };
}
