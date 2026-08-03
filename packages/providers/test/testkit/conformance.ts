/**
 * The provider conformance suite.
 *
 * One exported suite, run against every provider that is supposed to work. That
 * is what makes "one adapter covers ten providers" a checked claim rather than
 * an assertion in a README: the same fourteen scenarios run against Ollama's
 * spec, OpenAI's and a gateway's, and a table entry that quietly needs different
 * behaviour fails here rather than in someone's session.
 *
 * It also fixes the *contract* rather than the implementation. Streaming ends
 * with exactly one `done`; a rejected parameter is dropped and retried; an abort
 * raises rather than returning a partial answer. A future adapter passes this
 * suite or it is not a provider.
 *
 * The fixtures are `openai-chat` shaped, because that is the only wire that
 * exists so far. When the second one lands, the scenarios stay and the bodies
 * move behind a per-wire fixture interface — the scenarios are the valuable part
 * and they are already wire-independent.
 */

import { describe, expect, it } from 'vitest';

import {
  assistantMessage,
  imagePart,
  systemMessage,
  textPart,
  toolMessage,
  userMessage,
} from '@ghostai/core';
import type { ChatMessage } from '@ghostai/protocol';

import { isProviderError } from '#src/errors.js';
import { withResilience } from '#src/resilience.js';
import type { ChatProvider, ChatRequest, ChatStreamEvent } from '#src/types.js';
import { recordingClock } from './clock.js';
import {
  completion,
  errorResponse,
  finishChunk,
  hangingStream,
  mockTransport,
  modelsResponse,
  reasoningChunk,
  sseResponse,
  textChunk,
  toolCallChunk,
  usageChunk,
  type MockTransport,
} from './transport.js';

export interface ProviderConformanceOptions {
  /** Names the suite — normally the provider id under test. */
  readonly name: string;
  readonly model?: string;
  /** Builds the provider under test on the scripted transport. */
  readonly create: (transport: MockTransport) => ChatProvider;
}

const HELLO: readonly ChatMessage[] = [systemMessage('You are GhostAI.'), userMessage('hello')];

/** Collects a stream, keeping the deltas and the single terminal result. */
async function collect(
  events: AsyncIterable<ChatStreamEvent>,
): Promise<{ text: string[]; reasoning: string[]; done: ChatStreamEvent | undefined }> {
  const text: string[] = [];
  const reasoning: string[] = [];
  let done: ChatStreamEvent | undefined;
  for await (const event of events) {
    if (event.type === 'text') text.push(event.text);
    else if (event.type === 'reasoning') reasoning.push(event.text);
    else done = event;
  }
  return { text, reasoning, done };
}

