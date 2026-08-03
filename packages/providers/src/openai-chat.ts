/**
 * The `openai-chat` wire adapter.
 *
 * One adapter, ten providers: Ollama, LM Studio, llama.cpp, vLLM, OpenAI,
 * OpenRouter, DeepSeek, Groq, xAI and Gemini's compatibility endpoint all speak
 * `POST /chat/completions`. Everything that differs between them — base URL,
 * model-prefix handling, which name the token cap goes by — is a field in the
 * registry table, not a subclass here.
 *
 * The adapter is deliberately thin and does exactly three things: encode
 * canonical messages onto the wire, decode the wire back into a canonical
 * `AssistantMessage`, and turn a non-2xx response into a typed `ProviderError`.
 * It does not retry, does not degrade, does not truncate history and does not
 * repair anything. Those belong to `withResilience` and to `historyForLLM`, in
 * one place each, rather than smeared across every adapter that will follow.
 *
 * Two encoding decisions are worth stating, because both are bug-compatibility
 * with the ecosystem rather than preference:
 *
 *  - **Text-only content collapses to a plain string.** The array-of-parts form
 *    is correct per the OpenAI schema, and several local servers reject it for
 *    `system` and `tool` messages. The string form is understood everywhere.
 *  - **Tool-call arguments cross the wire verbatim.** A model emitting malformed
 *    JSON is routine; parsing it here would turn that into a transport-layer
 *    exception. The string is preserved so the tool registry can reject it as a
 *    typed tool error the model gets to see and retry against.
 */

import {
  Agent,
  type Dispatcher,
  fetch as undiciFetch,
  type RequestInit,
  type Response,
} from 'undici';

import type {
  AssistantMessage,
  ChatMessage,
  ContentPart,
  ModelInfo,
  ToolCall,
  Usage,
} from '@ghostai/protocol';
import { GhostError } from '@ghostai/core';
import { classifyAddress, parseIpLiteral, type FetchImplementation } from '@ghostai/security';

import {
  ProviderError,
  classifyStatus,
  parseRetryAfter,
  toProviderError,
  type TransportContext,
  type WireErrorBody,
} from './errors.js';
import {
  arrayField,
  asRecord,
  asString,
  numberField,
  parseJson,
  recordField,
  stringField,
} from './json.js';
import { modelOverrideFor, resolveModelId, type ProviderSpec } from './registry.js';
import { parseSse, readByteStream } from './sse.js';
import {
  emptyUsage,
  type ChatProvider,
  type ChatRequest,
  type ChatResult,
  type ChatStreamEvent,
  type FinishReason,
} from './types.js';

