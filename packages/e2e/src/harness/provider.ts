/**
 * A model that answers on keywords rather than on position.
 *
 * `scriptedProvider` reads a list of turns in order, which is exactly right for
 * a unit test that owns the whole provider for the length of one assertion. A
 * browser suite does not: one server serves every spec in a file, specs run in
 * whatever order the runner picks, and a positional script would make each test
 * depend on how many turns the ones before it happened to consume.
 *
 * So the script is a lookup instead. A spec types a sentence, the sentence
 * selects a `Route`, and the route's turns are indexed by *how far into that
 * exchange the loop already is* — counted from the request itself, not from a
 * counter this object keeps. That makes every request idempotent in the way
 * that matters: replaying a turn after a reload produces the same answer,
 * because nothing here remembers that it already answered once.
 *
 * The event shaping is `scriptedProvider`'s and not a second copy of it. One
 * throwaway instance per request is the cheapest way to say "render this turn
 * the way the loop tests render theirs" — and the reason its testkit is a
 * subpath export.
 */

import { scriptedProvider, toolCall, type ScriptedTurn } from '@ghostai/agent/testkit';
import { textOf } from '@ghostai/core';
import type { ChatMessage } from '@ghostai/protocol';
import {
  findProvider,
  type ChatProvider,
  type ChatRequest,
  type ChatResult,
  type ChatStreamEvent,
  type ProviderSpec,
} from '@ghostai/providers';

export interface Route {
  /** Matched against the most recent user message. */
  readonly match: RegExp;
  /** One entry per model turn in the exchange. The last one repeats. */
  readonly turns: readonly ScriptedTurn[];
}

const SPEC: ProviderSpec = findProvider('ollama') ?? {
  id: 'ollama',
  displayName: 'Ollama',
  wire: 'openai-chat',
  keywords: [],
};

/**
 * How many model turns have already happened since the last thing the user said.
 *
 * The loop appends an assistant message for every iteration and a tool message
 * for every call it made, so counting assistant messages after the final user
 * message gives the index of the turn about to be produced. A reload replays
 * the same history and therefore lands on the same index — which is what makes
 * the resume spec assert on an answer rather than on a coincidence.
 */
export function turnIndex(messages: readonly ChatMessage[]): number {
  let index = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message === undefined) continue;
    if (message.role === 'user') break;
    if (message.role === 'assistant') index += 1;
  }
  return index;
}

/** The last thing the user said, or `''` before they have said anything. */
export function lastUserText(messages: readonly ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role === 'user') return textOf(message);
  }
  return '';
}

/**
 * A default that is deliberately dull.
 *
 * Every screen that is not the chat view still boots a session, and a fallback
 * that threw would turn "the settings panel rendered" into "the model had no
 * script for the empty string".
 */
const FALLBACK: ScriptedTurn = { deltas: ['Ready.'] };

/** Settles when the turn is aborted, and never otherwise. */
function aborted(signal: AbortSignal | undefined): Promise<void> {
  if (signal === undefined) return new Promise<void>(() => undefined);
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    signal.addEventListener('abort', () => {
      resolve();
    });
  });
}

/**
 * Ends a stalling turn the moment it is cancelled.
 *
 * A turn whose `onStream` never settles is how a spec says "the model is still
 * thinking". Without this it would also be how a spec says "this worker hangs
 * until Playwright's timeout": `scriptedProvider` checks the signal *after*
 * awaiting `onStream`, so the check is unreachable until the wait ends. Racing
 * it against the signal makes the two agree — the turn ends when the turn is
 * cancelled, and `scriptedProvider` then raises the `AbortError` it always
 * would have.
 */
function endsOnAbort(turn: ScriptedTurn, signal: AbortSignal | undefined): ScriptedTurn {
  const { onStream } = turn;
  if (onStream === undefined) return turn;
  return {
    ...turn,
    onStream: async () => {
      await Promise.race([onStream(), aborted(signal)]);
    },
  };
}

export function routedProvider(routes: readonly Route[]): ChatProvider {
  const turnFor = (request: ChatRequest): ScriptedTurn => {
    const text = lastUserText(request.messages);
    const route = routes.find((candidate) => candidate.match.test(text));
    if (route === undefined) return FALLBACK;
    const index = Math.min(turnIndex(request.messages), route.turns.length - 1);
    return endsOnAbort(route.turns[index] ?? FALLBACK, request.signal);
  };

  // One instance per request, holding exactly the turn that request maps to.
  // `scriptedProvider` repeats its last entry forever, so a single-entry script
  // is a provider that can only produce the turn it was handed.
  const delegate = (request: ChatRequest): ChatProvider => scriptedProvider([turnFor(request)]);

  return {
    id: SPEC.id,
    spec: SPEC,
    chat: async (request: ChatRequest): Promise<ChatResult> =>
      await delegate(request).chat(request),
    stream: (request: ChatRequest): AsyncIterable<ChatStreamEvent> =>
      delegate(request).stream(request),
    listModels: () => Promise.resolve([]),
    close: () => Promise.resolve(),
  };
}

export { toolCall };
