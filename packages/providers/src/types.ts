/**
 * The provider interface every wire adapter implements.
 *
 * Two shapes matter, and both are chosen so the agent loop needs no translation
 * layer of its own:
 *
 *  - A result carries an `AssistantMessage` from `@ghostai/protocol` — the same
 *    canonical shape the session store persists. The loop appends it directly.
 *    An adapter-specific response type would mean every consumer converting, and
 *    conversions are where tool-call ids get lost.
 *  - Streaming is an `AsyncIterable` ending in a `done` event that carries the
 *    same complete result. Not a callback: `for await` propagates errors to the
 *    caller's `try`, honours `break` as backpressure, and — the part that
 *    matters for a Stop button — unwinds correctly when the consumer stops
 *    consuming. An `onToken` callback makes every one of those the adapter's
 *    problem instead.
 *
 * There is deliberately no `chatWithRetry` here. Resilience is a decorator over
 * this interface (`withResilience`), so an adapter is only responsible for
 * speaking its wire correctly, and retry semantics exist once rather than once
 * per adapter and once per streaming variant.
 */

import type {
  AssistantMessage,
  ChatMessage,
  ModelInfo,
  ReasoningEffort,
  ToolDefinition,
  Usage,
} from '@ghostai/protocol';

import type { ProviderSpec } from './registry.js';

/**
 * Whether the model may call tools this turn.
 *
 * Not a specific-tool object: forcing one named tool is a single-purpose
 * feature (the heartbeat's `skip|run` decision) and it belongs to the caller
 * that needs it, once that caller exists.
 */
export type ToolChoice = 'auto' | 'none' | 'required';

/** Why the provider stopped generating. */
export type FinishReason = 'stop' | 'tool_calls' | 'length' | 'content_filter';

/**
 * A request, as the loop assembles it.
 *
 * Optional fields are written `?: T | undefined` rather than `?: T`, against the
 * repo's `exactOptionalPropertyTypes`. That is deliberate here and nowhere else:
 * the degradation ladder's whole job is to *remove* a parameter, and with a bare
 * `?:` the natural expression of that — `{...request, reasoningEffort: undefined}`
 * — is a type error, leaving a destructure-and-rebuild that silently drops any
 * field added later.
 */
export interface ChatRequest {
  readonly model: string;
  /**
   * Already windowed and legal — `historyForLLM` has run. An adapter encodes
   * what it is given and never edits history, because the alignment rules that
   * keep tool results paired live in one place and this is not it.
   */
  readonly messages: readonly ChatMessage[];
  readonly tools?: readonly ToolDefinition[] | undefined;
  readonly toolChoice?: ToolChoice | undefined;
  readonly maxTokens?: number | undefined;
  readonly temperature?: number | undefined;
  readonly reasoningEffort?: ReasoningEffort | undefined;
  /**
   * A stable identifier for the conversation this request belongs to.
   *
   * A hint for the provider's prompt cache, not a correctness input: caching
   * itself works off the prefix bytes, and this only tells a load balancer to
   * send requests that share a prefix to the machine already holding it. The
   * loop passes the session key, so every iteration of every turn on one
   * conversation routes together.
   *
   * Omitted rather than empty when there is nothing to say, and removable by the
   * degradation ladder for endpoints that reject fields they do not know.
   */
  readonly cacheKey?: string | undefined;
  /**
   * The turn's signal. The same one threads from the WebSocket disconnect
   * through the loop, this request, tool execution and any child process.
   */
  readonly signal?: AbortSignal | undefined;
}

export interface ChatResult {
  /** Canonical, and ready to append to history as-is. */
  readonly message: AssistantMessage;
  readonly finishReason: FinishReason;
  readonly usage: Usage;
  /** As reported by the provider, which may differ from what was requested. */
  readonly model: string;
}

/**
 * A streaming event.
 *
 * `text` and `reasoning` are deltas — the consumer appends. `done` arrives
 * exactly once, last, and carries the assembled result including tool calls and
 * usage, so a consumer that only wants the final message can ignore the deltas
 * entirely and still be correct.
 */
export type ChatStreamEvent =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'reasoning'; readonly text: string }
  | { readonly type: 'done'; readonly result: ChatResult };

export interface ChatProvider {
  readonly id: string;
  readonly spec: ProviderSpec;
  chat(request: ChatRequest): Promise<ChatResult>;
  stream(request: ChatRequest): AsyncIterable<ChatStreamEvent>;
  /** Empty when the endpoint has no model list; never throws for that reason. */
  listModels(signal?: AbortSignal): Promise<ModelInfo[]>;
  /** Releases the keep-alive connection pool. Idempotent. */
  close(): Promise<void>;
}

export function emptyUsage(): Usage {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
}
