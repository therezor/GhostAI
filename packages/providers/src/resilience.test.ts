import { describe, expect, it, vi } from 'vitest';

import {
  assistantMessage,
  imagePart,
  systemMessage,
  textPart,
  toolMessage,
  userMessage,
} from '@ghostai/core';
import type { ChatMessage } from '@ghostai/protocol';

import { ProviderError, isProviderError } from './errors.js';
import { findProvider } from './registry.js';
import {
  DEFAULT_DEGRADATION_STEPS,
  backoffDelayMs,
  synthesiseStream,
  truncateOldestTurns,
  withResilience,
  type ResilienceNotice,
} from './resilience.js';
import { recordingClock } from './testkit/clock.js';
import {
  emptyUsage,
  type ChatProvider,
  type ChatRequest,
  type ChatResult,
  type ChatStreamEvent,
} from './types.js';

const SPEC = findProvider('ollama')!;

const request = (overrides: Partial<ChatRequest> = {}): ChatRequest => ({
  model: 'test-model',
  messages: [userMessage('hi')],
  ...overrides,
});

const resultOf = (text: string): ChatResult => ({
  message: assistantMessage(text),
  finishReason: 'stop',
  usage: emptyUsage(),
  model: 'test-model',
});

/** A provider whose every call is scripted, so an attempt sequence is a value. */
function scripted(
  ...steps: readonly (ChatResult | Error | readonly ChatStreamEvent[])[]
): ChatProvider & {
  readonly seen: ChatRequest[];
} {
  const seen: ChatRequest[] = [];
  let index = 0;
  const next = (req: ChatRequest): ChatResult | Error | readonly ChatStreamEvent[] => {
    seen.push(req);
    const step = steps[index];
    index += 1;
    if (step === undefined) throw new Error(`unscripted call ${String(index)}`);
    return step;
  };

  return {
    seen,
    id: SPEC.id,
    spec: SPEC,
    chat: (req) => {
      const step = next(req);
      if (step instanceof Error) return Promise.reject(step);
      if (Array.isArray(step)) {
        const done = (step as readonly ChatStreamEvent[]).find((event) => event.type === 'done');
        return Promise.resolve(done?.type === 'done' ? done.result : resultOf(''));
      }
      return Promise.resolve(step as ChatResult);
    },
    stream: async function* (req) {
      const step = next(req);
      if (step instanceof Error) throw step;
      if (!Array.isArray(step)) {
        yield { type: 'done', result: step as ChatResult };
        return;
      }
      for (const event of step as readonly ChatStreamEvent[]) {
        if (event instanceof Error) throw event;
        yield event;
      }
    },
    listModels: () => Promise.resolve([]),
    close: () => Promise.resolve(),
  };
}

const wrap = (
  provider: ChatProvider,
  notices: ResilienceNotice[] = [],
): { provider: ChatProvider; clock: ReturnType<typeof recordingClock> } => {
  const clock = recordingClock();
  return {
    clock,
    provider: withResilience(provider, {
      clock,
      jitter: () => 1,
      onNotice: (notice) => notices.push(notice),
    }),
  };
};

