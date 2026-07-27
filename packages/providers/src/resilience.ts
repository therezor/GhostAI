/**
 * One decorator for retry and degradation, over both streaming and not.
 *
 * The shape this replaces is two near-identical routines — one per calling
 * style — that drift apart the moment either is fixed. Here `chat` and `stream`
 * share `attempt()`: the same ladder, the same backoff, the same abort handling,
 * differing only in how the underlying call is invoked.
 *
 * Two ideas carry the design.
 *
 * **Degradation is a declarative ladder.** A rejected request is not always a
 * dead request: the model may simply not accept a parameter this one carried.
 * Each `DegradationStep` states what it can repair and how, in the order that
 * costs the least — drop `reasoning_effort`, then `tool_choice`, then images,
 * then the oldest turns. Every step is a pure function of the request, so each
 * is unit-testable on its own and the ladder is data rather than control flow.
 *
 * **A degradation is not a retry.** They have different budgets. Retries exist
 * for transient failures and are capped low because each one costs a round trip
 * against a provider that is already unhappy. Degradations are bounded by the
 * ladder itself — a step that has fired cannot fire again, because the thing it
 * removes is gone — so charging them to the retry budget would leave a request
 * unrepairable for want of an attempt it never needed.
 *
 * The honest limit: **a stream that has already emitted output is not retried.**
 * Restarting it would replay text the user has already seen, and there is no way
 * to un-send it. So recovery — including the non-streaming fallback for a
 * malformed event stream — applies only before the first delta. After that the
 * error propagates, which is the truthful outcome.
 */

import { type Clock, hasImages, systemClock, withoutImages } from '@ghostai/core';
import type { ChatMessage } from '@ghostai/protocol';

import { type ProviderError, toProviderError } from './errors.js';
import { estimateTokens } from './tokens.js';
import type { ChatProvider, ChatRequest, ChatResult, ChatStreamEvent } from './types.js';

/**
 * A repair the ladder can apply to a rejected request.
 *
 * `apply` returns `null` when there is nothing left to change, which is what
 * stops the ladder from looping: a step whose parameter is already absent
 * declines rather than producing an identical request.
 */
export interface DegradationStep {
  readonly id: string;
  /** What the user is told, once, when this step fires. */
  readonly description: string;
  readonly applies: (error: ProviderError, request: ChatRequest) => boolean;
  readonly apply: (request: ChatRequest) => ChatRequest | null;
}

/**
 * Reasons a *request-shaped* repair could help.
 *
 * `unsupported_param` is the provider naming the field. `invalid_request` is
 * every local inference server, which returns a bare 400 with prose — no code,
 * no `param`. Including it is what makes the ladder work off-OpenAI, and it is
 * safe: each step only removes something the request actually carried, so
 * against a genuinely malformed request the ladder runs out and the original
 * error surfaces.
 */
function isRepairable(error: ProviderError): boolean {
  return error.reason === 'unsupported_param' || error.reason === 'invalid_request';
}

/** Whether the provider blamed a specific parameter other than this one. */
function blamesOther(error: ProviderError, param: string): boolean {
  return error.param !== undefined && error.param !== '' && error.param !== param;
}

const dropReasoningEffort: DegradationStep = {
  id: 'drop_reasoning_effort',
  description: 'retrying without reasoning_effort',
  applies: (error, request) =>
    isRepairable(error) &&
    !blamesOther(error, 'reasoning_effort') &&
    request.reasoningEffort !== undefined,
  apply: (request) =>
    request.reasoningEffort === undefined ? null : { ...request, reasoningEffort: undefined },
};

const dropToolChoice: DegradationStep = {
  id: 'drop_tool_choice',
  description: 'retrying without tool_choice',
  applies: (error, request) =>
    isRepairable(error) && !blamesOther(error, 'tool_choice') && request.toolChoice !== undefined,
  // Only `tool_choice` goes, never `tools`. Removing the tools would produce a
  // turn where the model cannot act and answers from memory instead — a wrong
  // answer rather than a failed request, which is worse.
  apply: (request) =>
    request.toolChoice === undefined ? null : { ...request, toolChoice: undefined },
};