export interface OpenAIChatOptions {
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

/** Time to first byte. Generous, because a cold local model loads weights first. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
/** Between chunks, not total: a long answer is not a hung connection. */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 120_000;

/**
 * Rejects a configuration that would put an API key on the wire in cleartext.
 *
 * This is the one security decision the adapter owns. A base URL is operator
 * configuration and never model input, so it does not go through `guardedFetch`
 * — SSRF protection exists to stop the *model* from choosing a destination, and
 * blocking a local model server on loopback would be that guard misfiring on the
 * one host it is meant to trust.
 *
 * What remains is worth catching: `http://` to a public address with an
 * `Authorization` header attached hands the key to every hop in between. Plain
 * HTTP stays allowed without a key (llama.cpp on a LAN) and to loopback or
 * private ranges (every local server), which covers the legitimate cases.
 */
export function assertUsableApiBase(rawBase: string, hasApiKey: boolean): URL {
  let url: URL;
  try {
    url = new URL(rawBase);
  } catch (error) {
    throw new GhostError('config', `Provider apiBase is not a URL: ${rawBase}`, { cause: error });
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new GhostError('config', `Provider apiBase must be http or https, got "${url.protocol}"`);
  }
  if (url.protocol === 'https:' || !hasApiKey) return url;

  const host = url.hostname.toLowerCase();
  if (host === 'localhost') return url;
  const literal = parseIpLiteral(host);
  const category = literal === null ? null : classifyAddress(literal)?.category;
  if (category === 'loopback' || category === 'private') return url;

  throw new GhostError(
    'config',
    `Refusing to send an API key over plain HTTP to ${url.hostname}. Use https, or configure the provider without a key.`,
  );
}

/** Trailing slashes are common in pasted base URLs and produce `//` on join. */
function joinPath(base: URL, path: string): string {
  return `${base.href.replace(/\/+$/, '')}/${path}`;
}

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

type WireContentPart =
  { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };

interface WireToolCall {
  readonly id: string;
  readonly type: 'function';
  readonly function: { readonly name: string; readonly arguments: string };
}

interface WireMessage {
  readonly role: string;
  readonly content: string | readonly WireContentPart[] | null;
  readonly tool_calls?: readonly WireToolCall[];
  readonly tool_call_id?: string;
}

function encodePart(part: ContentPart): WireContentPart {
  if (part.type === 'text') return { type: 'text', text: part.text };
  // A `file` part is a workspace reference, and this wire format has nowhere to
  // put one — it is meant to have been turned into text or an image by
  // `materialiseAttachments` before the request got here. Reaching this branch
  // means a caller went straight to a provider, so render the reference rather
  // than dropping it: a model told the path can still reach for a tool, and a
  // silently missing attachment is the failure this whole change was about.
  if (part.type === 'file') {
    return { type: 'text', text: `[attachment: ${part.path} · ${part.mimeType}]` };
  }
  // An inline image becomes a data URI; a signed URL is passed through for the
  // provider to fetch. Both are what `image_url` accepts.
  const url =
    part.data === undefined ? (part.url ?? '') : `data:${part.mimeType};base64,${part.data}`;
  return { type: 'image_url', image_url: { url } };
}

function encodeContent(parts: readonly ContentPart[]): string | readonly WireContentPart[] {
  const encoded = parts.map(encodePart);
  return encoded.every((part) => part.type === 'text')
    ? encoded.map((part) => part.text).join('\n')
    : encoded;
}

export function encodeMessage(message: ChatMessage): WireMessage {
  switch (message.role) {
    case 'system':
      return { role: 'system', content: message.content };
    case 'user':
      return { role: 'user', content: encodeContent(message.content) };
    case 'tool':
      return { role: 'tool', content: message.content, tool_call_id: message.toolCallId };
    case 'assistant': {
      const content = encodeContent(message.content);
      const toolCalls = message.toolCalls.map<WireToolCall>((call) => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: call.argumentsJson },
      }));
      return {
        role: 'assistant',
        // `null`, not `""`: an assistant turn that only called tools has no text,
        // and several providers reject an empty string where they accept null.
        content: content === '' && toolCalls.length > 0 ? null : content,
        ...(toolCalls.length === 0 ? {} : { tool_calls: toolCalls }),
      };
    }
  }
}

/**
 * What "do not think" is, absent a `reasoningOffBody` on the spec.
 *
 * OpenAI's own extension of `reasoning_effort`, and the closest thing the
 * OpenAI-compatible range has to a convention. An endpoint that has never heard
 * of it answers with an `unsupported_param` or a bare 400, which is exactly the
 * shape `dropReasoningEffort` repairs.
 */
const DEFAULT_REASONING_OFF_BODY: Readonly<Record<string, unknown>> = { reasoning_effort: 'none' };