describe('retry', () => {
  it('backs off exponentially and gives up after the attempt cap', async () => {
    const inner = scripted(
      new ProviderError('server', 'boom'),
      new ProviderError('server', 'boom'),
      new ProviderError('server', 'boom'),
    );
    const { provider, clock } = wrap(inner);

    await expect(provider.chat(request())).rejects.toThrow(/boom/);
    // Three attempts, two waits: 500 then 1000, at `jitter: () => 1`.
    expect(clock.sleeps).toEqual([500, 1000]);
    expect(inner.seen).toHaveLength(3);
  });

  it('stops immediately on an error that repeating cannot fix', async () => {
    const inner = scripted(new ProviderError('auth', 'bad key'));
    const { provider, clock } = wrap(inner);

    await expect(provider.chat(request())).rejects.toThrow(/bad key/);
    expect(clock.sleeps).toEqual([]);
    expect(inner.seen).toHaveLength(1);
  });

  it('never retries an abort', async () => {
    const inner = scripted(new ProviderError('aborted', 'cancelled'));
    const { provider, clock } = wrap(inner);

    await expect(provider.chat(request())).rejects.toSatisfy(
      (error: unknown) => isProviderError(error) && error.reason === 'aborted',
    );
    expect(clock.sleeps).toEqual([]);
  });

  it('normalises an untyped throw before deciding', async () => {
    const inner = scripted(new TypeError('fetch failed'), resultOf('recovered'));
    const { provider } = wrap(inner);
    // A raw `TypeError` from undici is a transport failure, which is retryable —
    // but only once it has been through `toProviderError`.
    expect((await provider.chat(request())).message.content).toEqual([textPart('recovered')]);
  });

  it('honours Retry-After over its own schedule, up to the ceiling', () => {
    const options = { baseDelayMs: 500, maxDelayMs: 8000, jitter: () => 1 };
    expect(
      backoffDelayMs(1, new ProviderError('rate_limit', 'x', { retryAfterMs: 2000 }), options),
    ).toBe(2000);
    expect(
      backoffDelayMs(1, new ProviderError('rate_limit', 'x', { retryAfterMs: 90_000 }), options),
    ).toBe(8000);
    expect(backoffDelayMs(4, new ProviderError('server', 'x'), options)).toBe(4000);
    expect(backoffDelayMs(9, new ProviderError('server', 'x'), options)).toBe(8000);
  });

  it('scales the delay by the jitter fraction', () => {
    const options = { baseDelayMs: 1000, maxDelayMs: 8000, jitter: () => 0.25 };
    expect(backoffDelayMs(1, new ProviderError('server', 'x'), options)).toBe(250);
  });

  it('aborting during backoff ends the turn rather than retrying', async () => {
    const controller = new AbortController();
    const inner = scripted(new ProviderError('server', 'boom'));
    const clock = recordingClock();
    const provider = withResilience(inner, {
      clock: {
        ...clock,
        sleep: () => Promise.reject(new ProviderError('aborted', 'Sleep aborted')),
      },
      jitter: () => 1,
    });

    await expect(provider.chat(request({ signal: controller.signal }))).rejects.toThrow(/aborted/);
    expect(inner.seen).toHaveLength(1);
  });
});

