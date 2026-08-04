/**
 * A status region that sits directly under whatever owns the input line.
 *
 * `Screen` draws *at* the cursor and moves back up; this draws *below* it and
 * leaves the cursor exactly where it found it, which is a different problem with
 * a different failure mode. Two decisions carry it:
 *
 *  - **Relative to the cursor, not to the bottom of the screen.** An earlier
 *    version addressed the last rows absolutely, and it painted over the prompt:
 *    reserving three rows guarantees three rows below the *cursor*, and then the
 *    prompt writes two more lines of its own, so the input line ends up inside
 *    the rows the bar is about to claim. Drawing from wherever the cursor is
 *    cannot make that mistake, and it puts the bar under the editor rather than
 *    at the foot of the window with a gap above it.
 *  - **The room is reserved before the prompt is written, and covers the prompt
 *    too.** `reserve` emits blank lines and steps back over them. At the bottom
 *    of the screen this scrolls, which is the point: everything below the cursor
 *    afterwards is blank, so nothing the bar writes can land on the transcript,
 *    and — because the reservation already absorbed the scroll — nothing the bar
 *    writes can scroll either. That is what keeps the surrounding save/restore
 *    valid, since a saved position is in screen coordinates and one scroll
 *    invalidates it.
 *
 * Why it repaints on every keystroke: readline's own line refresh clears from
 * the prompt row to the end of the display, which is exactly where the bar is.
 * There is no arrangement in which readline redraws the line and the bar
 * survives, so the bar is drawn after the refresh, every time.
 *
 * The one case it does not handle is an input long enough to wrap *and* a cursor
 * moved back into the middle of it: the bar would then draw over the rest of the
 * typed line. A prompt is one line of prose in almost every use, and the
 * alternative is reimplementing readline's own row arithmetic to find the end of
 * the input.
 */

import { truncateToWidth } from './text.js';
import { columnsOf, type TerminalOutput } from './screen.js';

/**
 * Written as escapes, never as bytes — a literal `0x1b` in a source file is
 * invisible in an editor and unsearchable with the tools everyone tries first.
 */
const ESC = '\u001b';
const CURSOR_UP = (rows: number): string => `${ESC}[${String(rows)}A`;
const CURSOR_RIGHT = (cols: number): string =>
  cols > 0 ? `${ESC}[${String(cols)}C` : '';
const ERASE_BELOW = `${ESC}[0J`;
const SYNC_ON = `${ESC}[?2026h`;
const SYNC_OFF = `${ESC}[?2026l`;

export interface BottomBarOptions {
  readonly output: TerminalOutput;
  /** Used when the stream reports none, as a recorded pty does. */
  readonly columns?: number | undefined;
  /** Synchronized output around each repaint. Default `true`. */
  readonly synchronized?: boolean;
}

export interface BottomBar {
  readonly columns: number;
  readonly available: boolean;
  /**
   * Pushes the transcript up so that `rows` blank rows follow the cursor.
   *
   * Must be called *before* whatever owns the input line writes its prompt, and
   * must count that prompt's own lines as well as the bar's — that arithmetic
   * is the caller's, because only the caller knows how tall its prompt is.
   */
  reserve(rows: number): void;
  /**
   * Draws the lines under the cursor, and puts the cursor back on `column`.
   *
   * The column is the caller's to supply because only it knows where its own
   * editor left the cursor — and because asking the terminal would mean a
   * round trip on every keystroke.
   */
  paint(lines: readonly string[], column: number): void;
  /** Erases from the cursor to the end of the display. */
  clear(): void;
  /** Erases and stops. Idempotent. */
  close(): void;
}

export function openBottomBar(options: BottomBarOptions): BottomBar {
  const { output } = options;
  const synchronized = options.synchronized !== false;

  let painted = 0;
  let closed = false;

  // Only the width matters. Drawing relative to the cursor needs no idea how
  // tall the window is, which is why a terminal that will not say — a pty
  // allocated by `script(1)` reports neither — still gets a status bar.
  const width = (): number => columnsOf(output, options.columns);

  const frame = (body: string): string =>
    synchronized ? `${SYNC_ON}${body}${SYNC_OFF}` : body;

  const bar: BottomBar = {
    get columns(): number {
      return width();
    },
    get available(): boolean {
      return !closed;
    },

    reserve(rows: number): void {
      if (closed || rows <= 0) return;
      output.write(`${'\n'.repeat(rows)}${CURSOR_UP(rows)}`);
    },

    paint(lines: readonly string[], column: number): void {
      if (closed) return;
      if (lines.length === 0) {
        bar.clear();
        return;
      }

      const columns = width();
      const body = lines
        .map((line) => truncateToWidth(line, columns))
        .join('\n');

      // One newline to step off the input row, then erase everything below —
      // which is only ever the previous bar, because `reserve` made sure of it.
      // Coming back is `CURSOR_UP` by exactly the rows just written, then the
      // column: both are *relative*, and that is the whole point. A saved
      // position is in screen coordinates, so a single scroll invalidates it —
      // and an input long enough to wrap past what was reserved makes the
      // newline above scroll. Relative motion moves with the screen instead,
      // which turns "the typed line grew" from corruption into one scroll.
      output.write(
        frame(
          `\n${ERASE_BELOW}${body}${CURSOR_UP(lines.length)}\r${CURSOR_RIGHT(column)}`,
        ),
      );
      painted = lines.length;
    },

    /**
     * Erases from wherever the cursor is, without stepping down first.
     *
     * That is deliberate and it is the difference between the two call sites.
     * On Return, readline has already written `\r\n` and the cursor is sitting
     * on the bar's first row — stepping down again would leave that row behind,
     * and the turn's output would then be printed underneath a stale rule.
     */
    clear(): void {
      if (closed || painted === 0) return;
      // Back to column zero first, so the erase takes the whole row rather than
      // the part of it to the right of wherever the cursor happened to be. It
      // is only ever called with the cursor on the bar's own first row, so
      // there is nothing to the left of it worth keeping.
      output.write(frame(`\r${ERASE_BELOW}`));
      painted = 0;
    },

    close(): void {
      if (closed) return;
      bar.clear();
      closed = true;
    },
  };

  return bar;
}
