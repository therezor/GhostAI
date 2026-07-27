/**
 * The provider registry — one table, and the resolution order over it.
 *
 * Every provider is metadata. Only the *wire protocol* needs code, and one
 * adapter (`openai-chat`) covers Ollama, LM Studio, llama.cpp, vLLM, OpenAI,
 * OpenRouter, DeepSeek, Groq, xAI and Gemini's compatibility endpoint. So
 * adding a provider is a table entry, not a class.
 *
 * The table is declared `as const`, which is what makes that claim structural
 * rather than aspirational: `ProviderId` is derived from it, so the settings
 * tree's `Record<string, ProviderConfig>` narrows to the ids that actually exist
 * (see `TypedProvidersConfig`). A configuration schema that hand-lists one field
 * per provider is kept in sync by discipline; deriving it makes drift a type
 * error instead.
 *
 * Order matters. The table is scanned in declaration order by `findGateway`, so
 * gateways come first: a key beginning `sk-or-` is OpenRouter's whoever else
 * might accept it, and detection must reach that entry before a generic one.
 */

import type { ProviderConfig, ProviderInfo } from '@ghostai/protocol';

/**
 * The request/response shape a provider speaks.
 *
 * Only `openai-chat` is implemented here. The other three are declared now
 * because the table is the single source of truth for what a provider *is*, and
 * an entry that lies about its wire is worse than an entry that names a wire
 * whose adapter has not landed — the factory refuses the latter loudly.
 */
export const WIRE_PROTOCOLS = [
  'openai-chat',
  'anthropic-messages',
  'gemini-generate',
  'openai-responses',
] as const;

export type WireProtocol = (typeof WIRE_PROTOCOLS)[number];

/** A parameter override applied to models whose id contains `match`. */
export interface ModelOverride {
  readonly match: string;
  readonly temperature?: number;
  readonly maxTokens?: number;
}

export interface ProviderSpec {
  readonly id: string;
  readonly displayName: string;
  readonly wire: WireProtocol;
  /**
   * Substrings that identify this provider from a bare model name, so
   * `claude-sonnet-4` resolves without the operator naming a provider. Matched
   * case-insensitively with `-` and `_` treated as the same character.
   */
  readonly keywords: readonly string[];
  /** Environment variable consulted when the vault holds no key. */
  readonly envKey?: string;
  /** Used when config supplies no `apiBase`. Empty means one is required. */
  readonly defaultApiBase?: string;
  /** Reachable without credentials, on this machine or the LAN. */
  readonly isLocal?: boolean;
  /** Fronts many upstream models, so it is matched by key/base, not by model. */
  readonly isGateway?: boolean;
  /** Credentials arrive from an OAuth flow rather than an API key. */
  readonly isOAuth?: boolean;
  /** An API key prefix that identifies this provider unambiguously. */
  readonly detectByKeyPrefix?: string;
  /** A substring of `apiBase` that identifies this provider. */
  readonly detectByBaseKeyword?: string;
  /** The endpoint wants bare model ids: `openai/gpt-4o` is sent as `gpt-4o`. */
  readonly stripModelPrefix?: boolean;
  /** The prefix is part of the model id and must survive: `nvidia/foo`. */
  readonly preserveModelPrefix?: boolean;
  /** Newer OpenAI models reject `max_tokens` and require the longer name. */
  readonly maxTokensParam?: 'max_tokens' | 'max_completion_tokens';
  /** Headers every request carries — gateway attribution, API versions. */
  readonly defaultHeaders?: Readonly<Record<string, string>>;
  readonly modelOverrides?: readonly ModelOverride[];
  readonly supportsPromptCaching?: boolean;
}

/**
 * Gateways and local servers first, then direct providers.
 *
 * Every field beyond the required four is optional and omitted when false, so a
 * new entry is as small as it deserves to be.
 *
 * `as const` alone, not `as const satisfies readonly ProviderSpec[]`: the
 * `satisfies` form is what one would reach for, and `isolatedDeclarations`
 * cannot emit a declaration for it (TS9010). `PROVIDERS` below restores the
 * check, and is the view everything else reads.
 */
