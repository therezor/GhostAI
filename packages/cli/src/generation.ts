/**
 * What the terminal looks like while a turn is running.
 *
 * The answer streams into the transcript, and the editor and the status stay
 * where they were — so the frame never disappears and the operator can start
 * writing the next message before this one has finished.
 *
 * Three things make that work, and each of them is the reason for one of the
 * others:
 *
 *  - **readline is suspended for the duration.** It has to be: it would echo
 *    every keystroke onto a line it believes is at a row the streaming output
 *    has long since scrolled past. So the keys are read here instead, by a
 *    deliberately small editor — printable characters, backspace, Return,
 *    Ctrl-C. It is not a line editor and does not try to be one; the idle
 *    prompt is still readline's, with its history and its bindings intact.
 *  - **Ctrl-C is read as a byte.** In raw mode the terminal stops turning it
 *    into SIGINT, and readline — which would otherwise have raised one — is not
 *    listening. Without this, interrupting a long turn would stop working
 *    exactly while a turn was long.
 *  - **Every write goes through the footer.** `TurnRenderer` is untouched and
 *    knows nothing about any of this; the CLI hands it a sink, and the sink
 *    erases the footer, writes, and draws the footer again below wherever the
 *    text ended.
 *
 * A message typed during a turn is queued, not steered: it runs as the next
 * turn the moment this one finishes. Steering is a real feature with real
 * semantics — the runtime has a queue for it — and "the thing I typed happened
 * next" is the one that needs no explaining.
 */

import type { InputHandover, Theme } from '@ghostai/tui';
import {
  dropLastGrapheme,
  isCtrl,
  parseKeys,
  spinnerFrame,
} from '@ghostai/tui';

import type { CliT } from './i18n.js';

/** The footer, and the cursor keys that reach it, for one turn. */
export interface Generation {
  /**
   * Runs the turn with the footer up.
   *
   * Restores everything on the way out, including when the body throws.
   */
  run<T>(body: () => Promise<T>): Promise<T>;
  /** Whatever was typed and submitted while the last turn ran. */
  takeQueued(): string | undefined;
  /**
   * Whatever was typed and *not* submitted.
   *
   * Handed back so the prompt that opens next can be pre-filled with it. A
   * half-written message is not a message; throwing it away because the answer
   * arrived is the rudest thing this could do.
   */
  takePartial(): string | undefined;
}

/** A footer that draws nothing. What a pipe and `--json` get. */
export const NO_GENERATION: Generation = {
  async run<T>(body: () => Promise<T>): Promise<T> {
    return await body();
  },
  takeQueued: () => undefined,
  takePartial: () => undefined,
};

export interface GenerationOptions {
  readonly input: NodeJS.ReadableStream;
  /** Draws the footer. Supplied rather than imported: see `menu.ts`. */
  readonly bar: {
    writeAbove(text: string, lines: readonly string[]): void;
    repaint(lines: readonly string[]): void;
    setCursorVisible(visible: boolean): void;
    clear(): void;
  };
  /** Takes stdin from whoever owns it, and gives it back. */
  readonly suspend: () => InputHandover;
  /** The rule above the editor, which the idle prompt draws for itself. */
  readonly inputRule: () => string;
  /** The rows under the editor, rebuilt as the turn changes them. */
  readonly status: () => string[];
  /** Where `TurnRenderer`'s writes are routed for the duration. */
  readonly setSink: (sink: ((text: string) => void) | undefined) => void;
  /** Ctrl-C, which raw mode delivers as a byte rather than a signal. */
  readonly interrupt: () => void;
  readonly theme: Theme;
  readonly t: CliT;
  /**
   * Advances the spinner. Injected so a test drives the animation by hand
   * rather than by waiting, and so nothing here holds the process open.
   */
  readonly ticker: (tick: () => void) => () => void;
}

/**
 * Blank once the first output has arrived — it answers "has it started".
 *
 * The wording is the web UI's: it shows "Thinking…" under exactly this
 * condition, a turn that is streaming and has produced no parts yet. Two
 * surfaces of one product disagreeing about what the wait is called is a small
 * thing that costs a reader a moment every time.
 */
function spinnerLines(
  tick: number | undefined,
  theme: Theme,
  t: CliT,
): string[] {
  if (tick === undefined) return [];
  return [theme.dim(`${spinnerFrame(tick)} ${t('chat.generating')}`)];
}

export function createGeneration(options: GenerationOptions): Generation {
  const { bar, theme, t } = options;
  let queued: string | undefined;
  let partial: string | undefined;

  return {
    takeQueued(): string | undefined {
      const held = queued;
      queued = undefined;
      return held;
    },

    takePartial(): string | undefined {
      const held = partial;
      partial = undefined;
      return held;
    },

    async run<T>(body: () => Promise<T>): Promise<T> {
      let typed = '';
      // `undefined` once anything has been written: the indicator answers "has
      // it started", and once it has, the answer itself is the better sign.
      let tick: number | undefined = 0;

      // The same frame the idle prompt has, drawn entirely from here: the rule
      // above the editor is the prompt's own when readline holds it, and this
      // one's while a turn runs.
      const footer = (): string[] => [
        ...spinnerLines(tick, theme, t),
        '',
        options.inputRule(),
        `› ${typed}`,
        ...options.status(),
      ];

      const draw = (): void => {
        bar.repaint(footer());
      };

      const write = (text: string): void => {
        // The first word is what the cursor was waiting for: from here it
        // trails the answer, which is where a reader expects to find it.
        tick = undefined;
        bar.setCursorVisible(true);
        bar.writeAbove(text, footer());
      };

      const onData = (chunk: unknown): void => {
        const data = Buffer.isBuffer(chunk)
          ? chunk.toString('utf8')
          : String(chunk);

        for (const key of parseKeys(data)) {
          if (isCtrl(key, 'c')) {
            options.interrupt();
            continue;
          }
          if (key.name === 'enter') {
            const message = typed.trim();
            if (message !== '') queued = message;
            typed = '';
            continue;
          }
          if (key.name === 'backspace') {
            typed = dropLastGrapheme(typed);
            continue;
          }
          if (key.name === 'char' && !key.ctrl && !key.meta) typed += key.char;
        }
        draw();
      };

      const handover = options.suspend();
      options.input.on('data', onData);
      options.input.resume();
      options.setSink(write);
      // Nothing to point at until the answer starts: the cursor would otherwise
      // sit on the blank row above the indicator, reading as a block beside it.
      bar.setCursorVisible(false);
      const stopTicking = options.ticker(() => {
        if (tick === undefined) return;
        tick += 1;
        draw();
      });

      draw();
      try {
        return await body();
      } finally {
        stopTicking();
        bar.setCursorVisible(true);
        options.setSink(undefined);
        options.input.off('data', onData);
        options.input.pause();
        bar.clear();
        handover.release();
        partial = typed === '' ? undefined : typed;
      }
    },
  };
}
