import { describe, expect, it, vi } from 'vitest';

import { isGhostError, userMessage } from '@ghostai/core';

import { createProvider, resolveConnection } from '#src/factory.js';
import { findProvider, type ProviderSpec } from '#src/registry.js';
import type { ChatProvider, WireAdapterOptions } from '#src/types.js';
import { recordingClock } from '#testkit/clock.js';
import {
  completion,
  errorResponse,
  mockTransport,
} from '#testkit/transport.js';

const caught = (fn: () => unknown): unknown => {
  try {
    fn();
    return null;
  } catch (error) {
    return error;
  }
};

describe('createProvider', () => {
  const base = { model: 'test-model', messages: [userMessage('hi')] };

  it('builds a provider from a table id', () => {
    const provider = createProvider({
      provider: 'ollama',
      fetchImpl: mockTransport().fetchImpl,
    });
    expect(provider.id).toBe('ollama');
    expect(provider.spec.wire).toBe('openai-chat');
  });

  it('accepts a spec directly, for a provider an extension supplied', () => {
    const spec: ProviderSpec = {
      id: 'extension-provider',
      displayName: 'From an extension',
      wire: 'openai-chat',
      keywords: [],
      defaultApiBase: 'https://example.invalid/v1',
    };
    expect(
      createProvider({ provider: spec, fetchImpl: mockTransport().fetchImpl })
        .id,
    ).toBe('extension-provider');
  });

  it('names the unknown provider rather than failing later', () => {
    const error = caught(() => createProvider({ provider: 'nope' }));
    expect(isGhostError(error) && error.kind).toBe('config');
    expect((error as Error).message).toMatch(/nope/);
  });

  it('refuses a wire that has no adapter, loudly', () => {
    // Silently falling back to the OpenAI shape would surface as a 404 in the
    // middle of a turn, which reads as "the model is gone".
    const error = caught(() =>
      createProvider({ provider: 'anthropic', apiKey: 'k' }),
    );
    expect(isGhostError(error) && error.kind).toBe('config');
    expect((error as Error).message).toMatch(/anthropic-messages/);
    // And says what would fix it, which is the half the hard-coded refusal
    // could not: the wire is a lookup now, and something can fill it.
    expect((error as Error).message).toMatch(/extension/);
  });

  it('takes a wire adapter an extension supplied', () => {
    // The other half of the seam. An extension hands over a `ProviderSpec`
    // (data) and, for a wire this build has no adapter for, the code as well.
    const adapter = vi.fn(
      (options: WireAdapterOptions): ChatProvider =>
        ({
          id: options.spec.id,
          spec: options.spec,
        }) as ChatProvider,
    );

    const provider = createProvider({
      provider: 'anthropic',
      apiKey: 'k',
      resilience: false,
      wires: { 'anthropic-messages': adapter },
    });

    expect(provider.id).toBe('anthropic');
    expect(adapter).toHaveBeenCalledOnce();
  });

  it('will not let an extension replace a wire that ships', () => {
    // `openai-chat` is what every local provider in the registry speaks, and a
    // swap an operator has no way to notice is not a capability worth having.
    const adapter = vi.fn((): ChatProvider => ({}) as ChatProvider);

    createProvider({
      provider: 'ollama',
      fetchImpl: mockTransport().fetchImpl,
      wires: { 'openai-chat': adapter },
    });

    expect(adapter).not.toHaveBeenCalled();
  });

  it('wraps an extension’s provider in resilience like any other', () => {
    // Which is the reason the seam is here rather than "hand us a ChatProvider":
    // retry, backoff and timeout classification are inherited rather than
    // reimplemented by whoever writes the adapter.
    const bare = { id: 'anthropic', close: () => Promise.resolve() };
    const provider = createProvider({
      provider: 'anthropic',
      apiKey: 'k',
      wires: { 'anthropic-messages': () => bare as unknown as ChatProvider },
    });

    expect(provider).not.toBe(bare);
  });

  it('wraps with resilience by default', async () => {
    const transport = mockTransport().push(
      errorResponse(503, { message: 'overloaded' }),
      completion({ text: 'second try' }),
    );
    const provider = createProvider({
      provider: 'ollama',
      fetchImpl: transport.fetchImpl,
      resilience: { clock: recordingClock(), jitter: () => 1 },
    });

    expect((await provider.chat(base)).message.content[0]).toEqual({
      type: 'text',
      text: 'second try',
    });
    expect(transport.calls).toHaveLength(2);
  });

  it('returns the bare adapter when resilience is switched off', async () => {
    const transport = mockTransport().push(
      errorResponse(503, { message: 'overloaded' }),
    );
    const provider = createProvider({
      provider: 'ollama',
      fetchImpl: transport.fetchImpl,
      resilience: false,
    });

    await expect(provider.chat(base)).rejects.toThrow(/503/);
    expect(transport.calls).toHaveLength(1);
  });
});

describe('resolveConnection', () => {
  const ollama = findProvider('ollama')!;
  const openrouter = findProvider('openrouter')!;

  it('falls back to the table default', () => {
    expect(resolveConnection(ollama, undefined).apiBase).toBe(
      'http://127.0.0.1:11434/v1',
    );
  });

  it('treats a cleared field as unset rather than as an empty URL', () => {
    // A settings panel that saves an emptied text box must not produce a
    // provider that cannot resolve its own endpoint.
    expect(
      resolveConnection(ollama, {
        type: 'ollama',
        label: '',
        apiBase: '   ',
        extraHeaders: {},
        models: [],
        enabled: true,
      }).apiBase,
    ).toBe('http://127.0.0.1:11434/v1');
  });

  it('lets configuration override the default', () => {
    expect(
      resolveConnection(ollama, {
        type: 'ollama',
        label: '',
        apiBase: 'http://gpu.local:11434/v1',
        extraHeaders: {},
        models: [],
        enabled: true,
      }).apiBase,
    ).toBe('http://gpu.local:11434/v1');
  });

  it('layers configured headers over the table headers', () => {
    expect(
      resolveConnection(openrouter, {
        type: 'openrouter',
        label: '',
        extraHeaders: { 'x-mine': '1', 'X-Title': 'Mine' },
        models: [],
        enabled: true,
      }).extraHeaders,
    ).toEqual({ 'X-Title': 'Mine', 'x-mine': '1' });
  });
});