const PROVIDER_TABLE = [
  {
    id: 'openrouter',
    displayName: 'OpenRouter',
    wire: 'openai-chat',
    keywords: ['openrouter'],
    envKey: 'OPENROUTER_API_KEY',
    defaultApiBase: 'https://openrouter.ai/api/v1',
    isGateway: true,
    detectByKeyPrefix: 'sk-or-',
    detectByBaseKeyword: 'openrouter',
    // OpenRouter ranks callers by attribution header; it is not authentication.
    defaultHeaders: { 'X-Title': 'GhostAI' },
    supportsPromptCaching: true,
  },
  {
    id: 'ollama',
    displayName: 'Ollama',
    wire: 'openai-chat',
    keywords: ['ollama'],
    defaultApiBase: 'http://127.0.0.1:11434/v1',
    isLocal: true,
    detectByBaseKeyword: '11434',
  },
  {
    id: 'lmstudio',
    displayName: 'LM Studio',
    wire: 'openai-chat',
    keywords: ['lmstudio', 'lm-studio'],
    defaultApiBase: 'http://127.0.0.1:1234/v1',
    isLocal: true,
    detectByBaseKeyword: '1234',
  },
  {
    id: 'llamacpp',
    displayName: 'llama.cpp',
    wire: 'openai-chat',
    keywords: ['llamacpp', 'llama-cpp'],
    defaultApiBase: 'http://127.0.0.1:8080/v1',
    isLocal: true,
  },
  {
    id: 'vllm',
    displayName: 'vLLM',
    wire: 'openai-chat',
    keywords: ['vllm'],
    envKey: 'VLLM_API_KEY',
    defaultApiBase: 'http://127.0.0.1:8000/v1',
    isLocal: true,
  },
  {
    id: 'openai',
    displayName: 'OpenAI',
    wire: 'openai-chat',
    keywords: ['gpt', 'o1', 'o3', 'o4'],
    envKey: 'OPENAI_API_KEY',
    defaultApiBase: 'https://api.openai.com/v1',
    // `max_tokens` is rejected outright by the reasoning models rather than
    // being ignored, and the replacement is accepted by the rest of the range.
    maxTokensParam: 'max_completion_tokens',
    supportsPromptCaching: true,
  },
  {
    id: 'anthropic',
    displayName: 'Anthropic',
    // No OpenAI-compatible endpoint worth depending on; the native wire lands
    // with the rest of the provider breadth. `createProvider` says so plainly
    // rather than letting a misconfiguration surface as a 404 mid-turn.
    wire: 'anthropic-messages',
    keywords: ['claude', 'anthropic'],
    envKey: 'ANTHROPIC_API_KEY',
    defaultApiBase: 'https://api.anthropic.com/v1',
    supportsPromptCaching: true,
  },
  {
    id: 'gemini',
    displayName: 'Google Gemini',
    // Google's OpenAI compatibility layer. The native `gemini-generate` wire is
    // only needed for the features it does not expose.
    wire: 'openai-chat',
    keywords: ['gemini'],
    envKey: 'GEMINI_API_KEY',
    defaultApiBase: 'https://generativelanguage.googleapis.com/v1beta/openai',
  },
  {
    id: 'deepseek',
    displayName: 'DeepSeek',
    wire: 'openai-chat',
    keywords: ['deepseek'],
    envKey: 'DEEPSEEK_API_KEY',
    defaultApiBase: 'https://api.deepseek.com/v1',
    supportsPromptCaching: true,
  },
  {
    id: 'groq',
    displayName: 'Groq',
    wire: 'openai-chat',
    keywords: ['groq'],
    envKey: 'GROQ_API_KEY',
    defaultApiBase: 'https://api.groq.com/openai/v1',
    detectByKeyPrefix: 'gsk_',
  },
  {
    id: 'xai',
    displayName: 'xAI',
    wire: 'openai-chat',
    keywords: ['grok', 'xai'],
    envKey: 'XAI_API_KEY',
    defaultApiBase: 'https://api.x.ai/v1',
  },
  {
    id: 'custom',
    displayName: 'Custom',
    // The escape hatch: any OpenAI-compatible endpoint. No keywords and no
    // detection, so it is only ever selected by being named.
    wire: 'openai-chat',
    keywords: [],
    envKey: 'OPENAI_API_KEY',
  },
] as const;