const stripImages: DegradationStep = {
  id: 'strip_images',
  description: 'retrying with images removed',
  applies: (error, request) => isRepairable(error) && request.messages.some(hasImages),
  apply: (request) => {
    if (!request.messages.some(hasImages)) return null;
    // The question that came with the image is still worth asking; a text-only
    // answer beats losing the turn.
    return { ...request, messages: request.messages.map(withoutImages) };
  },
};

/** How much of the history one `truncate_turns` step removes. */
const TRUNCATION_FRACTION = 0.35;

/**
 * Drops the oldest turns, keeping the request legal.
 *
 * Measured in estimated tokens rather than message count, because message
 * counts say nothing: ten one-line exchanges and one pasted stack trace are the
 * same number and nowhere near the same request.
 *
 * The system message is preserved wherever the cut lands — it is the agent's
 * instructions, not conversation — and the survivors are realigned so a `tool`
 * result never outlives the `assistant` message that requested it. Cutting
 * blindly by token budget is exactly how a context-length retry becomes a
 * provider 400 about an orphaned tool result.
 */
export function truncateOldestTurns(
  messages: readonly ChatMessage[],
): readonly ChatMessage[] | null {
  const system = messages[0]?.role === 'system' ? messages[0] : null;
  const body = system === null ? messages : messages.slice(1);
  if (body.length <= 1) return null;

  const sizes = body.map((message) => estimateTokens(JSON.stringify(message)));
  const target = sizes.reduce((total, size) => total + size, 0) * TRUNCATION_FRACTION;

  let dropped = 0;
  let cut = 0;
  // Never drop the final message: it is the user turn this request is answering.
  while (cut < body.length - 1 && dropped < target) {
    dropped += sizes[cut] ?? 0;
    cut += 1;
  }
  if (cut === 0) return null;

  const kept = alignToLegalStart(body.slice(cut));
  if (kept.length === 0) return null;
  return system === null ? kept : [system, ...kept];
}

/**
 * Drops leading `tool` messages whose `assistant` was cut away.
 *
 * `findLegalStart` in `@ghostai/core` answers the same question for stored
 * history; this is the same invariant applied to a request that a truncation
 * step just reshaped, and it deliberately does not import the history windowing
 * around it — that path owns consolidation and tool-output caps, neither of
 * which applies to a request already on its way out.
 */
function alignToLegalStart(messages: readonly ChatMessage[]): readonly ChatMessage[] {
  const declared = new Set<string>();
  let start = 0;
  for (const [index, message] of messages.entries()) {
    if (message.role === 'assistant') {
      for (const call of message.toolCalls) declared.add(call.id);
    } else if (message.role === 'tool' && !declared.has(message.toolCallId)) {
      start = index + 1;
      declared.clear();
    }
  }
  return start === 0 ? messages : messages.slice(start);
}

const truncateTurns: DegradationStep = {
  id: 'truncate_turns',
  description: 'retrying with the oldest turns dropped',
  applies: (error) => error.reason === 'context_length',
  apply: (request) => {
    const messages = truncateOldestTurns(request.messages);
    return messages === null ? null : { ...request, messages };
  },
};

/**
 * The ladder, cheapest repair first.
 *
 * Order is the policy: losing `reasoning_effort` costs answer quality, losing
 * images costs information the user supplied, and losing turns costs the
 * conversation's memory. Each step is tried only after the one above it has
 * failed or does not apply.
 */
export const DEFAULT_DEGRADATION_STEPS: readonly DegradationStep[] = [
  dropReasoningEffort,
  dropToolChoice,
  stripImages,
  truncateTurns,
];

