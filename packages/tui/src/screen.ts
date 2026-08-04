/**
 * A block of lines that repaints in place, and erases itself when it is done.
 *
 * Deliberately not an alternate-screen framework. The CLI's whole output model
 * is a transcript in the scrollback — `TurnRenderer` streams assistant text into
 * it and a human scrolls back through it afterwards — and switching to the
 * alternate screen to show a menu would throw that away for the duration and
 * flash the terminal twice. What a menu actually needs is a handful of lines
 * below the prompt that can be redrawn on every keystroke and then removed, and
 * that is all this is.
 *
 * The arithmetic is the whole of it. After painting N lines the cursor sits at
 * the end of the last one, so getting back to the first is `CUU` by N-1; erasing
 * from there to the end of the display and rewriting is one frame. **Every line
 * is truncated to `columns` before it is written**, because a line that wraps
 * occupies two rows instead of one, the cursor-up then stops a row short, and
 * the leftover row stays in the scrollback forever. That is why `text.ts`
 * exists, and it is the single invariant this file depends on.
 *
 * Two seams keep it honest:
 *
 *  - **`handover` rather than an import of `node:readline`.** Something else
 *    already owns stdin — in the CLI, a readline `Interface` in the middle of a
 *    pending `question`. This file knows only that a caller can take it away and
 *    give it back; what that means is `menu.ts`'s problem. Without the seam this
 *    package would have to know what a REPL is.
 *  - **Raw mode is entered only if nobody else has.** readline sets it already,
 *    and toggling it underneath readline is how a terminal ends up with no echo
 *    after the process exits. `isRaw` is checked, and only a mode this file
 *    turned on is turned off again.
 */

import { parseKeys, type Key } from './keys.js';
import { truncateToWidth } from './text.js';

/**
 * Written as escapes, never as bytes: a literal `0x1b` in a source file is
 * invisible in an editor and unsearchable with the tools everyone tries first.
 */
const ESC = '\u001b';
const CURSOR_UP = (rows: number): string => `${ESC}[${String(rows)}A`;
/** Erase from the cursor to the end of the display. */
const ERASE_BELOW = `${ESC}[0J`;
/**
 * DEC mode 2026: hold the frame until it is complete.
 *
 * A terminal that does not know the mode ignores it, which is why it is safe to
 * send unconditionally; one that does knows not to show a half-drawn menu.
 */
const SYNC_ON = `${ESC}[?2026h`;
const SYNC_OFF = `${ESC}[?2026l`;

const DEFAULT_COLUMNS = 80;
const DEFAULT_ROWS = 24;

/**
 * A stream's size, or a usable number.
 *
 * `output.columns ?? 80` is the obvious spelling and it is wrong: a stream can
 * report **zero**, which is not nullish, and every width then collapses to
 * nothing. It is not hypothetical — `script(1)` allocates a pty with no size, so
 * a session recorded with it would render a header of blank lines and a status
 * line consisting of one ellipsis. A terminal mid-resize can answer 0 as well.
 *
 * So the rule is "a positive number, or the fallback", and it lives here rather
 * than at each call site because there is more than one call site.
 */
function sizeOf(
  reported: number | undefined,
  asked: number | undefined,
  fallback: number,
): number {
  if (reported !== undefined && reported > 0) return reported;
  if (asked !== undefined && asked > 0) return asked;
  return fallback;
}

/** How many columns wide the output is, treating 0 as "no idea". */
export function columnsOf(
  output: TerminalOutput,
  fallback: number = DEFAULT_COLUMNS,
): number {
  return sizeOf(output.columns, undefined, fallback);
}

/** How many rows tall the output is, treating 0 as "no idea". */
export function rowsOf(
  output: TerminalOutput,
  fallback: number = DEFAULT_ROWS,
): number {
  return sizeOf(output.rows, undefined, fallback);
}

export interface TerminalOutput extends NodeJS.WritableStream {
  readonly columns?: number | undefined;
  readonly rows?: number | undefined;
  readonly isTTY?: boolean | undefined;
}

