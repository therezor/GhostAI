/**
 * What models this install can actually reach.
 *
 * This lived inside a closure in `server-runtime.ts`, which meant the only way
 * to ask "what models are there" was to build the whole `ServerRuntime` port —
 * a Fastify-shaped object with settings saves, credential writes and toolbox
 * approvals on it. The REPL's `/model` needs one of those answers and none of
 * the rest, so the catalogue moved out here and the port consumes it. One
 * implementation, two callers, and neither of them a superset of the other.
 *
 * Three decisions carried over unchanged, because each of them was already
 * right:
 *
 *  - **A provider that cannot be reached is a normal state.** A laptop closes, a
 *    key expires. One endpoint going quiet must not fail the whole list, so a
 *    failure becomes an entry in `errors` beside the models that did arrive —
 *    which is what lets a caller say *which* endpoint went quiet rather than
 *    silently showing a shorter list.
 *  - **The adapter is built bare, outside the runtime's `ProviderCache`.** That
 *    cache is keyed by model as well as connection, and a catalogue has no
 *    model; going through it would let a settings refresh evict the adapter the
 *    next turn is about to want.
 *  - **Credentials are read through an injected callback.** Reading one means
 *    opening the vault, and opening the vault mints a keychain entry the first
 *    time — a decision that belongs to whoever knows whether this install has
 *    one, not to the thing listing models.
 */

import type { ModelInfo, ModelsResponse } from '@ghostai/protocol';
import {
  createProvider,
  isProviderError,
  listInstances,
  resolveConnection,
  type ChatProvider,
  type ProviderInstance,
  type ProviderSpec,
} from '@ghostai/providers';
import type { GhostRuntime } from '@ghostai/runtime';
import type { FetchImplementation } from '@ghostai/security';

/**
 * How long a fetched catalogue is served before the endpoints are asked again.
 *
 * Long enough that opening the settings panel twice does not reach a local
 * model server twice; short enough that pulling a new model and coming back is
 * not a puzzle. A `refresh` bypasses it outright, which is what the refresh
 * button in the UI is for.
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
export const MODEL_FETCH_TIMEOUT_MS = 5000;

/** One endpoint, resolved far enough to dial. */
export interface Connection {
  readonly spec: ProviderSpec;
  readonly apiBase: string;
  readonly extraHeaders: Readonly<Record<string, string>>;
  readonly apiKey: string | undefined;
}

/** A catalogue, or why there is not one. */
type ProbeResult =
  | { readonly models: ModelInfo[] }
  | { readonly reason: string; readonly message: string };

interface ModelCatalogueOptions {
  /** Injected by tests so nothing here opens a socket. */
  readonly fetchImpl?: FetchImplementation | undefined;
  /** Injected so a test does not wait out a real timeout. */
  readonly timeoutMs?: number | undefined;
  /**
   * The key for one provider instance, if this install has one.
   *
   * A callback rather than a vault, because reading a credential can *create*
   * the vault — and an install that talks to a local model and never stores a
   * key should not acquire a keychain entry because something listed models.
   */
  readonly credentialFor: (instance: ProviderInstance) => string | undefined;
}

export interface ModelCatalogue {
  /** Every reachable model, cached for `MODEL_CACHE_TTL_MS`. */
  list(options?: { readonly refresh?: boolean }): Promise<ModelsResponse>;
  /**
   * One connection, asked for its catalogue. The only thing here that dials out.
   *
   * Takes a resolved connection rather than an instance id, because the two
   * callers want different things: `list` asks about something the config names,
   * and a provider test asks about something an operator has typed and not saved.
   */
  probe(connection: Connection): Promise<ProbeResult>;
  /**
   * Drops the cached catalogue.
   *
   * Called whenever something has happened that the cache cannot know about: a
   * settings save, a credential written, a successful probe that has just
   * learned an endpoint's catalogue first hand. Without it the panel would go
   * on serving a sixty-second-old list that predates the fix the operator has
   * just made.
   */
  invalidate(): void;
}

/**
 * Why a probe did not produce a catalogue, keeping the classification.
 *
 * `reason` is the whole value of this: `auth` means the endpoint answered and
 * refused the key, `transport` means nothing answered at all, and those send an
 * operator to two entirely different places. The provider package classifies
 * from the status and the socket code, never from message text, so this passes
 * the verdict along rather than re-deriving one.
 */
function describeFailure(error: unknown): {
  reason: string;
  message: string;
} {
  return {
    reason: isProviderError(error) ? error.reason : 'invalid_request',
    message: error instanceof Error ? error.message : String(error),
  };
}

export function createModelCatalogue(
  runtime: GhostRuntime,
  options: ModelCatalogueOptions,
): ModelCatalogue {
  let cached: { atMs: number; response: ModelsResponse } | undefined;

  const probe = async (connection: Connection): Promise<ProbeResult> => {
    if (connection.spec.supportsModelListing !== true) {
      return {
        reason: 'unsupported',
        message: `${connection.spec.displayName} does not publish a model list, so there is nothing to ask it.`,
      };
    }

    let provider: ChatProvider;
    try {
      provider = createProvider({
        provider: connection.spec,
        apiKey: connection.apiKey,
        apiBase: connection.apiBase,
        extraHeaders: connection.extraHeaders,
        ...(options.fetchImpl === undefined
          ? {}
          : { fetchImpl: options.fetchImpl }),
        // Retries and degradation are for a turn. A catalogue that does not
        // answer promptly should say so, not spend fifteen seconds insisting.
        resilience: false,
      });
    } catch (error) {
      return describeFailure(error);
    }

    const signal = AbortSignal.timeout(
      options.timeoutMs ?? MODEL_FETCH_TIMEOUT_MS,
    );
    try {
      return { models: await provider.listModels(signal) };
    } catch (error) {
      return describeFailure(error);
    } finally {
      await provider.close();
    }
  };

  const fetchModels = async (
    instanceId: string,
  ): Promise<{ models: ModelInfo[] } | { error: string }> => {
    const config = runtime.config.providers[instanceId];
    const instance = listInstances(runtime.config.providers).find(
      (one) => one.id === instanceId,
    );
    if (config === undefined || instance === undefined) return { models: [] };

    const result = await probe({
      spec: instance.spec,
      ...resolveConnection(instance.spec, config),
      apiKey: options.credentialFor(instance),
    });
    // `errors` is a map of prose, so the reason is dropped here rather than
    // carried: `ModelsResponse` reports a list that came up short, and the
    // question "why exactly" is what a provider test exists to answer.
    if ('reason' in result) return { error: result.message };

    return {
      models: result.models.map((model) => ({
        ...model,
        providerId: instance.id,
        providerType: instance.spec.id,
      })),
    };
  };

  return {
    probe,

    invalidate(): void {
      cached = undefined;
    },

    async list(listOptions): Promise<ModelsResponse> {
      const now = Date.now();
      if (
        listOptions?.refresh !== true &&
        cached !== undefined &&
        now - cached.atMs < MODEL_CACHE_TTL_MS
      ) {
        return cached.response;
      }

      const listable = listInstances(runtime.config.providers).filter(
        (instance) =>
          instance.config.enabled &&
          instance.spec.supportsModelListing === true,
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
  };
}
