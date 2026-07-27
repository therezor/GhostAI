/**
 * A provider that reads from a script.
 *
 * The loop's behaviour is almost entirely a function of what the model does —
 * answer, call one tool, call three, fail, stall — and a scripted provider is
 * how each of those becomes one line of a test instead of a mocked transport.
 * The real wire adapter is tested against `undici.MockAgent` in
 * `@ghostai/providers`; nothing here is asserting anything about HTTP.
 *
 * Requests are recorded, because half of what this package must get right is in
 * the request rather than in the response: the system prompt's static prefix
 * staying byte-identical across iterations, the tool definitions being the same
 * frozen array every time, history arriving already aligned.
 */

import { assistantMessage } from '@ghostai/core';
import type { ToolCall, Usage } from '@ghostai/protocol';
import {
  emptyUsage,
  findProvider,
  type ChatProvider,
  type ChatRequest,
  type ChatResult,
  type ChatStreamEvent,
  type FinishReason,
  type ProviderSpec,
} from '@ghostai/providers';

export interface ScriptedTurn {
  /** Text deltas, in order. Their concatenation is the message content. */
  readonly deltas?: readonly string[];
  readonly reasoning?: readonly string[];
  readonly toolCalls?: readonly ToolCall[];
  readonly usage?: Partial<Usage>;
  /** Thrown instead of streaming. */
  readonly error?: unknown;
  /** Ends the stream without its `done` event — a truncated transport. */
  readonly omitDone?: boolean;
  /** Runs before the first event. The seam for aborting mid-turn. */
  readonly onStream?: () => void | Promise<void>;
}

export interface ScriptedProvider extends ChatProvider {
  /** Every request, in order. */
  readonly requests: readonly ChatRequest[];
}

const OLLAMA: ProviderSpec = findProvider('ollama') ?? {
  id: 'scripted',
  displayName: 'Scripted',
  wire: 'openai-chat',
  keywords: [],
};

function resultFor(turn: ScriptedTurn, model: string): ChatResult {
  const text = (turn.deltas ?? []).join('');
  const toolCalls = turn.toolCalls ?? [];
  const reasoning = (turn.reasoning ?? []).join('');
  const finishReason: FinishReason = toolCalls.length > 0 ? 'tool_calls' : 'stop';

  return {
    message: assistantMessage(text, {
      toolCalls,
      ...(reasoning === '' ? {} : { reasoning }),
    }),
    finishReason,
    usage: { ...emptyUsage(), ...turn.usage },
    model,
  };
}

/**
 * Builds a provider from a list of turns.
 *
 * Running past the end repeats the last turn rather than throwing: a test for
 * the iteration cap is a test about a model that never stops calling tools, and
 * writing that as forty identical script entries would only obscure it.
 */
export function scriptedProvider(turns: readonly ScriptedTurn[]): ScriptedProvider {
  const requests: ChatRequest[] = [];
  let index = 0;

  const next = (): ScriptedTurn => {
    const turn = turns[Math.min(index, turns.length - 1)] ?? {};
    index += 1;
    return turn;
  };

  async function* stream(request: ChatRequest): AsyncIterable<ChatStreamEvent> {
    requests.push(request);
    const turn = next();
    await turn.onStream?.();

    // `unknown` on purpose — a wire adapter can reject with anything, and the
    // loop's job is to normalise it rather than to assume an `Error`.
    if (turn.error !== undefined) throw turn.error as Error;
    if (request.signal?.aborted === true) {
      throw new DOMException('The operation was aborted.', 'AbortError');
    }

    for (const text of turn.reasoning ?? []) yield { type: 'reasoning', text };
    for (const text of turn.deltas ?? []) yield { type: 'text', text };
    if (turn.omitDone === true) return;
    yield { type: 'done', result: resultFor(turn, request.model) };
  }

  return {
    id: 'scripted',
    spec: OLLAMA,
    requests,
    chat: async (request) => {
      let result: ChatResult | undefined;
      for await (const event of stream(request)) {
        if (event.type === 'done') result = event.result;
      }
      return result ?? resultFor({}, request.model);
    },
    stream,
    listModels: () => Promise.resolve([]),
    close: () => Promise.resolve(),
  };
}

/** A tool call in the shape the adapters produce. */
export function toolCall(
  id: string,
  name: string,
  args: Readonly<Record<string, unknown>>,
): ToolCall {
  return { id, name, argumentsJson: JSON.stringify(args) };
}
