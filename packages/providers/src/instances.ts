/**
 * Configured endpoints, as distinct from the providers they speak to.
 *
 * `registry.ts` describes *types* — what Ollama is, which wire OpenAI speaks,
 * which environment variable holds a key. This module describes what an
 * operator actually configured: a list of instances, each naming a type. The
 * split is the whole point. Two Ollama servers are two instances of one type,
 * and the settings UI needs both lists at once — the catalogue to add from, and
 * the configured endpoints to edit.
 *
 * Nothing here narrows `ProvidersConfig` to a known-ids record. It used to
 * (`TypedProvidersConfig`), and that type was the statement that a provider
 * could be configured at most once. An instance id is an operator's label; the
 * registry has no opinion about it.
 */

import type {
  ProviderConfig,
  ProviderInstanceInfo,
  ProvidersConfig,
} from '@ghostai/protocol';

import {
  findProvider,
  findGateway,
  findProviderByModel,
  type ProviderSpec,
} from './registry.js';

/** One configured endpoint, with its type resolved. */
export interface ProviderInstance {
  /** The config key. Also the vault key its credential is stored under. */
  readonly id: string;
  readonly spec: ProviderSpec;
  readonly config: ProviderConfig;
}

/** The name to show for an instance: its label, or the type's display name. */
export function instanceLabel(instance: ProviderInstance): string {
  const label = instance.config.label.trim();
  return label === '' ? instance.spec.displayName : label;
}

/**
 * An instance as the settings UI sees it.
 *
 * `apiBase` is the *effective* endpoint, with the type's default folded in, so
 * a panel can show which URL a turn would actually reach without opening a
 * connection to find out. `credentialsPresent` is the one thing the config
 * cannot know and the caller supplies — a boolean, never the value.
 */
export function describeInstance(
  instance: ProviderInstance,
  credentialsPresent: boolean,
): ProviderInstanceInfo {
  const spec = instance.spec;
  const configured = instance.config.apiBase?.trim() ?? '';
  return {
    id: instance.id,
    type: spec.id,
    displayName: instanceLabel(instance),
    apiBase: configured === '' ? (spec.defaultApiBase ?? '') : configured,
    isLocal: spec.isLocal ?? false,
    isGateway: spec.isGateway ?? false,
    isOAuth: spec.isOAuth ?? false,
    envKey: spec.envKey,
    enabled: instance.config.enabled,
    supportsModelListing: spec.supportsModelListing ?? false,
    credentialsPresent,
  };
}

/**
 * Every entry whose `type` names a real provider, in config order.
 *
 * Insertion order is load-bearing rather than incidental: it is the order the
 * settings panel lists instances in, and the tie-break `resolveInstance` uses
 * when two instances are equally good candidates. `JSON.parse` preserves it for
 * string keys, so what an operator sees in their file is what resolution walks.
 *
 * An entry naming an unknown type is skipped rather than throwing. It is a
 * typo in one instance, and refusing to list the other nine — or refusing to
 * boot — would make a single bad character take the whole install down.
 */
export function listInstances(
  providers: ProvidersConfig,
): readonly ProviderInstance[] {
  const instances: ProviderInstance[] = [];
  for (const [id, config] of Object.entries(providers)) {
    const spec = findProvider(config.type);
    if (spec !== null) instances.push({ id, spec, config });
  }
  return instances;
}

export function findInstance(
  providers: ProvidersConfig,
  id: string,
): ProviderInstance | null {
  const config = providers[id];
  if (config === undefined) return null;
  const spec = findProvider(config.type);
  return spec === null ? null : { id, spec, config };
}

/**
 * An instance for a type that has none configured.
 *
 * `ghost chat --provider ollama` has to work on a machine with no config file,
 * and it did before instances existed. Rather than special-casing that path
 * everywhere downstream, resolution synthesises the instance the old code was
 * effectively using: id = the type, so even its vault lookup lands where a
 * pre-instance install stored its key.
 */
function syntheticInstance(spec: ProviderSpec): ProviderInstance {
  return {
    id: spec.id,
    spec,
    config: {
      type: spec.id,
      label: '',
      extraHeaders: {},
      models: [],
      enabled: true,
    },
  };
}

/** A `-2`, `-3`, … suffix is added only when the bare type is taken. */
export function nextInstanceId(type: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  if (!used.has(type)) return type;
  for (let n = 2; ; n += 1) {
    const candidate = `${type}-${String(n)}`;
    if (!used.has(candidate)) return candidate;
  }
}

interface ResolveInstanceOptions {
  readonly providers: ProvidersConfig;
  /** An instance id, a bare provider type, or `auto`. */
  readonly provider?: string | undefined;
  readonly model?: string | undefined;
  /** Consulted only to break a tie under `auto`; never to reject an instance. */
  readonly hasCredential?: ((instanceId: string) => boolean) | undefined;
}

/**
 * The instance to use, in the one order the whole system agrees on.
 *
 *  1. An instance id that exists — the operator named this endpoint.
 *  2. A provider type: its first enabled instance, or a synthetic one.
 *  3. `auto`: the model's implied type, then a gateway identified by its base
 *     URL, then the first instance holding a credential, then the first.
 *
 * Returns `null` rather than guessing when none of those answer, so the caller
 * reports "not configured" instead of sending a request to an endpoint nobody
 * chose. That is `resolveProvider`'s rule, kept.
 *
 * Disabled instances are invisible to every step, including an explicit id: a
 * switch that still resolved would not be a switch.
 */
export function resolveInstance(
  options: ResolveInstanceOptions,
): ProviderInstance | null {
  const enabled = listInstances(options.providers).filter(
    (instance) => instance.config.enabled,
  );
  const named = options.provider;

  if (named !== undefined && named !== '' && named !== 'auto') {
    const exact = enabled.find((instance) => instance.id === named);
    if (exact !== undefined) return exact;

    const spec = findProvider(named);
    if (spec !== null) {
      return (
        enabled.find((instance) => instance.spec.id === spec.id) ??
        syntheticInstance(spec)
      );
    }
    // A name that is neither an instance nor a type is a typo, and falling
    // through to `auto` would silently answer with some other endpoint.
    return null;
  }

  if (enabled.length === 0) return null;

  const byModel =
    options.model === undefined ? null : findProviderByModel(options.model);
  if (byModel !== null) {
    const match = enabled.find((instance) => instance.spec.id === byModel.id);
    if (match !== undefined) return match;
  }

  const gateway = enabled.find((instance) => {
    const apiBase = instance.config.apiBase;
    if (apiBase === undefined || apiBase === '') return false;
    return (
      findGateway({ providerId: instance.spec.id, apiBase })?.id ===
      instance.spec.id
    );
  });
  if (gateway !== undefined) return gateway;

  const credentialed =
    options.hasCredential === undefined
      ? undefined
      : enabled.find(
          (instance) => options.hasCredential?.(instance.id) === true,
        );

  return credentialed ?? enabled[0] ?? null;
}
