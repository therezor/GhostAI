/**
 * What can be talked to, and with which models.
 *
 * `GET /api/providers` answers two questions at once, because the settings
 * panel asks both: `types` is the catalogue an operator adds an endpoint from,
 * projected from the `PROVIDERS` table, and `instances` is what they have
 * actually configured. Both projections live in `@ghostai/providers` beside the
 * table itself, so adding a provider stays a one-line table entry rather than a
 * table entry plus a route change — and this route supplies the one thing
 * neither can know: whether a credential exists, which is the vault's business
 * and never leaves it as a value.
 */

import {
  ModelsResponseSchema,
  ProviderTestRequestSchema,
  ProviderTestResponseSchema,
  ProvidersResponseSchema,
  type ModelInfo,
  type ModelsResponse,
  type ProviderTestRequest,
  type ProviderTestResponse,
  type ProvidersResponse,
} from '@ghostai/protocol';
import { PROVIDERS, describeInstance, describeProvider, listInstances } from '@ghostai/providers';

import type { RouteDeps, RouteGroup } from './types.js';

type ProviderRouteId = 'providers.list' | 'providers.test' | 'models.list' | 'models.refresh';

/**
 * The models the settings tree names, with no endpoint asked.
 *
 * Still the fallback even now that instances can be enumerated live, and it
 * earns the place twice over: a provider that is unreachable must not empty the
 * picker of the model a turn is currently using, and an endpoint with no
 * catalogue route has nothing else to offer. A model an operator typed into
 * `providers.<id>.models` is not a guess — it is a statement of intent.
 */
function configuredModels(deps: RouteDeps): ModelsResponse {
  const seen = new Set<string>();
  const models: ModelInfo[] = [];

  const add = (providerId: string, id: string, providerType?: string): void => {
    const key = `${providerId} ${id}`;
    if (id === '' || seen.has(key)) return;
    seen.add(key);
    models.push({ id, providerId, ...(providerType === undefined ? {} : { providerType }) });
  };

  for (const instance of listInstances(deps.runtime.config().providers)) {
    for (const model of instance.config.models) add(instance.id, model, instance.spec.id);
  }

  const agent = deps.runtime.agent();
  if (agent.configured) add(agent.provider, agent.model);

  models.sort((a, b) => a.providerId.localeCompare(b.providerId) || a.id.localeCompare(b.id));
  // Empty rather than one entry per provider saying "not fetched": `errors` is
  // for a list that was attempted and failed, and a client that renders it would
  // otherwise show a wall of failures for something nobody asked for.
  return { models, errors: {} };
}

/**
 * The live catalogue merged over the configured one.
 *
 * The union rather than either alone. A fetch that succeeded is the better
 * answer and is listed first by the sort; a fetch that failed leaves whatever
 * the operator typed, so the picker does not empty itself the moment a laptop
 * closes. `errors` names the instances that could not be reached, which is what
 * lets the panel say *why* a list looks short.
 */
async function listModels(deps: RouteDeps, refresh: boolean): Promise<ModelsResponse> {
  const fetched = await deps.runtime.models?.({ refresh });
  if (fetched === undefined) return configuredModels(deps);

  const configured = configuredModels(deps);
  const seen = new Set(fetched.models.map((model) => `${model.providerId} ${model.id}`));
  const models = [
    ...fetched.models,
    ...configured.models.filter((model) => !seen.has(`${model.providerId} ${model.id}`)),
  ];
  models.sort((a, b) => a.providerId.localeCompare(b.providerId) || a.id.localeCompare(b.id));
  return { models, errors: fetched.errors };
}

export function providerRoutes(deps: RouteDeps): RouteGroup<ProviderRouteId> {
  return {
    'providers.list': {
      summary: 'The provider catalogue, and every endpoint configured from it',
      schema: { response: { 200: ProvidersResponseSchema } },
      handler: (): ProvidersResponse => {
        const present = deps.runtime.credentialsPresent();
        return {
          types: PROVIDERS.map((spec) => describeProvider(spec)),
          instances: listInstances(deps.runtime.config().providers).map((instance) =>
            describeInstance(instance, present[instance.id] ?? false),
          ),
        };
      },
    },

    // Degrades rather than 501s when the runtime cannot probe, for the same
    // reason `models.list` falls back to the configured catalogue: `ok: false`
    // with a reason *is* the answer to "can this be reached", and a client that
    // had to branch on the transport to find out would render an error where
    // there is only an absence.
    'providers.test': {
      summary: 'Ask one provider connection whether it answers, and with what',
      schema: {
        body: ProviderTestRequestSchema,
        response: { 200: ProviderTestResponseSchema },
      },
      handler: async (request): Promise<ProviderTestResponse> => {
        // Called through the runtime rather than off a detached reference, so
        // an implementation that reaches for its own state still has it.
        if (deps.runtime.testProvider === undefined) {
          return {
            ok: false,
            models: [],
            reason: 'unsupported',
            message: 'This server cannot test provider connections.',
          };
        }
        return await deps.runtime.testProvider(request.body as ProviderTestRequest);
      },
    },

    'models.list': {
      summary: 'Models available to the configured provider instances',
      schema: { response: { 200: ModelsResponseSchema } },
      handler: async (): Promise<ModelsResponse> => await listModels(deps, false),
    },

    // A POST because it has an effect: it discards the cached catalogue and
    // reaches every configured endpoint again. The GET is what a page load
    // uses, and it must not turn a render loop into a flood of requests at
    // somebody's local model server.
    'models.refresh': {
      summary: 'Re-fetch every provider instance model list, ignoring the cache',
      schema: { response: { 200: ModelsResponseSchema } },
      handler: async (): Promise<ModelsResponse> => await listModels(deps, true),
    },
  };
}
