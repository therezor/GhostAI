/**
 * A terminal that exists entirely in memory.
 *
 * Everything `Screen` and `select` need from a real one, and nothing else: a
 * readable half to push key bytes into, a writable half that accumulates what
 * was drawn, a size, and a `setRawMode` that records whether it was called. No
 * pty, no child process, no timing.
 *
 * This is what makes the escape-sequence assertions durable rather than
 * transient. A test does not look at a screen and hope the repaint has landed —
 * it reads back the bytes a completed `paint` emitted, which are the same bytes
 * whether the machine is fast or slow.
 */

import { PassThrough } from 'node:stream';

import type { TerminalInput, TerminalOutput } from '#src/screen.js';

export interface FakeInput extends TerminalInput {
  /** Every `setRawMode` call, in order. */
  readonly rawModeCalls: boolean[];
  isRaw: boolean;
  /** Pushes bytes as if the user had typed them. */
  type(data: string): void;
}

export interface FakeOutput extends TerminalOutput {
  /** Everything written, concatenated. */
  readonly text: string;
  columns: number;
  rows: number;
  /** Forgets what was written, so an assertion can name one repaint. */
  reset(): void;
  /** Changes the size and emits `resize`, the way a real terminal does. */
  resizeTo(columns: number, rows: number): void;
}

export function fakeInput(options: { isTTY?: boolean } = {}): FakeInput {
  const stream = new PassThrough();
  const calls: boolean[] = [];

  return Object.assign(stream, {
    isTTY: options.isTTY ?? true,
    isRaw: false,
    rawModeCalls: calls,
    setRawMode(mode: boolean): void {
      calls.push(mode);
      // Mirrors the real stream, so `Screen`'s "only turn off a mode I turned
      // on" check is exercised rather than assumed.
      (stream as unknown as { isRaw: boolean }).isRaw = mode;
    },
    type(data: string): void {
      stream.write(data);
    },
  });
}

export function fakeOutput(
  options: { columns?: number; rows?: number; isTTY?: boolean } = {},
): FakeOutput {
  const stream = new PassThrough();
  let text = '';

  const out = Object.assign(stream, {
    // Captured in `write` rather than from a `data` listener, which fires on a
    // later tick: a test that asserts on the bytes of a *completed* paint has
    // to be able to read them on the line after the call, or the assertion
    // becomes a race and stops being worth making.
    write(chunk: unknown): boolean {
      text += String(chunk);
      return true;
    },
    isTTY: options.isTTY ?? true,
    columns: options.columns ?? 40,
    rows: options.rows ?? 24,
    reset(): void {
      text = '';
    },
    resizeTo(columns: number, rows: number): void {
      out.columns = columns;
      out.rows = rows;
      stream.emit('resize');
    },
  }) as unknown as FakeOutput;

  // Defined rather than assigned: `Object.assign` reads a getter on the source
  // and copies the *value* it returned, so `text` would be frozen at the empty
  // string it held when the object was built.
  Object.defineProperty(out, 'text', {
    get: (): string => text,
  });

  return out;
}

/**
 * Lets the stream deliver what was just typed.
 *
 * One macrotask, not a poll for stillness: `Screen`'s data handler is
 * synchronous and `select`'s key handler paints and returns without awaiting
 * anything, so there is exactly one hop to wait for and no race to settle.
 */
export async function flush(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}