export interface ResilienceNotice {
  /** `degraded` when the request was rewritten, `retry` when it was repeated. */
  readonly kind: 'degraded' | 'retry' | 'fallback';
  readonly message: string;
  readonly attempt: number;
  readonly error: ProviderError;
}

export interface ResilienceOptions {
  /** Attempts at the *same* request. Degradations are budgeted separately. */
  readonly maxAttempts?: number | undefined;
  readonly baseDelayMs?: number | undefined;
  readonly maxDelayMs?: number | undefined;
  readonly steps?: readonly DegradationStep[] | undefined;
  /**
   * Jitter factor in `[0, 1)`. Injected rather than taken from `Math.random`,
   * so a test asserting a backoff schedule gets one.
   */
  readonly jitter?: (() => number) | undefined;
  readonly clock?: Clock | undefined;
  /** Surfaced to the UI as a `notice` event; never thrown. */
  readonly onNotice?: ((notice: ResilienceNotice) => void) | undefined;
}

export const DEFAULT_MAX_ATTEMPTS = 3;
export const DEFAULT_BASE_DELAY_MS = 500;
export const DEFAULT_MAX_DELAY_MS = 8_000;

/**
 * Exponential backoff with full jitter, honouring `Retry-After` when given.
 *
 * Full jitter rather than a fixed schedule because the failure that most needs
 * backing off — a shared rate limit — is the one where every client retries at
 * the same moment. A deterministic delay reconverges them into the same spike.
 */
export function backoffDelayMs(
  attempt: number,
  error: ProviderError,
  options: { baseDelayMs: number; maxDelayMs: number; jitter: () => number },
): number {
  if (error.retryAfterMs !== undefined) return Math.min(error.retryAfterMs, options.maxDelayMs);
  const exponential = Math.min(options.baseDelayMs * 2 ** (attempt - 1), options.maxDelayMs);
  return Math.round(exponential * options.jitter());
}

interface Resolved {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly steps: readonly DegradationStep[];
  readonly jitter: () => number;
  readonly clock: Clock;
  readonly notify: (notice: ResilienceNotice) => void;
}

function resolve(options: ResilienceOptions): Resolved {
  return {
    maxAttempts: options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    baseDelayMs: options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS,
    maxDelayMs: options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS,
    steps: options.steps ?? DEFAULT_DEGRADATION_STEPS,
    // Not `Math.random`: it is lint-banned repo-wide precisely so a schedule
    // like this one can be asserted rather than approximated.
    jitter: options.jitter ?? (() => 0.5 + cryptoFraction() / 2),
    clock: options.clock ?? systemClock,
    notify: options.onNotice ?? (() => undefined),
  };
}

/** A uniform fraction in `[0, 1)` from the CSPRNG. */
function cryptoFraction(): number {
  const buffer = new Uint32Array(1);
  crypto.getRandomValues(buffer);
  return (buffer[0] ?? 0) / 2 ** 32;
}

/**
 * The recovery state machine, shared by both call styles.
 *
 * Extracted so `chat` and `stream` cannot disagree about what a 429 means. It
 * owns the mutable part — which steps have fired, which attempt this is, and the
 * request as it currently stands — and `recover` returns whether there is
 * anything left to try. The caller rethrows when it says no.
 */
interface Recovery {
  readonly request: ChatRequest;
  recover(error: ProviderError): Promise<boolean>;
}