describe('the degradation ladder', () => {
  it('drops reasoning_effort first, without spending a retry or a wait', async () => {
    const notices: ResilienceNotice[] = [];
    const inner = scripted(
      new ProviderError('unsupported_param', 'no', { param: 'reasoning_effort' }),
      resultOf('ok'),
    );
    const clock = recordingClock();
    const provider = withResilience(inner, {
      clock,
      jitter: () => 1,
      onNotice: (n) => notices.push(n),
    });

    await provider.chat(request({ reasoningEffort: 'high', toolChoice: 'auto' }));
    expect(inner.seen[1]?.reasoningEffort).toBeUndefined();
    // Only the one thing the provider objected to; `tool_choice` is untouched.
    expect(inner.seen[1]?.toolChoice).toBe('auto');
    expect(clock.sleeps).toEqual([]);
    expect(notices.map((notice) => notice.kind)).toEqual(['degraded']);
  });

  it('drops the effort when the provider blames it under its other name', async () => {
    // One setting, two spellings on the wire: `reasoning_effort` almost
    // everywhere, and `reasoning` on OpenRouter, which is also the endpoint
    // `off` is translated for. A step that only knew the first name would
    // decline to fire on exactly the provider that named the second, leaving
    // the turn to fail with a repair sitting unused.
    const inner = scripted(
      new ProviderError('unsupported_param', 'no', { param: 'reasoning' }),
      resultOf('ok'),
    );
    const { provider } = wrap(inner);

    await provider.chat(request({ reasoningEffort: 'off' }));

    expect(inner.seen[1]?.reasoningEffort).toBeUndefined();
  });

  it('skips a step the provider blamed a different parameter for', async () => {
    const inner = scripted(
      new ProviderError('unsupported_param', 'no', { param: 'tool_choice' }),
      resultOf('ok'),
    );
    const { provider } = wrap(inner);

    await provider.chat(request({ reasoningEffort: 'high', toolChoice: 'required' }));
    expect(inner.seen[1]?.reasoningEffort).toBe('high');
    expect(inner.seen[1]?.toolChoice).toBeUndefined();
  });

  it('walks the whole ladder on a bare 400 with no code at all', async () => {
    // Every local inference server. Each step removes only something the
    // request carried, so the ladder degrades in order and then gives up.
    const inner = scripted(
      new ProviderError('invalid_request', '400'),
      new ProviderError('invalid_request', '400'),
      new ProviderError('invalid_request', '400'),
      new ProviderError('invalid_request', '400'),
    );
    const { provider } = wrap(inner);

    await expect(
      provider.chat(
        request({
          reasoningEffort: 'low',
          toolChoice: 'auto',
          messages: [userMessage([textPart('look'), imagePart('image/png', { data: 'aGk=' })])],
        }),
      ),
    ).rejects.toThrow(/400/);

    expect(inner.seen[1]?.reasoningEffort).toBeUndefined();
    expect(inner.seen[2]?.toolChoice).toBeUndefined();
    expect(
      inner.seen[3]?.messages[0]?.role === 'user' && inner.seen[3].messages[0].content,
    ).toEqual([textPart('look')]);
  });

  it('drops the cache key before anything that costs the answer something', async () => {
    const inner = scripted(
      new ProviderError('unsupported_param', 'unknown field prompt_cache_key'),
      resultOf('ok'),
    );
    const { provider } = wrap(inner);

    await provider.chat(request({ cacheKey: 'web:1', reasoningEffort: 'high' }));

    expect(inner.seen[1]?.cacheKey).toBeUndefined();
    // And nothing else was given up to get there — the whole reason this step
    // sits at the top of the ladder.
    expect(inner.seen[1]?.reasoningEffort).toBe('high');
  });

  it('merges a trailing user turn for an endpoint that wants strict alternation', async () => {
    // The loop sends the prompt's volatile half as a trailing user message so the
    // history stays inside the cached prefix. Most endpoints accept two user
    // turns in a row; the ones that do not get them folded together.
    const inner = scripted(
      new ProviderError('invalid_request', 'messages must alternate'),
      resultOf('ok'),
    );
    const { provider } = wrap(inner);

    await provider.chat(
      request({ messages: [systemMessage('rules'), userMessage('hello'), userMessage('live')] }),
    );

    const merged = inner.seen[1]?.messages;
    expect(merged).toHaveLength(2);
    expect(merged?.[1]?.role === 'user' && merged[1].content).toEqual([
      textPart('hello'),
      textPart('live'),
    ]);
  });

  it('leaves a request whose last two turns are not both user alone', () => {
    const step = DEFAULT_DEGRADATION_STEPS.find((entry) => entry.id === 'merge_trailing_user')!;

    expect(step.apply(request({ messages: [userMessage('hello')] }))).toBeNull();
    expect(
      step.apply(request({ messages: [userMessage('hello'), assistantMessage('hi')] })),
    ).toBeNull();
  });

  it('does not degrade an error no repair addresses', async () => {
    const inner = scripted(new ProviderError('content_filter', 'refused'));
    const { provider } = wrap(inner);
    await expect(provider.chat(request({ reasoningEffort: 'high' }))).rejects.toThrow(/refused/);
    expect(inner.seen).toHaveLength(1);
  });

  it('exposes each step as a pure function of the request', () => {
    const ids = DEFAULT_DEGRADATION_STEPS.map((step) => step.id);
    // Cheapest repair first: a cache-routing hint costs nothing, a message
    // boundary costs almost nothing, and it climbs from there to losing turns.
    expect(ids).toEqual([
      'drop_prompt_cache_key',
      'merge_trailing_user',
      'drop_reasoning_effort',
      'drop_tool_choice',
      'strip_images',
      'truncate_turns',
    ]);
    // A step whose parameter is already absent declines, which is what stops
    // the ladder from looping on an identical request.
    for (const step of DEFAULT_DEGRADATION_STEPS) {
      expect(step.apply(request())).toBeNull();
    }
  });
});