function buildBody(
  spec: ProviderSpec,
  request: ChatRequest,
  stream: boolean,
): Record<string, unknown> {
  const model = resolveModelId(spec, request.model);
  const override = modelOverrideFor(spec, request.model);
  const maxTokens = override?.maxTokens ?? request.maxTokens;
  const temperature = override?.temperature ?? request.temperature;

  const body: Record<string, unknown> = {
    model,
    messages: request.messages.map(encodeMessage),
  };

  if (maxTokens !== undefined) body[spec.maxTokensParam ?? 'max_tokens'] = Math.max(1, maxTokens);
  if (temperature !== undefined) body.temperature = temperature;
  // `off` is a value this project made up, not one any wire accepts, so it is
  // translated rather than sent. Everything else is already the wire's own
  // vocabulary and goes through as it is.
  if (request.reasoningEffort === 'off') {
    Object.assign(body, spec.reasoningOffBody ?? DEFAULT_REASONING_OFF_BODY);
  } else if (request.reasoningEffort !== undefined) {
    body.reasoning_effort = request.reasoningEffort;
  }
  // Only where the table says the provider caches prompts. It is an optional
  // routing hint everywhere it is understood and an unknown field everywhere
  // else, and sending unknown fields to endpoints that have no use for them is
  // how the degradation ladder ends up doing work that need not happen.
  if (spec.supportsPromptCaching === true && request.cacheKey !== undefined) {
    body.prompt_cache_key = request.cacheKey;
  }

  if (request.tools !== undefined && request.tools.length > 0) {
    body.tools = request.tools.map((tool) => ({
      type: 'function',
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    }));
    if (request.toolChoice !== undefined) body.tool_choice = request.toolChoice;
  }

  if (stream) {
    body.stream = true;
    // Without this, a streamed turn reports no usage at all and the session's
    // token accounting silently only counts the non-streaming calls.
    body.stream_options = { include_usage: true };
  }

  return body;
}

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

const FINISH_REASONS: Readonly<Record<string, FinishReason>> = {
  stop: 'stop',
  tool_calls: 'tool_calls',
  function_call: 'tool_calls',
  length: 'length',
  max_tokens: 'length',
  content_filter: 'content_filter',
};

/**
 * `finish_reason` is unreliable in exactly one direction: several servers report
 * `stop` on a turn that emitted tool calls. The tool calls are the fact; the
 * label is a claim about them, so the fact wins.
 */
function decodeFinishReason(raw: string | undefined, hasToolCalls: boolean): FinishReason {
  if (hasToolCalls) return 'tool_calls';
  return (raw === undefined ? undefined : FINISH_REASONS[raw]) ?? 'stop';
}

/** Content arrives as a string, or as parts from providers that mirror the input shape. */
function decodeContent(value: unknown): string {
  const direct = asString(value);
  if (direct !== undefined) return direct;
  const parts = Array.isArray(value) ? (value as readonly unknown[]) : null;
  if (parts === null) return '';
  return parts
    .map((part) => stringField(asRecord(part), 'text') ?? '')
    .filter((text) => text !== '')
    .join('\n');
}

/** DeepSeek and friends use `reasoning_content`; OpenRouter uses `reasoning`. */
function decodeReasoning(record: Record<string, unknown> | null): string {
  return stringField(record, 'reasoning_content') ?? stringField(record, 'reasoning') ?? '';
}

function decodeUsage(record: Record<string, unknown> | null): Usage {
  if (record === null) return emptyUsage();
  const prompt = numberField(record, 'prompt_tokens') ?? 0;
  const completion = numberField(record, 'completion_tokens') ?? 0;
  const cached = numberField(recordField(record, 'prompt_tokens_details'), 'cached_tokens');
  const reasoning = numberField(
    recordField(record, 'completion_tokens_details'),
    'reasoning_tokens',
  );
  return {
    promptTokens: prompt,
    completionTokens: completion,
    totalTokens: numberField(record, 'total_tokens') ?? prompt + completion,
    ...(cached === undefined ? {} : { cachedTokens: cached }),
    ...(reasoning === undefined ? {} : { reasoningTokens: reasoning }),
  };
}