function createRecovery(initial: ChatRequest, config: Resolved): Recovery {
  const used = new Set<string>();
  let current = initial;
  let attemptNumber = 1;
  let iteration = 0;
  // Each step fires at most once, so the ladder is finite; the extra room is
  // for the attempt that follows the last degradation.
  const ceiling = config.maxAttempts + config.steps.length + 1;

  return {
    get request(): ChatRequest {
      return current;
    },
    async recover(error: ProviderError): Promise<boolean> {
      iteration += 1;
      // A cancelled turn is not a failure to recover from; retrying it would
      // ignore the one signal the user sent.
      if (error.reason === 'aborted' || iteration >= ceiling) return false;

      for (const step of config.steps) {
        if (used.has(step.id) || !step.applies(error, current)) continue;
        const degraded = step.apply(current);
        if (degraded === null) continue;
        used.add(step.id);
        current = degraded;
        config.notify({
          kind: 'degraded',
          message: step.description,
          attempt: attemptNumber,
          error,
        });
        return true;
      }

      if (!error.retryable || attemptNumber >= config.maxAttempts) return false;

      const delayMs = backoffDelayMs(attemptNumber, error, config);
      config.notify({
        kind: 'retry',
        message: `retrying in ${String(delayMs)} ms after ${error.reason}`,
        attempt: attemptNumber,
        error,
      });
      attemptNumber += 1;
      // Aborting mid-backoff rejects here, which is the intended exit: the
      // signal is the same one threaded into the request itself.
      await config.clock.sleep(delayMs, current.signal);
      return true;
    },
  };
}

async function attempt<T>(
  request: ChatRequest,
  providerId: string,
  config: Resolved,
  run: (request: ChatRequest) => Promise<T>,
): Promise<T> {
  const recovery = createRecovery(request, config);
  for (;;) {
    try {
      return await run(recovery.request);
    } catch (raw) {
      const error = toProviderError(raw, providerId);
      if (!(await recovery.recover(error))) throw error;
    }
  }
}

/**
 * Wraps a provider with retry, degradation and a streaming fallback.
 *
 * The result is a `ChatProvider`, so it composes: the agent loop holds one
 * interface whether or not anything is wrapped around it, and a test can drive
 * the bare adapter directly.
 */
export function withResilience(
  provider: ChatProvider,
  options: ResilienceOptions = {},
): ChatProvider {
  const config = resolve(options);

  return {
    id: provider.id,
    spec: provider.spec,
    listModels: (signal) => provider.listModels(signal),
    close: () => provider.close(),

    chat: async (request) =>
      await attempt(request, provider.id, config, (req) => provider.chat(req)),

    stream: (request) => streamWithResilience(provider, request, config),
  };
}

/**
 * The streaming path.
 *
 * Events are forwarded as they arrive — buffering an attempt so it could be
 * replayed would remove the only reason to stream. `emitted` is the price of
 * that: once a delta has reached the consumer the turn is committed, and a later
 * failure can only be raised, never retried over the top of text the user is
 * already reading.
 */
async function* streamWithResilience(
  provider: ChatProvider,
  request: ChatRequest,
  config: Resolved,
): AsyncGenerator<ChatStreamEvent, void, undefined> {
  const recovery = createRecovery(request, config);

  for (;;) {
    let emitted = false;
    try {
      for await (const event of provider.stream(recovery.request)) {
        emitted = true;
        yield event;
      }
      return;
    } catch (raw) {
      const error = toProviderError(raw, provider.id);
      if (emitted) throw error;

      // Streaming is an optimisation. A stream that could not be read is still
      // a request the provider can answer in one piece, and the consumer gets
      // the same events either way — synthesised from the complete result.
      if (error.reason === 'stream_parse') {
        config.notify({
          kind: 'fallback',
          message: 'stream unreadable, falling back to a single response',
          attempt: 1,
          error,
        });
        yield* synthesiseStream(
          await attempt(recovery.request, provider.id, config, (req) => provider.chat(req)),
        );
        return;
      }

      if (!(await recovery.recover(error))) throw error;
    }
  }
}

/** Replays a non-streaming result as the events a streaming consumer expects. */
export function* synthesiseStream(result: ChatResult): Generator<ChatStreamEvent, void, undefined> {
  if (result.message.reasoning !== undefined && result.message.reasoning !== '') {
    yield { type: 'reasoning', text: result.message.reasoning };
  }
  for (const part of result.message.content) {
    if (part.type === 'text' && part.text !== '') yield { type: 'text', text: part.text };
  }
  yield { type: 'done', result };
}
