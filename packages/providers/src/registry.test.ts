import { describe, expect, it } from 'vitest';

import {
  PROVIDERS,
  PROVIDER_IDS,
  WIRE_PROTOCOLS,
  describeProvider,
  findGateway,
  findProvider,
  findProviderByModel,
  isProviderId,
  modelOverrideFor,
  resolveModelId,
  resolveProvider,
  type ProviderSpec,
} from './registry.js';

describe('the table', () => {
  it('has unique ids and no empty display names', () => {
    const ids = PROVIDERS.map((spec) => spec.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(PROVIDERS.every((spec) => spec.displayName !== '')).toBe(true);
  });

  it('names only wires that exist', () => {
    for (const spec of PROVIDERS) expect(WIRE_PROTOCOLS).toContain(spec.wire);
  });

  it('gives every non-local provider a way to be reached', () => {
    // A cloud provider with no default base URL and no way to detect it is an
    // entry nothing can select — the failure mode this assertion exists for.
    for (const spec of PROVIDERS) {
      if (spec.isLocal === true || spec.id === 'custom') continue;
      expect(spec.defaultApiBase, spec.id).toBeTruthy();
    }
  });

  it('lists gateways before the direct providers they front', () => {
    const gateway = PROVIDERS.findIndex((spec) => spec.isGateway === true);
    const direct = PROVIDERS.findIndex((spec) => spec.isGateway !== true && spec.isLocal !== true);
    expect(gateway).toBeLessThan(direct);
  });

  it('derives PROVIDER_IDS from the table itself', () => {
    expect(PROVIDER_IDS).toEqual(PROVIDERS.map((spec) => spec.id));
    expect(isProviderId('ollama')).toBe(true);
    expect(isProviderId('not-a-provider')).toBe(false);
  });
});

describe('findProviderByModel', () => {
  it('honours an explicit provider prefix over any keyword', () => {
    // "gpt" is OpenAI's keyword and appears in the model name, but the prefix
    // is an assertion by whoever wrote it and outranks the guess.
    expect(findProviderByModel('deepseek/gpt-style-model')?.id).toBe('deepseek');
  });

  it('matches on a keyword when there is no prefix', () => {
    expect(findProviderByModel('gpt-4o')?.id).toBe('openai');
    expect(findProviderByModel('claude-sonnet-4')?.id).toBe('anthropic');
    expect(findProviderByModel('gemini-2.0-flash')?.id).toBe('gemini');
    expect(findProviderByModel('grok-2')?.id).toBe('xai');
  });

  it('treats hyphen and underscore as the same character', () => {
    expect(findProviderByModel('DeepSeek_R1')?.id).toBe('deepseek');
  });

  it('never returns a gateway or a local server', () => {
    // Both would match everything and nothing respectively; they are selected
    // by API key or base URL instead.
    expect(findProviderByModel('openrouter/whatever')).toBeNull();
    expect(findProviderByModel('ollama')).toBeNull();
  });

  it('returns null for a model it cannot place', () => {
    expect(findProviderByModel('some-unknown-model')).toBeNull();
  });
});

describe('findGateway', () => {
  it('recognises a gateway by key prefix', () => {
    expect(findGateway({ apiKey: 'sk-or-v1-abc' })?.id).toBe('openrouter');
    expect(findGateway({ apiKey: 'gsk_abc' })?.id).toBe('groq');
  });

  it('recognises a local server by its port in the base URL', () => {
    expect(findGateway({ apiBase: 'http://127.0.0.1:11434/v1' })?.id).toBe('ollama');
  });

  it('accepts a named gateway directly', () => {
    expect(findGateway({ providerId: 'vllm' })?.id).toBe('vllm');
  });

  it('ignores a named provider that is not a gateway or local', () => {
    expect(findGateway({ providerId: 'openai' })).toBeNull();
  });

  it('does not mistake a direct provider behind a proxy for a local server', () => {
    // The failure this replaces: an unrecognised base URL treated as vLLM, so a
    // DeepSeek key gets sent to whatever the proxy is.
    expect(findGateway({ apiBase: 'https://proxy.corp.example/deepseek/v1' })).toBeNull();
  });
});

describe('resolveProvider', () => {
  it('prefers an explicit id', () => {
    expect(resolveProvider({ provider: 'groq', model: 'claude-sonnet-4' })?.id).toBe('groq');
  });

  it('falls through "auto" to detection', () => {
    expect(resolveProvider({ provider: 'auto', apiKey: 'sk-or-x' })?.id).toBe('openrouter');
    expect(resolveProvider({ provider: 'auto', model: 'gpt-4o' })?.id).toBe('openai');
  });

  it('falls through an unknown id rather than failing outright', () => {
    expect(resolveProvider({ provider: 'typo', model: 'claude-3' })?.id).toBe('anthropic');
  });

  it('prefers gateway detection over the model name', () => {
    // The key says OpenRouter; the model says Anthropic. The key is the thing
    // the request will actually be authenticated with.
    expect(resolveProvider({ apiKey: 'sk-or-x', model: 'claude-sonnet-4' })?.id).toBe('openrouter');
  });

  it('returns null when nothing identifies a provider', () => {
    expect(resolveProvider({})).toBeNull();
    expect(resolveProvider({ provider: '', model: '' })).toBeNull();
  });
});

describe('resolveModelId', () => {
  const spec = (overrides: Partial<ProviderSpec>): ProviderSpec => ({
    id: 'openai',
    displayName: 'OpenAI',
    wire: 'openai-chat',
    keywords: [],
    ...overrides,
  });

  it('removes a prefix naming this provider', () => {
    expect(resolveModelId(spec({}), 'openai/gpt-4o')).toBe('gpt-4o');
  });

  it('keeps a prefix naming someone else', () => {
    expect(resolveModelId(spec({ id: 'openrouter' }), 'anthropic/claude-sonnet-4')).toBe(
      'anthropic/claude-sonnet-4',
    );
  });

  it('reduces to the bare id for a gateway that demands one', () => {
    expect(
      resolveModelId(spec({ id: 'gw', stripModelPrefix: true }), 'openrouter/anthropic/claude'),
    ).toBe('claude');
  });

  it('leaves everything alone when the prefix is part of the name', () => {
    expect(resolveModelId(spec({ id: 'nv', preserveModelPrefix: true }), 'nv/model')).toBe(
      'nv/model',
    );
  });

  it('leaves an unprefixed model and a leading slash alone', () => {
    expect(resolveModelId(spec({}), 'gpt-4o')).toBe('gpt-4o');
    expect(resolveModelId(spec({}), '/weird')).toBe('/weird');
  });
});

describe('modelOverrideFor', () => {
  const spec: ProviderSpec = {
    id: 'moonshot',
    displayName: 'Moonshot',
    wire: 'openai-chat',
    keywords: [],
    modelOverrides: [{ match: 'kimi-k2', temperature: 1 }],
  };

  it('matches case-insensitively on a substring of the model id', () => {
    expect(modelOverrideFor(spec, 'Kimi-K2-Instruct')?.temperature).toBe(1);
    expect(modelOverrideFor(spec, 'kimi-k1')).toBeNull();
  });

  it('returns null when the table declares none', () => {
    expect(
      modelOverrideFor({ id: 'x', displayName: 'X', wire: 'openai-chat', keywords: [] }, 'm'),
    ).toBeNull();
  });
});

describe('describeProvider', () => {
  it('projects a table entry onto the settings DTO', () => {
    const spec = findProvider('ollama');
    expect(spec).not.toBeNull();
    expect(describeProvider(spec!)).toEqual({
      id: 'ollama',
      displayName: 'Ollama',
      wire: 'openai-chat',
      isLocal: true,
      isGateway: false,
      isOAuth: false,
      defaultApiBase: 'http://127.0.0.1:11434/v1',
      envKey: undefined,
      supportsModelListing: true,
    });
  });

  it('reports every provider without throwing', () => {
    expect(PROVIDERS.map((spec) => describeProvider(spec))).toHaveLength(PROVIDERS.length);
  });
});
