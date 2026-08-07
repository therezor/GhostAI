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

import type { Dispatcher } from 'undici';

import type { FetchImplementation } from '@ghostai/security';
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

/**
 * What every wire adapter is handed.
 *
 * The union of what a connection needs and nothing about a conversation: the
 * adapter is constructed once per provider instance and then answers many
 * requests, so anything that varies per turn belongs on `ChatRequest`.
 *
 * Declared here rather than beside `createOpenAIChatProvider` so that
 * `wires.ts` can name it without importing an adapter, which is what keeps the
 * map of adapters from being a cycle.
 */
export interface WireAdapterOptions {
  readonly spec: ProviderSpec;
  /** From the credential vault, never from config. Absent for local servers. */
  readonly apiKey?: string | undefined;
  /** Overrides `spec.defaultApiBase`. Operator configuration, not model input. */
  readonly apiBase?: string | undefined;
  readonly extraHeaders?: Readonly<Record<string, string>> | undefined;
  /** Injected in tests. Production goes through undici with a pooled agent. */
  readonly fetchImpl?: FetchImplementation | undefined;
  /**
   * Replaces the pooled agent this provider would otherwise build — a
   * `ProxyAgent`, or a `MockAgent` for a test that wants the real fetch path.
   * `requestTimeoutMs` and `streamIdleTimeoutMs` then belong to the caller.
   */
  readonly dispatcher?: Dispatcher | undefined;
  /** Time to first response header. Not a cap on generation. */
  readonly requestTimeoutMs?: number | undefined;
  /** Longest gap between stream chunks before the connection is considered dead. */
  readonly streamIdleTimeoutMs?: number | undefined;
  /** Tool-call ids for providers that omit them. Injected so tests are stable. */
  readonly generateId?: (() => string) | undefined;
}

/**
 * A wire protocol, as code.
 *
 * `ProviderSpec` says which wire a provider speaks; this is the thing that
 * speaks it. Separating them is what lets a provider be *data* — the claim the
 * whole package is organised around — and it is also the seam an extension
 * reaches to add a wire this build does not ship.
 */
export type WireAdapter = (options: WireAdapterOptions) => ChatProvider;

export function emptyUsage(): Usage {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
}