export function providerConformance(options: ProviderConformanceOptions): void {
  const model = options.model ?? 'test-model';
  const base: ChatRequest = { model, messages: HELLO, maxTokens: 256, temperature: 0.1 };

  /** The provider plus a deterministic clock, for the scenarios that retry. */
  const resilient = (
    transport: MockTransport,
  ): { provider: ChatProvider; clock: ReturnType<typeof recordingClock> } => {
    const clock = recordingClock();
    return {
      // `jitter: () => 1` pins full-jitter backoff to its ceiling, so a schedule
      // is a value a test can state rather than a range it has to tolerate.
      provider: withResilience(options.create(transport), { clock, jitter: () => 1 }),
      clock,
    };
  };

  describe(`provider conformance: ${options.name}`, () => {
    it('sends the model, the messages and the token cap', async () => {
      const transport = mockTransport().push(completion({ text: 'hi' }));
      await options.create(transport).chat(base);

      const call = transport.calls[0];
      expect(call?.method).toBe('POST');
      expect(call?.url).toMatch(/\/chat\/completions$/);
      const spec = options.create(mockTransport()).spec;
      expect(call?.body[spec.maxTokensParam ?? 'max_tokens']).toBe(256);
      expect(call?.body.messages).toHaveLength(2);
      expect(call?.body.stream).toBeUndefined();
    });

    it('returns text, finish reason and usage', async () => {
      const transport = mockTransport().push(
        completion({
          text: 'the answer',
          usage: { prompt_tokens: 30, completion_tokens: 5, total_tokens: 35 },
        }),
      );
      const result = await options.create(transport).chat(base);

      expect(result.message.content).toEqual([textPart('the answer')]);
      expect(result.finishReason).toBe('stop');
      expect(result.usage).toMatchObject({
        promptTokens: 30,
        completionTokens: 5,
        totalTokens: 35,
      });
    });

    it('returns parallel tool calls with their arguments verbatim', async () => {
      // The second call's arguments are deliberately not valid JSON: parsing is
      // the tool registry's job, and a transport that repairs them hides a model
      // defect the registry would have reported as a retryable tool error.
      const transport = mockTransport().push(
        completion({
          toolCalls: [
            { id: 'call_1', name: 'read_file', argumentsJson: '{"path":"a.txt"}' },
            { id: 'call_2', name: 'list_dir', argumentsJson: '{"path": ' },
          ],
        }),
      );
      const result = await options.create(transport).chat(base);

      expect(result.finishReason).toBe('tool_calls');
      expect(result.message.toolCalls).toEqual([
        { id: 'call_1', name: 'read_file', argumentsJson: '{"path":"a.txt"}' },
        { id: 'call_2', name: 'list_dir', argumentsJson: '{"path": ' },
      ]);
    });

    it('reports tool calls even when the provider labels the turn "stop"', async () => {
      const transport = mockTransport().push(
        completion({
          finishReason: 'stop',
          toolCalls: [{ id: 'call_1', name: 'list_dir', argumentsJson: '{}' }],
        }),
      );
      const result = await options.create(transport).chat(base);
      expect(result.finishReason).toBe('tool_calls');
    });

    it('streams deltas in order and ends with one assembled result', async () => {
      const transport = mockTransport().push(
        sseResponse([
          reasoningChunk('thinking'),
          textChunk('Hel'),
          textChunk('lo'),
          finishChunk('stop'),
          usageChunk({ prompt_tokens: 9, completion_tokens: 2, total_tokens: 11 }),
        ]),
      );
      const { text, reasoning, done } = await collect(options.create(transport).stream(base));

      expect(text).toEqual(['Hel', 'lo']);
      expect(reasoning).toEqual(['thinking']);
      expect(done?.type).toBe('done');
      if (done?.type !== 'done') throw new Error('no done event');
      expect(done.result.message.content).toEqual([textPart('Hello')]);
      expect(done.result.message.reasoning).toBe('thinking');
      expect(done.result.usage.totalTokens).toBe(11);
      expect(transport.calls[0]?.body.stream).toBe(true);
    });

    it('reassembles tool-call arguments split across stream frames', async () => {
      const transport = mockTransport().push(
        sseResponse([
          toolCallChunk(0, { id: 'call_a', name: 'read_file' }),
          toolCallChunk(0, { argumentsJson: '{"path":' }),
          toolCallChunk(1, { id: 'call_b', name: 'list_dir', argumentsJson: '{}' }),
          toolCallChunk(0, { argumentsJson: '"a.txt"}' }),
          finishChunk('tool_calls'),
        ]),
      );
      const { done } = await collect(options.create(transport).stream(base));
      if (done?.type !== 'done') throw new Error('no done event');

      expect(done.result.message.toolCalls).toEqual([
        { id: 'call_a', name: 'read_file', argumentsJson: '{"path":"a.txt"}' },
        { id: 'call_b', name: 'list_dir', argumentsJson: '{}' },
      ]);
      expect(done.result.finishReason).toBe('tool_calls');
    });

    it('raises on a mid-stream abort and keeps what was already delivered', async () => {
      const controller = new AbortController();
      const transport = mockTransport().push(hangingStream([textChunk('Hel')]));
      const provider = options.create(transport);
      const seen: string[] = [];

      const drain = async (): Promise<void> => {
        for await (const event of provider.stream({ ...base, signal: controller.signal })) {
          if (event.type === 'text') {
            seen.push(event.text);
            controller.abort();
          }
        }
      };

      await expect(drain()).rejects.toSatisfy(
        (error: unknown) => isProviderError(error) && error.reason === 'aborted',
      );
      expect(seen).toEqual(['Hel']);
    });

    it('retries a rate limit after the delay the provider asked for', async () => {
      const transport = mockTransport().push(
        errorResponse(
          429,
          { message: 'slow down', type: 'rate_limit_error' },
          { 'retry-after': '2' },
        ),
        completion({ text: 'second time' }),
      );
      const { provider, clock } = resilient(transport);
      const result = await provider.chat(base);

      expect(result.message.content).toEqual([textPart('second time')]);
      expect(clock.sleeps).toEqual([2000]);
      expect(transport.calls).toHaveLength(2);
    });

    it('does not retry an authentication failure', async () => {
      const transport = mockTransport().push(
        errorResponse(401, { message: 'bad key', code: 'invalid_api_key' }),
      );
      const { provider } = resilient(transport);

      await expect(provider.chat(base)).rejects.toSatisfy(
        (error: unknown) =>
          isProviderError(error) && error.reason === 'auth' && error.status === 401,
      );
      expect(transport.calls).toHaveLength(1);
    });

    it('drops a rejected parameter and retries without it', async () => {
      const transport = mockTransport().push(
        errorResponse(400, {
          message: 'Unsupported parameter: reasoning_effort',
          code: 'unsupported_parameter',
          param: 'reasoning_effort',
        }),
        completion({ text: 'degraded but answered' }),
      );
      const { provider, clock } = resilient(transport);
      const result = await provider.chat({ ...base, reasoningEffort: 'high' });

      expect(result.message.content).toEqual([textPart('degraded but answered')]);
      expect(transport.calls[0]?.body.reasoning_effort).toBe('high');
      expect(transport.calls[1]?.body.reasoning_effort).toBeUndefined();
      // A degradation is a repair, not a transient failure: it must not spend
      // the retry budget, and it must not wait before trying the fixed request.
      expect(clock.sleeps).toEqual([]);
    });

    it('drops the oldest turns when the request exceeds the context window', async () => {
      const long: readonly ChatMessage[] = [
        systemMessage('You are GhostAI.'),
        ...Array.from({ length: 12 }, (_, index) =>
          userMessage(`question ${String(index)} `.repeat(40)),
        ),
      ];
      const transport = mockTransport().push(
        errorResponse(400, { message: 'too long', code: 'context_length_exceeded' }),
        completion({ text: 'fits now' }),
      );
      const { provider } = resilient(transport);
      const result = await provider.chat({ ...base, messages: long });

      expect(result.message.content).toEqual([textPart('fits now')]);
      const before = transport.calls[0]?.body.messages as unknown[];
      const after = transport.calls[1]?.body.messages as unknown[];
      expect(after.length).toBeLessThan(before.length);
      // The system prompt is instructions, not conversation; it survives the cut.
      expect((after[0] as { role: string }).role).toBe('system');
    });

    it('falls back to a single response when the event stream cannot be read', async () => {
      const transport = mockTransport().push(
        sseResponse(['{"choices": [', 'still not json'], { done: false }),
        completion({ text: 'answered without streaming' }),
      );
      const { provider } = resilient(transport);
      const { text, done } = await collect(provider.stream(base));

      expect(text).toEqual(['answered without streaming']);
      if (done?.type !== 'done') throw new Error('no done event');
      expect(done.result.message.content).toEqual([textPart('answered without streaming')]);
      expect(transport.calls[1]?.body.stream).toBeUndefined();
    });

    it('encodes an image as a content part beside its text', async () => {
      const transport = mockTransport().push(completion({ text: 'a cat' }));
      await options.create(transport).chat({
        ...base,
        messages: [
          userMessage([textPart('what is this?'), imagePart('image/png', { data: 'aGk=' })]),
        ],
      });

      const messages = transport.calls[0]?.body.messages as { content: unknown }[];
      expect(messages[0]?.content).toEqual([
        { type: 'text', text: 'what is this?' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,aGk=' } },
      ]);
    });

    it('round-trips a tool result back into the next request', async () => {
      const transport = mockTransport().push(completion({ text: 'the file says hi' }));
      await options.create(transport).chat({
        ...base,
        messages: [
          userMessage('read a.txt'),
          assistantMessage('', {
            toolCalls: [{ id: 'call_1', name: 'read_file', argumentsJson: '{}' }],
          }),
          toolMessage('call_1', 'read_file', 'hi'),
        ],
      });

      const messages = transport.calls[0]?.body.messages as Record<string, unknown>[];
      // An assistant turn with only tool calls carries `null` content, and the
      // tool result carries the id that pairs it — the two facts every provider
      // returns a 400 for when they are wrong.
      expect(messages[1]).toMatchObject({ role: 'assistant', content: null });
      expect(messages[2]).toMatchObject({ role: 'tool', tool_call_id: 'call_1', content: 'hi' });
    });

    it('lists models, and reports the failure when it cannot', async () => {
      const transport = mockTransport().push(
        modelsResponse('model-a', 'model-b'),
        errorResponse(500, { message: 'boom' }),
      );
      const provider = options.create(transport);

      expect(await provider.listModels()).toEqual([
        { id: 'model-a', providerId: provider.id },
        { id: 'model-b', providerId: provider.id },
      ]);
      await expect(provider.listModels()).rejects.toSatisfy(
        (error: unknown) => isProviderError(error) && error.reason === 'server',
      );
    });
  });
}