describe('truncateOldestTurns', () => {
  const long = (marker: string): ChatMessage => userMessage(`${marker} `.repeat(60));

  it('keeps the system prompt and the newest turn', () => {
    const messages = [systemMessage('rules'), long('a'), long('b'), long('c'), long('d')];
    const kept = truncateOldestTurns(messages);

    expect(kept).not.toBeNull();
    expect(kept?.[0]).toEqual(systemMessage('rules'));
    expect(kept?.at(-1)).toEqual(messages.at(-1));
    expect(kept!.length).toBeLessThan(messages.length);
  });

  it('keeps the trailing runtime turn, which carries the live half of the prompt', () => {
    // It cuts from the front, so this holds by construction — but the tool-pair
    // realignment runs over the whole array, and dropping this message would
    // send a request with no clock, no delimiter and no wrap-up warning.
    const runtime = userMessage('<system-reminder>\n## Live state\n</system-reminder>');
    const messages = [systemMessage('rules'), long('a'), long('b'), long('c'), runtime];
    const kept = truncateOldestTurns(messages);

    expect(kept?.at(-1)).toEqual(runtime);
  });

  it('keeps the question as well as the trailing turn behind it', () => {
    // The guard is "the turn this request is answering", not "the last message".
    // With the runtime half appended after the history those are two different
    // messages, and cutting to the last one alone would send a clock with no
    // question in front of it.
    const question = userMessage('what did the migration change?');
    const runtime = userMessage('<system-reminder>\n## Live state\n</system-reminder>');
    const kept = truncateOldestTurns([
      systemMessage('rules'),
      long('a'),
      long('b'),
      long('c'),
      question,
      runtime,
    ]);

    expect(kept).toContainEqual(question);
    expect(kept?.at(-1)).toEqual(runtime);
  });

  it('never leaves a tool result without the assistant turn that requested it', () => {
    // The failure this exists to prevent: a context-length retry that produces
    // a different 400, about an orphaned tool result.
    const messages: ChatMessage[] = [
      long('old'),
      assistantMessage('', { toolCalls: [{ id: 'c1', name: 'read_file', argumentsJson: '{}' }] }),
      toolMessage('c1', 'read_file', 'x'.repeat(400)),
      long('newer'),
      long('newest'),
    ];
    const kept = truncateOldestTurns(messages);
    const declared = new Set<string>();
    for (const message of kept ?? []) {
      if (message.role === 'assistant') for (const call of message.toolCalls) declared.add(call.id);
      if (message.role === 'tool') expect(declared.has(message.toolCallId)).toBe(true);
    }
  });

  it('declines when there is nothing left to drop', () => {
    expect(truncateOldestTurns([])).toBeNull();
    expect(truncateOldestTurns([userMessage('only')])).toBeNull();
    expect(truncateOldestTurns([systemMessage('rules'), userMessage('only')])).toBeNull();
  });

  it('declines when the survivors would all be orphaned tool results', () => {
    const messages: ChatMessage[] = [
      userMessage('x'.repeat(500)),
      toolMessage('orphan', 'read_file', 'y'.repeat(500)),
      toolMessage('orphan2', 'read_file', 'z'.repeat(500)),
    ];
    expect(truncateOldestTurns(messages)).toBeNull();
  });
});

