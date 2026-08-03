import { MockAgent, Response } from 'undici';
import { afterAll, describe, expect, it } from 'vitest';

import {
  filePart,
  imagePart,
  isGhostError,
  systemMessage,
  textPart,
  userMessage,
} from '@ghostai/core';

import { isProviderError } from './errors.js';
import { assertUsableApiBase, createOpenAIChatProvider } from './openai-chat.js';
import { findProvider, type ProviderSpec } from './registry.js';
import { providerConformance } from './testkit/conformance.js';
import { completion, mockTransport, sseResponse, textChunk } from './testkit/transport.js';

const specOf = (id: string): ProviderSpec => {
  const spec = findProvider(id);
  if (spec === null) throw new Error(`no such provider: ${id}`);
  return spec;
};

/**
 * The claim the package makes is that one adapter serves every OpenAI-compatible
 * provider. Running the same suite against a local server, a direct cloud
 * provider whose table entry renames the token cap, and a gateway that rewrites
 * model ids is what turns that from a comment into a test.
 */
providerConformance({
  name: 'ollama',
  create: (transport) =>
    createOpenAIChatProvider({ spec: specOf('ollama'), fetchImpl: transport.fetchImpl }),
});

providerConformance({
  name: 'openai',
  model: 'gpt-4o',
  create: (transport) =>
    createOpenAIChatProvider({
      spec: specOf('openai'),
      apiKey: 'sk-test',
      fetchImpl: transport.fetchImpl,
    }),
});

providerConformance({
  name: 'openrouter',
  model: 'anthropic/claude-sonnet-4',
  create: (transport) =>
    createOpenAIChatProvider({
      spec: specOf('openrouter'),
      apiKey: 'sk-or-test',
      fetchImpl: transport.fetchImpl,
    }),
});

describe('assertUsableApiBase', () => {
  it('accepts https anywhere, with or without a key', () => {
    expect(assertUsableApiBase('https://api.openai.com/v1', true).protocol).toBe('https:');
    expect(assertUsableApiBase('https://api.openai.com/v1', false).protocol).toBe('https:');
  });

  it('accepts plain http to a local server carrying a key', () => {
    for (const base of [
      'http://127.0.0.1:11434/v1',
      'http://localhost:1234/v1',
      'http://192.168.1.5:8000/v1',
    ]) {
      expect(assertUsableApiBase(base, true).protocol).toBe('http:');
    }
  });

  it('accepts plain http to a public host when no key is attached', () => {
    expect(assertUsableApiBase('http://example.com/v1', false).hostname).toBe('example.com');
  });

  it('refuses to send a key over plain http to a public host', () => {
    expect(() => assertUsableApiBase('http://example.com/v1', true)).toThrow(/plain HTTP/);
    // Decimal-encoded 8.8.8.8 — the point of routing this through the address
    // classifier rather than a string test for "127." or "192.168.".
    expect(() => assertUsableApiBase('http://134744072/v1', true)).toThrow(/plain HTTP/);
  });

  it('rejects a non-URL and a non-http scheme', () => {
    expect(() => assertUsableApiBase('not a url', false)).toThrow(/not a URL/);
    expect(() => assertUsableApiBase('file:///etc/passwd', false)).toThrow(/http or https/);
    expect(() => assertUsableApiBase('ftp://example.com', false)).toThrow(/http or https/);
  });
});