/**
 * Every id in the table, as a union of literals.
 *
 * This is the payoff of the const table: downstream types name providers
 * without restating them, and deleting a table entry breaks every reference to
 * it at compile time.
 */
export type ProviderId = (typeof PROVIDER_TABLE)[number]['id'];

/**
 * The table, seen as the interface it implements.
 *
 * Two views of one array, and both are load-bearing. The const view above keeps
 * each entry's literal types, which is where `ProviderId` comes from; this view
 * has the *declared* type, so `spec.isGateway` is a property that exists on
 * every entry rather than only on the ones that set it.
 *
 * The assignment is also the conformance check `satisfies` would have provided:
 * an entry with a misspelled field, or a `wire` that is not a wire, fails here
 * and names itself.
 */
export const PROVIDERS: readonly ProviderSpec[] = PROVIDER_TABLE;

export const PROVIDER_IDS: readonly ProviderId[] = PROVIDER_TABLE.map((spec) => spec.id);

/**
 * The settings tree's `providers` block, narrowed to real ids.
 *
 * `@ghostai/protocol` types it as `Record<string, ProviderConfig>` because it
 * sits upstream of this table and cannot see it. Partial rather than total: an
 * unconfigured provider is the normal case, and requiring an entry per id would
 * make `{}` invalid.
 */
export type TypedProvidersConfig = Partial<Record<ProviderId, ProviderConfig>>;

export function isProviderId(value: string): value is ProviderId {
  return PROVIDERS.some((spec) => spec.id === value);
}

export function findProvider(id: string): ProviderSpec | null {
  return PROVIDERS.find((spec) => spec.id === id) ?? null;
}

/** `-` and `_` are interchangeable in every provider and model id in the wild. */
function normalise(value: string): string {
  return value.toLowerCase().replaceAll('-', '_');
}

/**
 * The provider a bare model name implies.
 *
 * Two passes, and the order is the point. An explicit `provider/model` prefix is
 * an assertion by whoever wrote the config and wins outright; keyword matching
 * is a guess and only runs when there is no assertion to honour.
 *
 * Gateways and local servers are skipped entirely. A gateway serves models from
 * everyone — `openrouter` would match nothing by keyword and match everything by
 * accident — so it is identified by key or base URL instead.
 */
export function findProviderByModel(model: string): ProviderSpec | null {
  const direct = PROVIDERS.filter((spec) => spec.isGateway !== true && spec.isLocal !== true);
  const normalised = normalise(model);
  const slash = normalised.indexOf('/');

  if (slash > 0) {
    const prefix = normalised.slice(0, slash);
    const named = direct.find((spec) => normalise(spec.id) === prefix);
    if (named !== undefined) return named;
  }

  return (
    direct.find((spec) =>
      spec.keywords.some((keyword) => normalised.includes(normalise(keyword))),
    ) ?? null
  );
}

export interface GatewayHints {
  readonly providerId?: string;
  readonly apiKey?: string;
  readonly apiBase?: string;
}

/**
 * The gateway or local server implied by the credentials, not the model.
 *
 * There is deliberately no fallback to "some local provider" when nothing
 * matches. Treating an unrecognised `apiBase` as vLLM is how a direct provider
 * behind a corporate proxy ends up sending its requests somewhere else entirely;
 * returning `null` lets the caller fall through to model matching, which is a
 * better guess and an honest one.
 */
