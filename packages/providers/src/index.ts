/**
 * @ghostai/providers — the provider registry, one wire adapter, and resilience.
 *
 * The package is organised around a claim: **a provider is data, and only a wire
 * protocol is code.** `PROVIDERS` is a table; `openai-chat` is the single
 * adapter that serves every entry in it today — Ollama, LM Studio, llama.cpp,
 * vLLM, OpenAI, OpenRouter, DeepSeek, Groq, xAI, and Gemini through its
 * compatibility endpoint. Adding a provider is a table entry. Adding a
 * *protocol* is an adapter, and there are only three left worth writing.
 *
 * What the table buys beyond brevity is that `ProviderId` is derived from it, so
 * the settings tree cannot name a provider that does not exist. Configuration
 * drift becomes a type error rather than a runtime surprise.
 *
 * Three rules the rest of the repo depends on:
 *
 *  - **Failures are typed.** A `ProviderError` carries a `reason`, an HTTP
 *    status and the parameter the provider blamed. Nothing searches an error
 *    message for "429" or "rate limit" — a model that writes those words in its
 *    answer must not trigger a retry, and a provider that phrases its rejection
 *    differently must still be understood.
 *  - **Retry and degradation live in one decorator.** `withResilience` wraps
 *    both call styles over one ladder of `DegradationStep`s, so the streaming
 *    and non-streaming paths cannot drift apart, and each repair is a pure
 *    function testable without a provider at all.
 *  - **Nothing here touches the network without being asked.** Every adapter
 *    takes an injectable `fetch`, and the conformance suite drives all of its
 *    scenarios through it. No test in this package opens a socket.
 *
 * The provider base URL deliberately does *not* go through `guardedFetch`. That
 * guard exists to stop the model from choosing a destination; a base URL is
 * operator configuration, and the common case is a model server on loopback —
 * the one host the SSRF guard is built to refuse. What is enforced instead is
 * narrower and real: an API key never goes over plain HTTP to a public address.
 */

export {
  PROVIDERS,
  PROVIDER_IDS,
  WIRE_PROTOCOLS,
  describeProvider,
  findGateway,
  findProvider,
  findProviderByModel,
  isProviderId,
  modelOverrideFor,
  resolveModelId,
  resolveProvider,
  type ProviderSpec,
} from './registry.js';

export {
  describeInstance,
  findInstance,
  instanceLabel,
  listInstances,
  nextInstanceId,
  resolveInstance,
  type ProviderInstance,
} from './instances.js';

export {
  PROVIDER_ERROR_REASONS,
  ProviderError,
  classifyStatus,
  isProviderError,
  parseRetryAfter,
  toProviderError,
  type ProviderErrorReason,
  type TransportContext,
  type WireErrorBody,
} from './errors.js';

export {
  emptyUsage,
  type ChatProvider,
  type ChatRequest,
  type ChatResult,
  type ChatStreamEvent,
  type FinishReason,
  type ToolChoice,
} from './types.js';

export {
  MAX_SSE_FRAME_CHARS,
  parseSse,
  readByteStream,
  type SseEvent,
} from './sse.js';

export {
  assertUsableApiBase,
  createOpenAIChatProvider,
} from './openai-chat.js';

export {
  DEFAULT_DEGRADATION_STEPS,
  backoffDelayMs,
  synthesiseStream,
  truncateOldestTurns,
  withResilience,
  type ResilienceNotice,
  type ResilienceOptions,
} from './resilience.js';

export {
  createProvider,
  resolveConnection,
  type CreateProviderOptions,
} from './factory.js';

export { estimateTokens, loadTokenCounter } from './tokens.js';
