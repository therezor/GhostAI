import { describe, expect, it } from 'vitest';

import type { ProviderConfig, ProvidersConfig } from '@ghostai/protocol';

import {
  describeInstance,
  findInstance,
  instanceLabel,
  listInstances,
  nextInstanceId,
  resolveInstance,
} from '#src/instances.js';

function instance(
  type: string,
  overrides: Partial<ProviderConfig> = {},
): ProviderConfig {
  return {
    type,
    label: '',
    extraHeaders: {},
    models: [],
    enabled: true,
    ...overrides,
  };
}

/** Two Ollama servers — the case the previous one-entry-per-provider shape could not express. */
const twoOllamas: ProvidersConfig = {
  ollama: instance('ollama', { apiBase: 'http://127.0.0.1:11434/v1' }),
  'ollama-gpu': instance('ollama', {
    label: 'GPU box',
    apiBase: 'http://gpu.lan:11434/v1',
  }),
};

describe('listInstances', () => {
  it('resolves each entry against the registry, in config order', () => {
    const listed = listInstances(twoOllamas);
    expect(listed.map((i) => i.id)).toEqual(['ollama', 'ollama-gpu']);
    expect(listed.every((i) => i.spec.id === 'ollama')).toBe(true);
  });

  it('skips an entry naming a type that does not exist, and keeps the rest', () => {
    // A typo in one instance must not take the other nine down with it.
    const listed = listInstances({
      good: instance('ollama'),
      bad: instance('ollamaa'),
    });
    expect(listed.map((i) => i.id)).toEqual(['good']);
  });
});

describe('instanceLabel', () => {
  it('prefers the label and falls back to the type display name', () => {
    const [plain, labelled] = listInstances(twoOllamas);
    expect(instanceLabel(plain!)).toBe('Ollama');
    expect(instanceLabel(labelled!)).toBe('GPU box');
  });
});

describe('findInstance', () => {
  it('returns null for an id nobody configured', () => {
    expect(findInstance(twoOllamas, 'nope')).toBeNull();
  });
});

describe('nextInstanceId', () => {
  it('uses the bare type first, then numbers upward past what is taken', () => {
    expect(nextInstanceId('ollama', [])).toBe('ollama');
    expect(nextInstanceId('ollama', ['ollama'])).toBe('ollama-2');
    expect(nextInstanceId('ollama', ['ollama', 'ollama-2', 'ollama-3'])).toBe(
      'ollama-4',
    );
  });
});

describe('describeInstance', () => {
  it('reports the effective base URL, not the configured one', () => {
    const [plain] = listInstances({ ollama: instance('ollama') });
    expect(describeInstance(plain!, false).apiBase).toBe(
      'http://127.0.0.1:11434/v1',
    );
  });

  it('carries the credential flag it is given and nothing more', () => {
    const [gpu] = listInstances({ 'ollama-gpu': twoOllamas['ollama-gpu']! });
    const described = describeInstance(gpu!, true);
    expect(described).toMatchObject({
      id: 'ollama-gpu',
      type: 'ollama',
      displayName: 'GPU box',
      apiBase: 'http://gpu.lan:11434/v1',
      credentialsPresent: true,
      supportsModelListing: true,
    });
    expect(Object.values(described)).not.toContain('secret');
  });
});

describe('resolveInstance', () => {
  it('prefers an instance named exactly', () => {
    const resolved = resolveInstance({
      providers: twoOllamas,
      provider: 'ollama-gpu',
    });
    expect(resolved?.id).toBe('ollama-gpu');
  });

  it('takes the first instance of a bare provider type', () => {
    const resolved = resolveInstance({
      providers: twoOllamas,
      provider: 'ollama',
    });
    expect(resolved?.id).toBe('ollama');
  });

  it('synthesises an instance for a type nobody configured', () => {
    // `ghost chat --provider ollama` on a machine with no config file worked
    // before instances existed and has to keep working.
    const resolved = resolveInstance({ providers: {}, provider: 'ollama' });
    expect(resolved?.id).toBe('ollama');
    expect(resolved?.config.apiBase).toBeUndefined();
  });

  it('returns null for a name that is neither an instance nor a type', () => {
    // Falling through to `auto` would answer with some other endpoint, which is
    // how a typo ends up sending a request somewhere nobody chose.
    expect(
      resolveInstance({ providers: twoOllamas, provider: 'ollamaa' }),
    ).toBeNull();
  });

  it('is blind to a disabled instance, however it is named', () => {
    const providers: ProvidersConfig = {
      off: instance('ollama', { enabled: false }),
      on: instance('lmstudio'),
    };
    // Naming it resolves to nothing rather than quietly to the other one: a
    // switch that answered anyway would not be a switch, and silently
    // substituting a different endpoint is the failure this whole order avoids.
    expect(resolveInstance({ providers, provider: 'off' })).toBeNull();
    expect(resolveInstance({ providers })?.id).toBe('on');
  });

  it('under auto, matches the instance whose type the model implies', () => {
    const providers: ProvidersConfig = {
      local: instance('ollama'),
      cloud: instance('openai'),
    };
    expect(
      resolveInstance({ providers, provider: 'auto', model: 'gpt-4o' })?.id,
    ).toBe('cloud');
  });

  it('under auto, prefers an instance holding a credential', () => {
    const providers: ProvidersConfig = {
      first: instance('ollama'),
      second: instance('lmstudio'),
    };
    const resolved = resolveInstance({
      providers,
      hasCredential: (id) => id === 'second',
    });
    expect(resolved?.id).toBe('second');
  });

  it('under auto with nothing else to go on, takes the first in config order', () => {
    expect(resolveInstance({ providers: twoOllamas })?.id).toBe('ollama');
  });

  it('returns null when nothing is configured, rather than guessing', () => {
    expect(resolveInstance({ providers: {} })).toBeNull();
  });
});