describe('openai-chat adapter', () => {
  const base = { model: 'test-model', messages: [systemMessage('sys'), userMessage('hi')] };

  it('requires a base URL when the table has no default', () => {
    const spec: ProviderSpec = {
      id: 'custom',
      displayName: 'Custom',
      wire: 'openai-chat',
      keywords: [],
    };
    expect(() => createOpenAIChatProvider({ spec, fetchImpl: mockTransport().fetchImpl })).toThrow(
      /no apiBase/,
    );
  });

  it('sends the bearer token and the table headers', async () => {
    const transport = mockTransport().push(completion({ text: 'ok' }));
    await createOpenAIChatProvider({
      spec: specOf('openrouter'),
      apiKey: 'sk-or-secret',
      extraHeaders: { 'x-custom': 'yes' },
      fetchImpl: transport.fetchImpl,
    }).chat(base);

    expect(transport.calls[0]?.headers).toMatchObject({
      authorization: 'Bearer sk-or-secret',
      'X-Title': 'GhostAI',
      'x-custom': 'yes',
      'content-type': 'application/json',
    });
  });

  it('sends an inline image as a data URI', async () => {
    const transport = mockTransport().push(completion({ text: 'ok' }));
    await createOpenAIChatProvider({
      spec: specOf('ollama'),
      fetchImpl: transport.fetchImpl,
    }).chat({
      model: 'test-model',
      messages: [userMessage([textPart('what is this?'), imagePart('image/png', { data: 'AAA' })])],
    });

    const messages = transport.calls[0]?.body.messages as {
      content: { type: string; image_url?: { url: string } }[];
    }[];
    expect(messages[0]?.content[1]).toEqual({
      type: 'image_url',
      image_url: { url: 'data:image/png;base64,AAA' },
    });
  });

  it('renders a file part as text rather than dropping it', async () => {
    // A `file` part should have been materialised into text or an image before
    // it got here. Reaching this branch means a caller went straight to the
    // provider, and a model told the path can still reach for a tool — whereas
    // a silently missing attachment is the failure this all began as.
    const transport = mockTransport().push(completion({ text: 'ok' }));
    await createOpenAIChatProvider({
      spec: specOf('ollama'),
      fetchImpl: transport.fetchImpl,
    }).chat({
      model: 'test-model',
      messages: [
        userMessage([textPart('open this'), filePart('uploads/ab12-notes.csv', 'text/csv')]),
      ],
    });

    const messages = transport.calls[0]?.body.messages as { content: string }[];
    // Every part is text now, so the adapter collapses them to a plain string.
    expect(messages[0]?.content).toContain('uploads/ab12-notes.csv');
  });

  it('omits authorization entirely for a keyless local server', async () => {
    const transport = mockTransport().push(completion({ text: 'ok' }));
    await createOpenAIChatProvider({ spec: specOf('ollama'), fetchImpl: transport.fetchImpl }).chat(
      base,
    );
    expect(transport.calls[0]?.headers.authorization).toBeUndefined();
  });

  it('joins the path without doubling a trailing slash', async () => {
    const transport = mockTransport().push(completion({ text: 'ok' }));
    await createOpenAIChatProvider({
      spec: specOf('gemini'),
      apiBase: 'https://generativelanguage.googleapis.com/v1beta/openai/',
      apiKey: 'k',
      fetchImpl: transport.fetchImpl,
    }).chat(base);

    expect(transport.calls[0]?.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    );
  });

  it('strips a provider prefix the endpoint did not issue', async () => {
    const transport = mockTransport().push(completion({ text: 'ok' }));
    await createOpenAIChatProvider({
      spec: specOf('openai'),
      apiKey: 'k',
      fetchImpl: transport.fetchImpl,
    }).chat({
      ...base,
      model: 'openai/gpt-4o',
    });
    expect(transport.calls[0]?.body.model).toBe('gpt-4o');
  });

  it('keeps a gateway routing prefix intact', async () => {
    const transport = mockTransport().push(completion({ text: 'ok' }));
    await createOpenAIChatProvider({
      spec: specOf('openrouter'),
      apiKey: 'k',
      fetchImpl: transport.fetchImpl,
    }).chat({
      ...base,
      model: 'anthropic/claude-sonnet-4',
    });
    expect(transport.calls[0]?.body.model).toBe('anthropic/claude-sonnet-4');
  });

  it('sends tools and tool_choice only when tools are present', async () => {
    const transport = mockTransport().push(completion({ text: 'ok' }), completion({ text: 'ok' }));
    const provider = createOpenAIChatProvider({
      spec: specOf('ollama'),
      fetchImpl: transport.fetchImpl,
    });

    await provider.chat({ ...base, toolChoice: 'required' });
    expect(transport.calls[0]?.body.tools).toBeUndefined();
    expect(transport.calls[0]?.body.tool_choice).toBeUndefined();

    await provider.chat({
      ...base,
      toolChoice: 'required',
      tools: [
        {
          name: 't',
          description: 'd',
          parameters: { type: 'object' },
          risk: 'safe',
          source: 'builtin',
        },
      ],
    });
    expect(transport.calls[1]?.body.tools).toEqual([
      {
        type: 'function',
        function: { name: 't', description: 'd', parameters: { type: 'object' } },
      },
    ]);
    expect(transport.calls[1]?.body.tool_choice).toBe('required');
  });

  it('sends an effort straight through, and translates the one that is ours', async () => {
    const transport = mockTransport().push(completion({ text: 'ok' }), completion({ text: 'ok' }));
    const provider = createOpenAIChatProvider({
      spec: specOf('ollama'),
      fetchImpl: transport.fetchImpl,
    });

    await provider.chat({ ...base, reasoningEffort: 'high' });
    expect(transport.calls[0]?.body.reasoning_effort).toBe('high');

    // `off` is this project's word, not a wire value, so it may never reach the
    // body verbatim. Absent a spec saying otherwise it becomes OpenAI's `none`.
    await provider.chat({ ...base, reasoningEffort: 'off' });
    expect(transport.calls[1]?.body.reasoning_effort).toBe('none');
  });

  it('spells `off` the way the table says, where a provider disagrees', async () => {
    const transport = mockTransport().push(completion({ text: 'ok' }));
    const provider = createOpenAIChatProvider({
      spec: specOf('openrouter'),
      apiKey: 'sk-or-test',
      fetchImpl: transport.fetchImpl,
    });

    await provider.chat({ ...base, reasoningEffort: 'off' });

    // OpenRouter normalises reasoning into its own object and ignores the effort
    // string, so sending `reasoning_effort` as well would be a field it has no
    // use for — which is the thing `reasoningOffBody` exists to avoid.
    expect(transport.calls[0]?.body.reasoning).toEqual({ enabled: false });
    expect(transport.calls[0]?.body.reasoning_effort).toBeUndefined();
  });

  it('classifies a 200 with no choices as a server-side glitch', async () => {
    const transport = mockTransport().push(
      new Response(JSON.stringify({ choices: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const provider = createOpenAIChatProvider({
      spec: specOf('ollama'),
      fetchImpl: transport.fetchImpl,
    });

    await expect(provider.chat(base)).rejects.toSatisfy(
      (error: unknown) => isProviderError(error) && error.reason === 'server' && error.retryable,
    );
  });

  it('reports a transport failure as network, not as a provider rejection', async () => {
    const transport = mockTransport().push(() => {
      throw new TypeError('fetch failed');
    });
    const provider = createOpenAIChatProvider({
      spec: specOf('ollama'),
      fetchImpl: transport.fetchImpl,
    });

    await expect(provider.chat(base)).rejects.toSatisfy(
      (error: unknown) =>
        isProviderError(error) && error.reason === 'transport' && error.kind === 'network',
    );
  });

  it('surfaces an error delivered inside a 200 stream', async () => {
    const transport = mockTransport().push(
      sseResponse(
        [textChunk('par'), { error: { message: 'upstream died', code: 'server_error' } }],
        { done: false },
      ),
    );
    const provider = createOpenAIChatProvider({
      spec: specOf('ollama'),
      fetchImpl: transport.fetchImpl,
    });

    const seen: string[] = [];
    const drain = async (): Promise<void> => {
      for await (const event of provider.stream(base))
        if (event.type === 'text') seen.push(event.text);
    };

    await expect(drain()).rejects.toThrow(/upstream died/);
    expect(seen).toEqual(['par']);
  });

  it('rejects a truncated stream rather than returning a partial answer', async () => {
    // No terminating newline: the frame never completes, which is what a
    // connection dropped mid-write actually looks like.
    const transport = mockTransport().push(
      new Response('data: {"choices":[{"delta":{"content":"par', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }),
    );
    const provider = createOpenAIChatProvider({
      spec: specOf('ollama'),
      fetchImpl: transport.fetchImpl,
    });

    const drain = async (): Promise<void> => {
      for await (const _event of provider.stream(base)) void _event;
    };
    await expect(drain()).rejects.toSatisfy(
      (error: unknown) => isProviderError(error) && error.reason === 'stream_parse',
    );
  });

  it('rejects a stream with no body at all', async () => {
    const transport = mockTransport().push(new Response(null, { status: 200 }));
    const provider = createOpenAIChatProvider({
      spec: specOf('ollama'),
      fetchImpl: transport.fetchImpl,
    });
    const drain = async (): Promise<void> => {
      for await (const _event of provider.stream(base)) void _event;
    };
    await expect(drain()).rejects.toSatisfy(
      (error: unknown) => isProviderError(error) && error.reason === 'stream_parse',
    );
  });

  it('reads a non-JSON error body without losing the status', async () => {
    const transport = mockTransport().push(
      new Response('<html>502 Bad Gateway</html>', {
        status: 502,
        headers: { 'content-type': 'text/html' },
      }),
    );
    const provider = createOpenAIChatProvider({
      spec: specOf('ollama'),
      fetchImpl: transport.fetchImpl,
    });

    await expect(provider.chat(base)).rejects.toSatisfy(
      (error: unknown) =>
        isProviderError(error) && error.reason === 'server' && error.status === 502,
    );
  });

  it('generates a tool-call id when the provider omits one', async () => {
    const transport = mockTransport().push(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [{ type: 'function', function: { name: 'list_dir', arguments: '{}' } }],
              },
              finish_reason: 'tool_calls',
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const provider = createOpenAIChatProvider({
      spec: specOf('ollama'),
      fetchImpl: transport.fetchImpl,
      generateId: () => 'generated_1',
    });

    const result = await provider.chat(base);
    expect(result.message.toolCalls).toEqual([
      { id: 'generated_1', name: 'list_dir', argumentsJson: '{}' },
    ]);
  });

  it('re-serialises tool arguments a provider sent as an object', async () => {
    const transport = mockTransport().push(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                role: 'assistant',
                tool_calls: [
                  { id: 'c1', function: { name: 'read_file', arguments: { path: 'a.txt' } } },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const provider = createOpenAIChatProvider({
      spec: specOf('ollama'),
      fetchImpl: transport.fetchImpl,
    });
    const result = await provider.chat(base);
    expect(result.message.toolCalls[0]?.argumentsJson).toBe('{"path":"a.txt"}');
  });

  it('closing without ever connecting is safe', async () => {
    const provider = createOpenAIChatProvider({
      spec: specOf('ollama'),
      fetchImpl: mockTransport().fetchImpl,
    });
    await expect(provider.close()).resolves.toBeUndefined();
  });

  it('rejects a bad base URL as a configuration error, not a provider error', () => {
    let caught: unknown;
    try {
      createOpenAIChatProvider({
        spec: specOf('ollama'),
        apiBase: 'nonsense',
        fetchImpl: mockTransport().fetchImpl,
      });
    } catch (error) {
      caught = error;
    }
    // `config`, so the operator is told to fix a setting rather than seeing a
    // provider failure they cannot act on.
    expect(isGhostError(caught) && caught.kind).toBe('config');
    expect(isProviderError(caught)).toBe(false);
  });
});

/**
 * Everything above injects `fetchImpl`, which is deterministic but never
 * exercises the transport the process actually uses. This one drives the real
 * `undici.fetch` through a `MockAgent`, so the default path — headers, body
 * serialisation, the dispatcher hand-off — is covered without a socket.
 */
describe('the undici transport', () => {
  const agent = new MockAgent();
  agent.disableNetConnect();

  afterAll(async () => {
    await agent.close();
  });

  it('completes a turn through undici with no network access', async () => {
    agent
      .get('http://127.0.0.1:11434')
      .intercept({ path: '/v1/chat/completions', method: 'POST' })
      .reply(
        200,
        {
          model: 'qwen3',
          choices: [
            { message: { role: 'assistant', content: 'from undici' }, finish_reason: 'stop' },
          ],
          usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
        },
        { headers: { 'content-type': 'application/json' } },
      );

    const provider = createOpenAIChatProvider({ spec: specOf('ollama'), dispatcher: agent });
    const result = await provider.chat({ model: 'qwen3', messages: [userMessage('hi')] });

    expect(result.message.content).toEqual([{ type: 'text', text: 'from undici' }]);
    expect(result.usage.totalTokens).toBe(6);
    // No pooled agent was built, so `close` has nothing of its own to release.
    await provider.close();
  });

  it('streams through undici and surfaces a real 429', async () => {
    agent
      .get('http://127.0.0.1:11434')
      .intercept({ path: '/v1/chat/completions', method: 'POST' })
      .reply(
        429,
        { error: { message: 'slow down' } },
        { headers: { 'content-type': 'application/json' } },
      );

    const provider = createOpenAIChatProvider({ spec: specOf('ollama'), dispatcher: agent });
    const drain = async (): Promise<void> => {
      for await (const _event of provider.stream({ model: 'qwen3', messages: [userMessage('hi')] }))
        void _event;
    };

    await expect(drain()).rejects.toSatisfy(
      (error: unknown) =>
        isProviderError(error) && error.reason === 'rate_limit' && error.status === 429,
    );
  });
});
