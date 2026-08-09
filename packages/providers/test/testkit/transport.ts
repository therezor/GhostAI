/**
 * A scripted transport, and the response fixtures that feed it.
 *
 * No test in this package opens a socket. Every scenario — a 429 followed by a
 * success, a stream that dies halfway, an abort mid-answer — is expressed as a
 * queue of scripted responses, which makes the awkward cases the *easy* ones to
 * write: producing a truncated event stream from a real server means killing a
 * process at the right moment, and producing one here is a string.
 *
 * The queue is strict. An unscripted request throws rather than returning a
 * default, because a test that accidentally makes a second call is a test whose
 * subject is doing something unexpected, and a permissive mock would report that
 * as a pass.
 */

import { Response, type RequestInit } from 'undici';

import type { FetchImplementation } from '@ghostwire/security';

export interface RecordedCall {
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  /** The parsed request body, for asserting what actually went on the wire. */
  readonly body: Record<string, unknown>;
}

/** Produces a response for one request. Receives `init` so it can honour `signal`. */
export type ResponseHandler = (
  url: string,
  init: RequestInit,
) => Response | Promise<Response>;

export interface MockTransport {
  readonly fetchImpl: FetchImplementation;
  readonly calls: readonly RecordedCall[];
  /** Queues one response. Calls are served in the order they were queued. */
  push(...responses: ReadonlyArray<Response | ResponseHandler>): MockTransport;
}

export function mockTransport(): MockTransport {
  const calls: RecordedCall[] = [];
  const queue: Array<Response | ResponseHandler> = [];

  const transport: MockTransport = {
    calls,
    push(...responses) {
      queue.push(...responses);
      return transport;
    },
    fetchImpl: async (url, init) => {
      const raw = typeof init.body === 'string' ? init.body : '';
      calls.push({
        url,
        method: init.method ?? 'GET',
        headers: { ...(init.headers as Record<string, string> | undefined) },
        body: raw === '' ? {} : (JSON.parse(raw) as Record<string, unknown>),
      });
      const next = queue.shift();
      if (next === undefined) {
        throw new Error(`Unscripted request: ${init.method ?? 'GET'} ${url}`);
      }
      return typeof next === 'function' ? await next(url, init) : next;
    },
  };
  return transport;
}

// ---------------------------------------------------------------------------
// Fixtures — the `openai-chat` wire
// ---------------------------------------------------------------------------

export interface FixtureToolCall {
  readonly id: string;
  readonly name: string;
  readonly argumentsJson: string;
}

export interface CompletionOptions {
  readonly text?: string;
  readonly reasoning?: string;
  readonly toolCalls?: readonly FixtureToolCall[];
  readonly finishReason?: string;
  readonly usage?: Readonly<Record<string, unknown>>;
  readonly model?: string;
}

export function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** A non-streaming completion. */
export function completion(options: CompletionOptions = {}): Response {
  const toolCalls = options.toolCalls ?? [];
  return jsonResponse(200, {
    id: 'chatcmpl-fixture',
    model: options.model ?? 'test-model',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: options.text ?? null,
          ...(options.reasoning === undefined
            ? {}
            : { reasoning_content: options.reasoning }),
          ...(toolCalls.length === 0
            ? {}
            : {
                tool_calls: toolCalls.map((call, index) => ({
                  index,
                  id: call.id,
                  type: 'function',
                  function: { name: call.name, arguments: call.argumentsJson },
                })),
              }),
        },
        finish_reason:
          options.finishReason ??
          (toolCalls.length > 0 ? 'tool_calls' : 'stop'),
      },
    ],
    usage: options.usage ?? {
      prompt_tokens: 11,
      completion_tokens: 7,
      total_tokens: 18,
    },
  });
}

/** `GET /models` — the one endpoint whose shape is the same everywhere. */
export function modelsResponse(...ids: readonly string[]): Response {
  return jsonResponse(200, {
    object: 'list',
    data: ids.map((id) => ({ id, object: 'model' })),
  });
}

/** An error body in the shape every OpenAI-compatible endpoint returns. */
export function errorResponse(
  status: number,
  error: Readonly<Record<string, unknown>>,
  headers: Record<string, string> = {},
): Response {
  return jsonResponse(status, { error }, headers);
}

/** Wraps frames as SSE `data:` events, terminated the way providers terminate. */
export function sseBody(
  frames: readonly unknown[],
  options: { readonly done?: boolean } = {},
): string {
  const body = frames
    .map(
      (frame) =>
        `data: ${typeof frame === 'string' ? frame : JSON.stringify(frame)}\n\n`,
    )
    .join('');
  return options.done === false ? body : `${body}data: [DONE]\n\n`;
}

export function sseResponse(
  frames: readonly unknown[],
  options: { readonly done?: boolean } = {},
): Response {
  return new Response(sseBody(frames, options), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

/** A `chat.completion.chunk` carrying a text delta. */
export function textChunk(
  text: string,
  model = 'test-model',
): Record<string, unknown> {
  return { model, choices: [{ index: 0, delta: { content: text } }] };
}

export function reasoningChunk(text: string): Record<string, unknown> {
  return { choices: [{ index: 0, delta: { reasoning_content: text } }] };
}

/** A tool-call fragment. Splitting `arguments` across chunks is the normal case. */
export function toolCallChunk(
  index: number,
  fragment: {
    readonly id?: string;
    readonly name?: string;
    readonly argumentsJson?: string;
  },
): Record<string, unknown> {
  return {
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            {
              index,
              ...(fragment.id === undefined ? {} : { id: fragment.id }),
              function: {
                ...(fragment.name === undefined ? {} : { name: fragment.name }),
                ...(fragment.argumentsJson === undefined
                  ? {}
                  : { arguments: fragment.argumentsJson }),
              },
            },
          ],
        },
      },
    ],
  };
}

export function finishChunk(reason = 'stop'): Record<string, unknown> {
  return { choices: [{ index: 0, delta: {}, finish_reason: reason }] };
}

/** The usage-only trailer `stream_options: {include_usage: true}` asks for. */
export function usageChunk(
  usage: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return { choices: [], usage };
}

/**
 * A stream that emits `frames`, then stalls until the request is aborted.
 *
 * The abort is wired to the stream rather than to the fetch call because that is
 * where it happens for real: headers have arrived, the response object exists,
 * and what the signal interrupts is the body still being read.
 */
export function hangingStream(frames: readonly unknown[]): ResponseHandler {
  return (url, init) => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(sseBody(frames, { done: false })));
        const signal = init.signal;
        if (signal === null || signal === undefined) return;
        const abort = (): void => {
          const error = new Error('The operation was aborted');
          error.name = 'AbortError';
          controller.error(error);
        };
        if (signal.aborted) abort();
        else signal.addEventListener('abort', abort, { once: true });
      },
    });
    return new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  };
}
