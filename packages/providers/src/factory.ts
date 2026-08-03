/**
 * From configuration to a working provider.
 *
 * The one place that turns a registry entry plus connection settings into a
 * `ChatProvider`, so every caller — the agent loop, the model-list endpoint, the
 * scheduler's cheap heartbeat model — gets the same resilience behaviour without
 * remembering to ask for it.
 *
 * A wire without an adapter is a loud `config` error naming the provider, not a
 * silent fallback to the OpenAI shape. Pointing `anthropic` at
 * `/chat/completions` would produce a 404 in the middle of a turn, which reads
 * as "the model is gone" rather than "this provider is not implemented yet".
 */

import type { Dispatcher } from 'undici';

import { GhostError } from '@ghostai/core';
import type { ProviderConfig } from '@ghostai/protocol';
import type { FetchImplementation } from '@ghostai/security';

import { createOpenAIChatProvider } from './openai-chat.js';
import { findProvider, type ProviderSpec } from './registry.js';
import { withResilience, type ResilienceOptions } from './resilience.js';
import type { ChatProvider } from './types.js';

export interface CreateProviderOptions {
  /** A registry id, or a spec directly — a plugin may supply its own. */
  readonly provider: string | ProviderSpec;
  /** From the credential vault. Never read from `config.json`. */
  readonly apiKey?: string | undefined;
  readonly apiBase?: string | undefined;
  readonly extraHeaders?: Readonly<Record<string, string>> | undefined;
  readonly fetchImpl?: FetchImplementation | undefined;
  /** A `ProxyAgent`, or anything else that should replace the pooled agent. */
  readonly dispatcher?: Dispatcher | undefined;
  readonly requestTimeoutMs?: number | undefined;
  readonly streamIdleTimeoutMs?: number | undefined;
  readonly generateId?: (() => string) | undefined;
  /** `false` returns the bare adapter — for tests that assert wire behaviour. */
  readonly resilience?: ResilienceOptions | false | undefined;
}

export function createProvider(options: CreateProviderOptions): ChatProvider {
  const requested = options.provider;
  const id = typeof requested === 'string' ? requested : requested.id;
  const spec =
    typeof requested === 'string' ? findProvider(requested) : requested;
  if (spec === null) throw new GhostError('config', `Unknown provider "${id}"`);

  if (spec.wire !== 'openai-chat') {
    throw new GhostError(
      'config',
      `Provider "${spec.id}" speaks the ${spec.wire} wire, which is not implemented yet. ` +
        `Use an OpenAI-compatible provider, or an endpoint that exposes one.`,
    );
  }

  const provider = createOpenAIChatProvider({
    spec,
    apiKey: options.apiKey,
    apiBase: options.apiBase,
    extraHeaders: options.extraHeaders,
    fetchImpl: options.fetchImpl,
    dispatcher: options.dispatcher,
    requestTimeoutMs: options.requestTimeoutMs,
    streamIdleTimeoutMs: options.streamIdleTimeoutMs,
    generateId: options.generateId,
  });

  return options.resilience === false
    ? provider
    : withResilience(provider, options.resilience ?? {});
}

/**
 * The connection settings for one provider, with config layered over the table.
 *
 * Kept separate from `createProvider` because the settings UI needs to show the
 * effective values — which base URL a provider will actually use — without
 * opening a connection to find out.
 */
export function resolveConnection(
  spec: ProviderSpec,
  config: ProviderConfig | undefined,
): {
  readonly apiBase: string;
  readonly extraHeaders: Readonly<Record<string, string>>;
} {
  // An empty string in config means "unset", not "the empty base URL": a
  // cleared text field in the settings panel must fall back to the default
  // rather than producing a provider that cannot resolve its own endpoint.
  const configured = config?.apiBase?.trim();
  return {
    apiBase:
      configured === undefined || configured === ''
        ? (spec.defaultApiBase ?? '')
        : configured,
    extraHeaders: { ...spec.defaultHeaders, ...config?.extraHeaders },
  };
}
