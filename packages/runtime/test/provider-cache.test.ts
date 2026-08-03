import { findProvider, type ChatProvider, type ProviderSpec } from '@ghostai/providers';
import { describe, expect, it } from 'vitest';

import { ProviderCache, providerCacheKey, type ProviderRequest } from '#src/provider-cache.js';

function spec(id: string): ProviderSpec {
  const found = findProvider(id);
  if (found === null) throw new Error(`no such provider: ${id}`);
  return found;
}

/** Counts constructions and closes instead of opening a socket. */
function counting(): { created: number; closed: string[]; create: () => ChatProvider } {
  const state = {
    created: 0,
    closed: [] as string[],
    create: (): ChatProvider => ({}) as ChatProvider,
  };
  state.create = (): ChatProvider => {
    state.created += 1;
    const id = `provider-${String(state.created)}`;
    return {
      id,
      close: async () => {
        state.closed.push(id);
      },
    } as unknown as ChatProvider;
  };
  return state;
}

function request(overrides: Partial<ProviderRequest> = {}): ProviderRequest {
  return {
    instanceId: 'openai',
    spec: spec('openai'),
    model: 'gpt-4o',
    apiBase: 'https://api.openai.com/v1',
    ...overrides,
  };
}

describe('providerCacheKey', () => {
  it('never carries the credential in the clear', () => {
    // A map key ends up in a heap dump and, sooner or later, in a debug log.
    const key = providerCacheKey(request({ apiKey: 'sk-super-secret' }));
    expect(key).not.toContain('sk-super-secret');
    expect(key).toContain('openai');
  });

  it('is stable across header ordering', () => {
    const a = providerCacheKey(request({ extraHeaders: { A: '1', B: '2' } }));
    const b = providerCacheKey(request({ extraHeaders: { B: '2', A: '1' } }));
    expect(a).toBe(b);
  });

  it('distinguishes an absent credential from an empty one', () => {
    expect(providerCacheKey(request())).not.toBe(providerCacheKey(request({ apiKey: '' })));
  });

  it('cannot be collided by moving a character between headers', () => {
    const a = providerCacheKey(request({ extraHeaders: { ab: 'c' } }));
    const b = providerCacheKey(request({ extraHeaders: { a: 'bc' } }));
    expect(a).not.toBe(b);
  });
});

describe('ProviderCache', () => {
  it('returns the same adapter when nothing about the connection changed', () => {
    const factory = counting();
    const cache = new ProviderCache({ create: factory.create });

    expect(cache.get(request())).toBe(cache.get(request()));
    expect(factory.created).toBe(1);
  });

  it.each([
    ['the model', { model: 'gpt-4o-mini' }],
    ['the base URL', { apiBase: 'http://127.0.0.1:1234/v1' }],
    ['the provider', { spec: spec('groq') }],
    ['a header', { extraHeaders: { 'X-Title': 'ghost' } }],
  ])('builds a new adapter when %s changes', (_label, overrides) => {
    const factory = counting();
    const cache = new ProviderCache({ create: factory.create });

    cache.get(request());
    cache.get(request(overrides));

    expect(factory.created).toBe(2);
  });

  it('builds a new adapter when the credential changes', () => {
    // The settings-save case: a key typed into the UI has to be usable on the
    // next turn, and a cache keyed on the connection alone would hand back the
    // adapter still carrying the old one.
    const factory = counting();
    const cache = new ProviderCache({ create: factory.create });

    cache.get(request({ apiKey: 'sk-old' }));
    cache.get(request({ apiKey: 'sk-new' }));

    expect(factory.created).toBe(2);
  });

  it('evicts the least recently used past its bound', () => {
    const factory = counting();
    const cache = new ProviderCache({ max: 2, create: factory.create });

    const first = cache.get(request({ model: 'a' }));
    cache.get(request({ model: 'b' }));
    // Touching `a` makes `b` the least recently used.
    cache.get(request({ model: 'a' }));
    cache.get(request({ model: 'c' }));

    expect(cache.size).toBe(2);
    expect(cache.get(request({ model: 'a' }))).toBe(first);
    expect(factory.created).toBe(3);

    cache.get(request({ model: 'b' }));
    expect(factory.created).toBe(4);
  });

  it('closes what it evicts, and everything on clear', async () => {
    // Dropping the reference alone leaves the keep-alive sockets open with
    // nothing left holding a handle to close them.
    const factory = counting();
    const cache = new ProviderCache({ max: 1, create: factory.create });

    cache.get(request({ model: 'a' }));
    cache.get(request({ model: 'b' }));
    await Promise.resolve();
    expect(factory.closed).toEqual(['provider-1']);

    cache.clear();
    await Promise.resolve();
    expect(factory.closed).toEqual(['provider-1', 'provider-2']);
  });

  it('survives an adapter whose pool refuses to drain', () => {
    const cache = new ProviderCache({
      max: 1,
      create: () => ({ close: () => Promise.reject(new Error('stuck')) }) as ChatProvider,
    });

    cache.get(request({ model: 'a' }));
    expect(() => {
      cache.get(request({ model: 'b' }));
    }).not.toThrow();
  });

  it('does not cache a construction that failed', () => {
    // `createProvider` throws on a wire with no adapter; caching that would
    // turn one config error into a permanent one.
    let attempts = 0;
    const cache = new ProviderCache({
      create: () => {
        attempts += 1;
        if (attempts === 1) throw new Error('no adapter');
        return {} as ChatProvider;
      },
    });

    expect(() => cache.get(request())).toThrow(/no adapter/);
    expect(cache.size).toBe(0);
    expect(() => cache.get(request())).not.toThrow();
  });

  it('builds a real provider through the default factory', () => {
    // The one case that exercises `createProvider` itself, so the default path
    // is not left to the runtime tests alone.
    const cache = new ProviderCache();
    const provider = cache.get(
      request({ spec: spec('ollama'), apiBase: 'http://127.0.0.1:11434/v1' }),
    );

    expect(provider.id).toBe('ollama');
    cache.clear();
    expect(cache.size).toBe(0);
  });
});
