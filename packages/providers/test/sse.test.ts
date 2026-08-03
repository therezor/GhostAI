import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { isProviderError } from '#src/errors.js';
import { MAX_SSE_FRAME_CHARS, parseSse, readByteStream, type SseEvent } from '#src/sse.js';

const encoder = new TextEncoder();

/** A stream delivered in the exact chunks given, to control frame boundaries. */
async function* chunks(...parts: readonly (string | Uint8Array)[]): AsyncGenerator<Uint8Array> {
  for (const part of parts) yield typeof part === 'string' ? encoder.encode(part) : part;
}

async function collect(source: AsyncIterable<Uint8Array>): Promise<SseEvent[]> {
  const events: SseEvent[] = [];
  for await (const event of parseSse(source)) events.push(event);
  return events;
}

describe('parseSse', () => {
  it('reads a simple frame', async () => {
    expect(await collect(chunks('data: hello\n\n'))).toEqual([{ event: 'message', data: 'hello' }]);
  });

  it('joins multiple data lines with a newline', async () => {
    // Keeping only the last line is the classic bug here, and it silently
    // deletes content from any provider that emits multi-line frames.
    expect(await collect(chunks('data: one\ndata: two\n\n'))).toEqual([
      { event: 'message', data: 'one\ntwo' },
    ]);
  });

  it('strips exactly one space after the colon', async () => {
    expect(await collect(chunks('data:  indented\n\n'))).toEqual([
      { event: 'message', data: ' indented' },
    ]);
    expect(await collect(chunks('data:none\n\n'))).toEqual([{ event: 'message', data: 'none' }]);
  });

  it('accepts CRLF and bare CR terminators', async () => {
    expect(await collect(chunks('data: a\r\n\r\n'))).toEqual([{ event: 'message', data: 'a' }]);
    expect(await collect(chunks('data: b\r\r'))).toEqual([{ event: 'message', data: 'b' }]);
  });

  it('carries the event name and resets it per frame', async () => {
    expect(await collect(chunks('event: ping\ndata: 1\n\ndata: 2\n\n'))).toEqual([
      { event: 'ping', data: '1' },
      { event: 'message', data: '2' },
    ]);
  });

  it('ignores comments, and the fields that govern reconnection', async () => {
    expect(await collect(chunks(': keep-alive\n\nid: 7\nretry: 100\ndata: x\n\n'))).toEqual([
      { event: 'message', data: 'x' },
    ]);
  });

  it('ignores a blank frame with no data', async () => {
    expect(await collect(chunks('\n\n\n'))).toEqual([]);
  });

  it('reassembles a frame split across chunk boundaries', async () => {
    expect(await collect(chunks('da', 'ta: hel', 'lo\n', '\ndata: more\n\n'))).toEqual([
      { event: 'message', data: 'hello' },
      { event: 'message', data: 'more' },
    ]);
  });

  it('reassembles a multi-byte character split across chunks', async () => {
    const bytes = encoder.encode('data: café\n\n');
    // Cut inside the two-byte é. A decoder without `stream: true` yields U+FFFD.
    const split = bytes.indexOf(0xc3) + 1;
    expect(await collect(chunks(bytes.slice(0, split), bytes.slice(split)))).toEqual([
      { event: 'message', data: 'café' },
    ]);
  });

  it('emits a final frame that arrived without its blank line', async () => {
    // Several providers close the socket straight after `[DONE]`; discarding
    // the frame would drop the terminator the adapter waits for.
    expect(await collect(chunks('data: [DONE]'))).toEqual([{ event: 'message', data: '[DONE]' }]);
  });

  it('refuses a frame that never terminates', async () => {
    const flood = chunks(`data: ${'x'.repeat(MAX_SSE_FRAME_CHARS + 1)}`);
    await expect(collect(flood)).rejects.toSatisfy(
      (error: unknown) => isProviderError(error) && error.reason === 'stream_parse',
    );
  });

  it('honours a lowered frame cap', async () => {
    const source = chunks(`data: ${'x'.repeat(200)}`);
    const drain = async (): Promise<void> => {
      for await (const _event of parseSse(source, { maxFrameChars: 64, providerId: 'test' }))
        void _event;
    };
    await expect(drain()).rejects.toThrow(/exceeded 64 characters/);
  });

  it('never loses or reorders data, however the bytes are cut up', async () => {
    // The property that matters: framing is a function of the byte sequence,
    // not of how the transport happened to chunk it.
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.stringMatching(/^[a-z0-9 ]{1,20}$/), { minLength: 1, maxLength: 6 }),
        fc.array(fc.integer({ min: 1, max: 12 }), { minLength: 1, maxLength: 8 }),
        async (payloads, cuts) => {
          const text = payloads.map((payload) => `data: ${payload}\n\n`).join('');
          const parts: string[] = [];
          let offset = 0;
          let index = 0;
          while (offset < text.length) {
            const size = cuts[index % cuts.length] ?? 1;
            parts.push(text.slice(offset, offset + size));
            offset += size;
            index += 1;
          }
          const events = await collect(chunks(...parts));
          expect(events.map((event) => event.data)).toEqual(payloads);
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe('readByteStream', () => {
  it('yields the chunks a ReadableStream produces', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('a'));
        controller.enqueue(encoder.encode('b'));
        controller.close();
      },
    });
    const seen: string[] = [];
    for await (const chunk of readByteStream(stream)) seen.push(new TextDecoder().decode(chunk));
    expect(seen).toEqual(['a', 'b']);
  });

  it('cancels the underlying stream when the consumer stops early', async () => {
    // The Stop button: the socket must be released rather than left to the
    // garbage collector holding a file descriptor.
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('first'));
      },
      cancel() {
        cancelled = true;
      },
    });

    for await (const _chunk of readByteStream(stream)) break;
    expect(cancelled).toBe(true);
  });

  it('propagates a stream error', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error('connection reset'));
      },
    });
    const drain = async (): Promise<void> => {
      for await (const _chunk of readByteStream(stream)) void _chunk;
    };
    await expect(drain()).rejects.toThrow(/connection reset/);
  });
});
