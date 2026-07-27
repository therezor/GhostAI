/**
 * A server-sent-events reader.
 *
 * Written rather than depended upon because the event stream is where a
 * provider's response is least trustworthy. A proxy in front of a model server
 * can terminate the connection mid-event, a local server can emit a plain JSON
 * error body with an `text/event-stream` content type, and either produces a
 * partial frame that a permissive parser silently turns into a truncated answer.
 * Here that is a typed `stream_parse` error, which `withResilience` knows to
 * retry as a non-streaming request.
 *
 * Three details of the spec are load-bearing:
 *
 *  - **Multiple `data:` lines in one event join with `\n`.** Dropping all but
 *    the last is the classic bug; it silently deletes content in any provider
 *    that emits multi-line frames.
 *  - **A single leading space after the colon is part of the syntax**, not the
 *    payload. Stripping the whole leading run corrupts indented JSON.
 *  - **`\r\n`, `\n` and a bare `\r` are all line terminators.** Providers behind
 *    a Windows proxy do send `\r\n`, and a parser that splits on `\n` alone
 *    leaves a `\r` at the end of every JSON payload.
 */

import { ProviderError } from './errors.js';

export interface SseEvent {
  /** The `event:` field, or `message` when the stream omitted one. */
  readonly event: string;
  /** All `data:` lines of this frame, joined with newlines. */
  readonly data: string;
}

/**
 * The cap on one unterminated frame.
 *
 * A response that never sends a line terminator would otherwise grow the buffer
 * until the process dies. 1 MiB is far past any legitimate SSE frame — a full
 * non-streaming completion is smaller than that.
 */
export const MAX_SSE_FRAME_CHARS = 1_048_576;

export interface ParseSseOptions {
  readonly providerId?: string | undefined;
  readonly maxFrameChars?: number | undefined;
}

/**
 * Reads a byte stream as SSE frames.
 *
 * Iterating the `ReadableStream` through an explicit reader rather than
 * `for await` so that the `finally` can cancel it: when the consumer stops early
 * — a Stop button mid-answer — the generator's `return()` runs this cleanup and
 * the socket is released instead of being left to the garbage collector.
 */
export async function* readByteStream(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<Uint8Array, void, undefined> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
    // The stream may already be errored or closed; cancelling then is a no-op
    // that rejects, and there is nothing useful to do about it here.
    await reader.cancel().catch(() => undefined);
  }
}

export async function* parseSse(
  source: AsyncIterable<Uint8Array>,
  options: ParseSseOptions = {},
): AsyncGenerator<SseEvent, void, undefined> {
  const maxFrameChars = options.maxFrameChars ?? MAX_SSE_FRAME_CHARS;
  // `fatal: false` — a chunk boundary can split a multi-byte character, and
  // `stream: true` handles that; anything genuinely malformed becomes U+FFFD
  // rather than throwing, because a mangled byte in prose must not lose the turn.
  const decoder = new TextDecoder('utf-8');

  let buffer = '';
  let dataLines: string[] = [];
  let eventName = '';

  const frame = (): SseEvent | null => {
    if (dataLines.length === 0) {
      eventName = '';
      return null;
    }
    const event: SseEvent = {
      event: eventName === '' ? 'message' : eventName,
      data: dataLines.join('\n'),
    };
    dataLines = [];
    eventName = '';
    return event;
  };

  const consume = (line: string): void => {
    // A leading colon marks a comment. Providers use them as keep-alives.
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);

    if (field === 'data') dataLines.push(value);
    else if (field === 'event') eventName = value;
    // `id` and `retry` govern reconnection, which never applies: a resumed
    // completion would duplicate tokens, so a broken stream is an error here.
  };

  for await (const chunk of source) {
    buffer += decoder.decode(chunk, { stream: true });

    for (;;) {
      const match = /\r\n|\n|\r/.exec(buffer);
      if (match === null) break;
      const line = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);

      if (line === '') {
        const event = frame();
        if (event !== null) yield event;
      } else {
        consume(line);
      }
    }

    if (buffer.length > maxFrameChars) {
      throw new ProviderError(
        'stream_parse',
        `Event stream frame exceeded ${String(maxFrameChars)} characters`,
        {
          providerId: options.providerId,
        },
      );
    }
  }

  buffer += decoder.decode();
  // A stream that ends without its final blank line is common enough — several
  // providers close the socket right after `data: [DONE]` — that discarding the
  // frame would drop the terminator the adapter is waiting for.
  if (buffer !== '') consume(buffer);
  const trailing = frame();
  if (trailing !== null) yield trailing;
}