export function findGateway(hints: GatewayHints): ProviderSpec | null {
  if (hints.providerId !== undefined) {
    const named = findProvider(hints.providerId);
    if (named !== null && (named.isGateway === true || named.isLocal === true)) return named;
  }

  const apiBase = hints.apiBase?.toLowerCase();
  for (const spec of PROVIDERS) {
    const prefix = spec.detectByKeyPrefix;
    if (prefix !== undefined && hints.apiKey?.startsWith(prefix) === true) return spec;
    const keyword = spec.detectByBaseKeyword;
    if (keyword !== undefined && apiBase?.includes(keyword) === true) return spec;
  }
  return null;
}

export interface ResolveProviderOptions {
  /** From config. `auto` or absent runs the full resolution order. */
  readonly provider?: string;
  readonly model?: string;
  readonly apiKey?: string;
  readonly apiBase?: string;
}

/**
 * The provider to use, in the one order the whole system agrees on.
 *
 *  1. An explicit id that exists — the operator said so.
 *  2. Gateway or local detection from the API key prefix or base URL.
 *  3. The model name.
 *
 * Returns `null` rather than guessing when none of the three answer, so the
 * caller can report "no provider configured" instead of failing at the first
 * request with a 401 from somewhere unexpected.
 */
export function resolveProvider(options: ResolveProviderOptions): ProviderSpec | null {
  const named = options.provider;
  if (named !== undefined && named !== '' && named !== 'auto') {
    const spec = findProvider(named);
    if (spec !== null) return spec;
  }

  const hints: GatewayHints = {
    ...(named === undefined ? {} : { providerId: named }),
    ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
    ...(options.apiBase === undefined ? {} : { apiBase: options.apiBase }),
  };
  const gateway = findGateway(hints);
  if (gateway !== null) return gateway;

  return options.model === undefined || options.model === ''
    ? null
    : findProviderByModel(options.model);
}

/**
 * The model id as this provider wants to receive it.
 *
 * The stored model keeps its `provider/model` prefix so a session records which
 * provider produced it, but most endpoints reject a prefix they did not issue.
 * Three rules, in order:
 *
 *  - `preserveModelPrefix` — the prefix is part of the name upstream. Untouched.
 *  - `stripModelPrefix` — a gateway that wants bare ids. Everything before the
 *    last `/` goes, so `openrouter/anthropic/claude` reduces correctly.
 *  - otherwise, only a prefix naming *this* provider is removed. A gateway model
 *    like `anthropic/claude-sonnet-4` keeps its prefix, because upstream that
 *    prefix is the routing instruction.
 */
export function resolveModelId(spec: ProviderSpec, model: string): string {
  if (spec.preserveModelPrefix === true) return model;

  const slash = model.indexOf('/');
  if (slash <= 0) return model;

  if (spec.stripModelPrefix === true) return model.slice(model.lastIndexOf('/') + 1);

  return normalise(model.slice(0, slash)) === normalise(spec.id) ? model.slice(slash + 1) : model;
}

/**
 * A table entry as the settings UI sees it.
 *
 * The projection lives here rather than in the HTTP layer so that adding a
 * provider stays a one-line table entry: the route maps over `PROVIDERS` and
 * supplies only what the table cannot know — whether a credential exists, which
 * is the vault's business and is never sent back out of it.
 */
export function describeProvider(spec: ProviderSpec, credentialsPresent: boolean): ProviderInfo {
  return {
    id: spec.id,
    displayName: spec.displayName,
    wire: spec.wire,
    isLocal: spec.isLocal ?? false,
    isGateway: spec.isGateway ?? false,
    isOAuth: spec.isOAuth ?? false,
    defaultApiBase: spec.defaultApiBase,
    envKey: spec.envKey,
    credentialsPresent,
  };
}

/** The first override whose `match` appears in the model id, if any. */
export function modelOverrideFor(spec: ProviderSpec, model: string): ModelOverride | null {
  const needle = model.toLowerCase();
  return (
    spec.modelOverrides?.find((override) => needle.includes(override.match.toLowerCase())) ?? null
  );
}
