/**
 * The terminal as a device: how big it is, and what the keyboard just did.
 *
 * Nothing here draws. That separation is pi's and it is worth keeping: the
 * renderer decides what the screen should say, and this decides nothing at all —
 * it turns bytes into keys, puts the tty into raw mode, and puts it back.
 *
 * Raw mode is the part with teeth. With it on there is no echo and no line
 * discipline, so a process that dies without restoring it leaves a shell that
 * needs `stty sane`. Every path out of `stop` restores, `stop` is idempotent,
 * and the caller is expected to arrange for it to run from `process.on('exit')`
 * as well as from its own `finally`.
 */

import { parseKeys, type Key } from './keys.js';

const DEFAULT_COLUMNS = 80;
const DEFAULT_ROWS = 24;

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

/**
 * A stream's size, or a usable number.
 *
 * `output.columns ?? 80` is the obvious spelling and it is wrong: a stream can
 * report **zero**, which is not nullish, and every width then collapses to
 * nothing. It is not hypothetical — `script(1)` allocates a pty with no size, so
 * a session recorded with it would render a header of blank lines and a status
 * line consisting of one ellipsis. A terminal mid-resize can answer 0 as well.
 */
function sizeOf(reported: number | undefined, fallback: number): number {
  return reported !== undefined && reported > 0 ? reported : fallback;
}

/** How many columns wide the output is, treating 0 as "no idea". */
export function columnsOf(
  output: TerminalOutput,
  fallback: number = DEFAULT_COLUMNS,
): number {
  return sizeOf(output.columns, fallback);
}

/** How many rows tall the output is, treating 0 as "no idea". */
export function rowsOf(
  output: TerminalOutput,
  fallback: number = DEFAULT_ROWS,
): number {
  return sizeOf(output.rows, fallback);
}

interface KeyboardOptions {
  readonly input: TerminalInput;
  /**
   * Whether to take the tty out of line mode. Default: whenever it is one.
   *
   * `false` is what a test passes, and what a pipe gets: `setRawMode` does not
   * exist on a stream that is not a terminal.
   */
  readonly raw?: boolean;
}

interface Keyboard {
  /** Returns the unsubscribe. */
  onKey(handler: (key: Key) => void): () => void;
  /** Restores the tty and stops listening. Idempotent. */
  stop(): void;
}

export function openKeyboard(options: KeyboardOptions): Keyboard {
  const { input } = options;
  const handlers = new Set<(key: Key) => void>();
  let stopped = false;

  const onData = (chunk: unknown): void => {
    const data = Buffer.isBuffer(chunk)
      ? chunk.toString('utf8')
      : String(chunk);
    for (const key of parseKeys(data)) {
      // Copied before iterating: a handler is allowed to unsubscribe itself,
      // which is what closing a menu from inside its own key handler does.
      for (const handler of [...handlers]) handler(key);
    }
  };

  const raw = options.raw ?? input.isTTY === true;
  // Only a mode this turned on is turned off again — toggling it underneath
  // something else that set it is how a terminal ends up with no echo.
  const owned = raw && input.isRaw !== true && input.setRawMode !== undefined;
  if (owned) input.setRawMode?.(true);
  input.on('data', onData);
  input.resume();

  return {
    onKey(handler): () => void {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },

    stop(): void {
      if (stopped) return;
      stopped = true;
      handlers.clear();
      input.off('data', onData);
      input.pause();
      if (owned) input.setRawMode?.(false);
    },
  };
}