export interface TerminalInput extends NodeJS.ReadableStream {
  readonly isTTY?: boolean | undefined;
  readonly isRaw?: boolean | undefined;
  setRawMode?: ((mode: boolean) => unknown) | undefined;
}

/** Whoever owned stdin, and how to give it back. */
export interface InputHandover {
  readonly release: () => void;
}

export interface ScreenOptions {
  readonly input: TerminalInput;
  readonly output: TerminalOutput;
  /**
   * Detaches the current owner of stdin. Called on open, `release` on close.
   *
   * Absent when nothing else is reading — a one-shot, or a test.
   */
  readonly handover?: (() => InputHandover) | undefined;
  /** Used when the stream reports none, as a pipe does. */
  readonly columns?: number | undefined;
  readonly rows?: number | undefined;
  /** Synchronized output around each repaint. Default `true`. */
  readonly synchronized?: boolean;
}

export interface Screen {
  readonly columns: number;
  readonly rows: number;
  /** Repaints the region. Each line is truncated to `columns`. */
  paint(lines: readonly string[]): void;
  /** Erases the region and forgets its height. */
  clear(): void;
  /** Returns the unsubscribe. */
  onKey(handler: (key: Key) => void): () => void;
  /** Returns the unsubscribe. */
  onResize(handler: () => void): () => void;
  /** Erases, restores raw mode, releases the handover. Idempotent. */
  close(): void;
}

export function openScreen(options: ScreenOptions): Screen {
  const { input, output } = options;
  const synchronized = options.synchronized !== false;

  const keyHandlers = new Set<(key: Key) => void>();
  const resizeHandlers = new Set<() => void>();
  let painted = 0;
  let closed = false;

  const onData = (chunk: unknown): void => {
    const data = Buffer.isBuffer(chunk)
      ? chunk.toString('utf8')
      : String(chunk);
    for (const key of parseKeys(data)) {
      // A copy, so a handler that unsubscribes itself mid-dispatch does not
      // mutate the set being iterated.
      for (const handler of [...keyHandlers]) handler(key);
    }
  };

  const onResize = (): void => {
    for (const handler of [...resizeHandlers]) handler();
  };

  const handover = options.handover?.();

  // Only a mode this call turned on is turned off again. readline has usually
  // set it already, and toggling it underneath readline is how a shell ends up
  // with no echo after the process exits.
  const ownsRawMode = input.isTTY === true && input.isRaw !== true;
  if (ownsRawMode) input.setRawMode?.(true);

  input.on('data', onData);
  output.on('resize', onResize);
  input.resume();

  const width = (): number =>
    sizeOf(output.columns, options.columns, DEFAULT_COLUMNS);
  const height = (): number => sizeOf(output.rows, options.rows, DEFAULT_ROWS);

  const erase = (): string =>
    painted > 1
      ? `${CURSOR_UP(painted - 1)}\r${ERASE_BELOW}`
      : `\r${ERASE_BELOW}`;

  const frame = (body: string): string =>
    synchronized ? `${SYNC_ON}${body}${SYNC_OFF}` : body;

  const screen: Screen = {
    get columns(): number {
      return width();
    },
    get rows(): number {
      return height();
    },

    paint(lines: readonly string[]): void {
      if (closed) return;
      const columns = width();
      const rows = lines.map((line) => truncateToWidth(line, columns));
      output.write(frame(`${erase()}${rows.join('\n')}`));
      painted = rows.length;
    },

    clear(): void {
      if (closed || painted === 0) return;
      output.write(frame(erase()));
      painted = 0;
    },

    onKey(handler: (key: Key) => void): () => void {
      keyHandlers.add(handler);
      return () => keyHandlers.delete(handler);
    },

    onResize(handler: () => void): () => void {
      resizeHandlers.add(handler);
      return () => resizeHandlers.delete(handler);
    },

    close(): void {
      if (closed) return;
      screen.clear();
      closed = true;
      input.off('data', onData);
      output.off('resize', onResize);
      input.pause();
      if (ownsRawMode) input.setRawMode?.(false);
      handover?.release();
    },
  };

  return screen;
}