function assistantOf(
  text: string,
  reasoning: string,
  toolCalls: readonly ToolCall[],
): AssistantMessage {
  return {
    role: 'assistant',
    content: text === '' ? [] : [{ type: 'text', text }],
    toolCalls: [...toolCalls],
    ...(reasoning === '' ? {} : { reasoning }),
  };
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export function createOpenAIChatProvider(options: OpenAIChatOptions): ChatProvider {
  const { spec } = options;
  const apiKey = options.apiKey === undefined || options.apiKey === '' ? undefined : options.apiKey;
  const rawBase = options.apiBase ?? spec.defaultApiBase ?? '';
  if (rawBase === '') {
    throw new GhostError(
      'config',
      `Provider "${spec.id}" has no apiBase; set one in configuration.`,
    );
  }
  const base = assertUsableApiBase(rawBase, apiKey !== undefined);
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const streamIdleTimeoutMs = options.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS;
  const generateId =
    options.generateId ?? (() => `call_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`);

  // Created lazily, and only when no dispatcher was supplied, so an injected
  // `fetchImpl` — every test — never opens a connection pool.
  let agent: Agent | null = null;
  const dispatcher = (): Dispatcher => {
    if (options.dispatcher !== undefined) return options.dispatcher;
    agent ??= new Agent({
      connectTimeout: 10_000,
      // Both are *idle* timeouts. A wall-clock cap on a turn belongs to the
      // agent loop, which is the only layer that knows what the turn is for.
      headersTimeout: requestTimeoutMs,
      bodyTimeout: streamIdleTimeoutMs,
    });
    return agent;
  };
  const doFetch: FetchImplementation =
    options.fetchImpl ?? ((url, init) => undiciFetch(url, { ...init, dispatcher: dispatcher() }));

  const headers = (): Record<string, string> => ({
    'content-type': 'application/json',
    accept: 'application/json',
    ...spec.defaultHeaders,
    ...options.extraHeaders,
    ...(apiKey === undefined ? {} : { authorization: `Bearer ${apiKey}` }),
  });

  /** Turns a non-2xx into a typed error, reading the provider's own error object. */
  const failure = async (response: Response, url: string): Promise<ProviderError> => {
    const text = await response.text().catch(() => '');
    const body = asRecord(parseJson(text));
    const error = recordField(body, 'error') ?? body;
    const wire: WireErrorBody = {
      message: stringField(error, 'message'),
      type: stringField(error, 'type'),
      code: stringField(error, 'code'),
      param: stringField(error, 'param'),
    };
    const reason = classifyStatus(response.status, wire);
    const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'), Date.now());
    // Bounded: an HTML error page from a proxy is not a useful log line, and the
    // full body would be one megabyte of it.
    const detail = wire.message ?? text.slice(0, 500);
    return new ProviderError(
      reason,
      `${spec.id} request failed (${String(response.status)})${detail === '' ? '' : `: ${detail}`}`,
      {
        providerId: spec.id,
        status: response.status,
        code: wire.code,
        param: wire.param,
        retryAfterMs: retryAfterMs ?? undefined,
        details: { url },
      },
    );
  };

  const post = async (
    path: string,
    body: unknown,
    signal: AbortSignal | undefined,
  ): Promise<Response> => {
    const url = joinPath(base, path);
    const init: RequestInit = {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(body),
      ...(signal === undefined ? {} : { signal }),
    };
    let response: Response;
    try {
      response = await doFetch(url, init);
    } catch (error) {
      // The URL and the display name, so the message can say *which* endpoint
      // did not answer — "fetch failed" is the same six characters whether the
      // model server was never started or the host name is gone.
      throw toProviderError(error, spec.id, { url, label: spec.displayName });
    }
    if (!response.ok) throw await failure(response, url);
    return response;
  };

  const chat = async (request: ChatRequest): Promise<ChatResult> => {
    const response = await post(
      'chat/completions',
      buildBody(spec, request, false),
      request.signal,
    );
    // A body that fails mid-download is a transport failure, not a bad response;
    // `toProviderError` is what makes the difference visible to the caller.
    const text = await response.text().catch((error: unknown) => {
      throw toProviderError(error, spec.id, {
        url: joinPath(base, 'chat/completions'),
        label: spec.displayName,
      });
    });
    const body = asRecord(parseJson(text));
    const choices = arrayField(body, 'choices');
    const choice = asRecord(choices?.[0]);
    if (choice === null) {
      // A 200 with no choice is a provider-side glitch, not a bad request —
      // classified as `server` so it is retried rather than surfaced.
      throw new ProviderError('server', `${spec.id} returned no choices`, {
        providerId: spec.id,
        status: response.status,
        details: { body: text.slice(0, 500) },
      });
    }

    const message = recordField(choice, 'message');
    const toolCalls = decodeToolCalls(arrayField(message, 'tool_calls'), generateId);
    const result: ChatResult = {
      message: assistantOf(decodeContent(message?.content), decodeReasoning(message), toolCalls),
      finishReason: decodeFinishReason(stringField(choice, 'finish_reason'), toolCalls.length > 0),
      usage: decodeUsage(recordField(body, 'usage')),
      model: stringField(body, 'model') ?? request.model,
    };
    return result;
  };

  async function* stream(request: ChatRequest): AsyncGenerator<ChatStreamEvent, void, undefined> {
    const response = await post('chat/completions', buildBody(spec, request, true), request.signal);
    if (response.body === null) {
      throw new ProviderError('stream_parse', `${spec.id} returned an empty stream`, {
        providerId: spec.id,
        status: response.status,
      });
    }

    let text = '';
    let reasoning = '';
    let finishReason: string | undefined;
    let usage: Usage = emptyUsage();
    let model = request.model;
    const partials = new Map<number, PartialToolCall>();

    // Everything the socket can raise while the stream is being read — a reset
    // connection, an abort, a body timeout — arrives here as whatever undici
    // chose to throw. The adapter's contract is that it only ever raises a
    // `ProviderError`, so the conversion happens once, around the whole loop.
    for await (const event of withProviderErrors(
      parseSse(readByteStream(response.body), { providerId: spec.id }),
      spec.id,
      { url: joinPath(base, 'chat/completions'), label: spec.displayName },
    )) {
      if (event.data === '[DONE]') break;

      const chunk = asRecord(parseJson(event.data));
      if (chunk === null) {
        throw new ProviderError('stream_parse', `${spec.id} sent a stream frame that is not JSON`, {
          providerId: spec.id,
          details: { frame: event.data.slice(0, 200) },
        });
      }
      // An error can arrive *inside* a 200 stream — providers do this when the
      // failure is discovered after the headers are already on the wire.
      const inlineError = recordField(chunk, 'error');
      if (inlineError !== null) {
        // `code` is a string enum in OpenAI's schema and an HTTP status in
        // OpenRouter's. Both readings are attempted, neither is guessed at.
        const wire: WireErrorBody = {
          code: stringField(inlineError, 'code'),
          param: stringField(inlineError, 'param'),
        };
        throw new ProviderError(
          classifyStatus(numberField(inlineError, 'code') ?? 400, wire),
          `${spec.id} stream error: ${stringField(inlineError, 'message') ?? 'unknown'}`,
          { providerId: spec.id, code: wire.code, param: wire.param },
        );
      }

      model = stringField(chunk, 'model') ?? model;
      const chunkUsage = recordField(chunk, 'usage');
      if (chunkUsage !== null) usage = decodeUsage(chunkUsage);

      const choice = asRecord(arrayField(chunk, 'choices')?.[0]);
      if (choice === null) continue;
      finishReason = stringField(choice, 'finish_reason') ?? finishReason;

      const delta = recordField(choice, 'delta');
      const deltaText = decodeContent(delta?.content);
      if (deltaText !== '') {
        text += deltaText;
        yield { type: 'text', text: deltaText };
      }
      const deltaReasoning = decodeReasoning(delta);
      if (deltaReasoning !== '') {
        reasoning += deltaReasoning;
        yield { type: 'reasoning', text: deltaReasoning };
      }
      accumulateToolCalls(partials, arrayField(delta, 'tool_calls'));
    }

    const toolCalls = [...partials.entries()]
      .sort(([a], [b]) => a - b)
      .map<ToolCall>(([, partial]) => ({
        id: partial.id === '' ? generateId() : partial.id,
        name: partial.name,
        argumentsJson: partial.argumentsJson,
      }));

    yield {
      type: 'done',
      result: {
        message: assistantOf(text, reasoning, toolCalls),
        finishReason: decodeFinishReason(finishReason, toolCalls.length > 0),
        usage,
        model,
      },
    };
  }

  const listModels = async (signal?: AbortSignal): Promise<ModelInfo[]> => {
    const url = joinPath(base, 'models');
    let response: Response;
    try {
      response = await doFetch(url, {
        method: 'GET',
        headers: headers(),
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error) {
      throw toProviderError(error, spec.id, { url, label: spec.displayName });
    }
    if (!response.ok) throw await failure(response, url);

    const body = asRecord(parseJson(await response.text()));
    const data = arrayField(body, 'data') ?? [];
    return data
      .map((entry) => stringField(asRecord(entry), 'id'))
      .filter((id): id is string => id !== undefined && id !== '')
      .map<ModelInfo>((id) => ({ id, providerId: spec.id }));
  };

  return {
    id: spec.id,
    spec,
    chat,
    stream,
    listModels,
    close: async () => {
      await agent?.close();
      agent = null;
    },
  };
}

/** Re-raises anything the source throws as a `ProviderError`, unchanged if it already is. */
async function* withProviderErrors<T>(
  source: AsyncIterable<T>,
  providerId: string,
  context: TransportContext,
): AsyncGenerator<T, void, undefined> {
  try {
    for await (const value of source) yield value;
  } catch (error) {
    throw toProviderError(error, providerId, context);
  }
}

interface PartialToolCall {
  id: string;
  name: string;
  argumentsJson: string;
}

function decodeToolCalls(
  raw: readonly unknown[] | null,
  generateId: () => string,
): readonly ToolCall[] {
  if (raw === null) return [];
  const calls: ToolCall[] = [];
  for (const entry of raw) {
    const record = asRecord(entry);
    const fn = recordField(record, 'function');
    const name = stringField(fn, 'name');
    if (name === undefined || name === '') continue;
    calls.push({
      id: stringField(record, 'id') ?? generateId(),
      name,
      // Verbatim. Some providers send an object here rather than a string;
      // re-serialising keeps the field's contract without judging its contents.
      argumentsJson: stringField(fn, 'arguments') ?? JSON.stringify(fn?.arguments ?? {}),
    });
  }
  return calls;
}

/**
 * Folds tool-call deltas into their accumulators.
 *
 * `index` is what pairs a fragment with its call, and it is the only reliable
 * key: `id` and `name` arrive once, in the first fragment, and every fragment
 * after that carries nothing but a slice of the argument string. Keying on `id`
 * would put every continuation into its own bucket.
 */
function accumulateToolCalls(
  partials: Map<number, PartialToolCall>,
  deltas: readonly unknown[] | null,
): void {
  if (deltas === null) return;
  for (const entry of deltas) {
    const record = asRecord(entry);
    if (record === null) continue;
    // A provider that omits `index` sends one call per delta, so appending is
    // the only reading that does not merge two distinct calls into one.
    const index = numberField(record, 'index') ?? partials.size;
    const partial = partials.get(index) ?? { id: '', name: '', argumentsJson: '' };
    const id = stringField(record, 'id');
    if (id !== undefined && id !== '') partial.id = id;
    const fn = recordField(record, 'function');
    partial.name += stringField(fn, 'name') ?? '';
    partial.argumentsJson += stringField(fn, 'arguments') ?? '';
    partials.set(index, partial);
  }
}