describe('streaming resilience', () => {
  it('forwards deltas as they arrive rather than buffering the turn', async () => {
    const order: string[] = [];
    const inner: ChatProvider = {
      id: SPEC.id,
      spec: SPEC,
      chat: () => Promise.resolve(resultOf('')),
      stream: async function* () {
        order.push('emit:a');
        yield { type: 'text', text: 'a' };
        order.push('emit:b');
        yield { type: 'text', text: 'b' };
        yield { type: 'done', result: resultOf('ab') };
      },
      listModels: () => Promise.resolve([]),
      close: () => Promise.resolve(),
    };
    const { provider } = wrap(inner);

    for await (const event of provider.stream(request())) {
      if (event.type === 'text') order.push(`consume:${event.text}`);
    }
    // Interleaved, not emit-emit-consume-consume: buffering an attempt so it
    // could be replayed would remove the only reason to stream.
    expect(order).toEqual(['emit:a', 'consume:a', 'emit:b', 'consume:b']);
  });

  it('retries a stream that failed before saying anything', async () => {
    const inner = scripted(new ProviderError('overloaded', 'busy'), [
      { type: 'done', result: resultOf('second') },
    ]);
    const { provider, clock } = wrap(inner);

    const events: ChatStreamEvent[] = [];
    for await (const event of provider.stream(request())) events.push(event);
    expect(events).toHaveLength(1);
    expect(clock.sleeps).toEqual([500]);
  });

  it('raises rather than restarting a stream that already emitted', async () => {
    const inner: ChatProvider = {
      id: SPEC.id,
      spec: SPEC,
      chat: () => Promise.resolve(resultOf('should not be called')),
      stream: async function* () {
        yield { type: 'text', text: 'half an answer' };
        throw new ProviderError('server', 'died mid-answer');
      },
      listModels: () => Promise.resolve([]),
      close: () => Promise.resolve(),
    };
    const chatSpy = vi.spyOn(inner, 'chat');
    const { provider } = wrap(inner);

    const seen: string[] = [];
    const drain = async (): Promise<void> => {
      for await (const event of provider.stream(request()))
        if (event.type === 'text') seen.push(event.text);
    };

    await expect(drain()).rejects.toThrow(/died mid-answer/);
    expect(seen).toEqual(['half an answer']);
    // Restarting would replay text the user has already read.
    expect(chatSpy).not.toHaveBeenCalled();
  });

  it('degrades a stream the same way as a single request', async () => {
    const inner = scripted(
      new ProviderError('unsupported_param', 'no', { param: 'reasoning_effort' }),
      [{ type: 'done', result: resultOf('ok') }],
    );
    const { provider } = wrap(inner);

    for await (const _event of provider.stream(request({ reasoningEffort: 'high' }))) void _event;
    expect(inner.seen[1]?.reasoningEffort).toBeUndefined();
  });

  it('falls back to a single response when the stream cannot be parsed', async () => {
    const notices: ResilienceNotice[] = [];
    const inner = scripted(new ProviderError('stream_parse', 'garbage'), resultOf('whole answer'));
    const clock = recordingClock();
    const provider = withResilience(inner, {
      clock,
      jitter: () => 1,
      onNotice: (n) => notices.push(n),
    });

    const events: ChatStreamEvent[] = [];
    for await (const event of provider.stream(request())) events.push(event);

    expect(events[0]).toEqual({ type: 'text', text: 'whole answer' });
    expect(events[1]?.type).toBe('done');
    expect(notices.map((notice) => notice.kind)).toEqual(['fallback']);
  });

  it('passes listModels and close straight through', async () => {
    const inner = scripted();
    const listSpy = vi.spyOn(inner, 'listModels');
    const closeSpy = vi.spyOn(inner, 'close');
    const { provider } = wrap(inner);

    expect(provider.id).toBe(inner.id);
    expect(provider.spec).toBe(inner.spec);
    await provider.listModels();
    await provider.close();
    expect(listSpy).toHaveBeenCalledOnce();
    expect(closeSpy).toHaveBeenCalledOnce();
  });
});

describe('synthesiseStream', () => {
  it('replays a result as the events a streaming consumer expects', () => {
    const result: ChatResult = {
      message: assistantMessage('answer', { reasoning: 'because' }),
      finishReason: 'stop',
      usage: emptyUsage(),
      model: 'm',
    };
    expect([...synthesiseStream(result)]).toEqual([
      { type: 'reasoning', text: 'because' },
      { type: 'text', text: 'answer' },
      { type: 'done', result },
    ]);
  });

  it('emits only the terminal event for an empty answer', () => {
    const result: ChatResult = {
      message: assistantMessage('', {
        toolCalls: [{ id: 'c', name: 'list_dir', argumentsJson: '{}' }],
      }),
      finishReason: 'tool_calls',
      usage: emptyUsage(),
      model: 'm',
    };
    expect([...synthesiseStream(result)]).toEqual([{ type: 'done', result }]);
  });
});
