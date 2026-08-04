/**
 * A status region pinned to the last rows of the screen.
 *
 * `Screen` draws *at* the cursor and moves back up; a status bar has to draw
 * *below* it and leave the cursor exactly where it found it, which is a
 * different problem with a different failure mode. Two decisions make it
 * tractable:
 *
 *  - **Absolute addressing, never `\n`.** The bar jumps to a known row with CUP,
 *    erases to the end of the display and writes its lines — and the last line
 *    carries no trailing newline. Nothing it writes can scroll the screen, which
 *    is what makes the surrounding save/restore of the cursor position valid: a
 *    saved position is in *screen* coordinates, and one scroll invalidates it.
 *  - **The room is reserved before the prompt is drawn, not while it is.**
 *    `reserve` emits blank lines and steps back over them, so the prompt lands
 *    with the bar's rows already below it. A transcript grows, so the prompt
 *    keeps arriving at the bottom of the screen and the reservation has to be
 *    made again each time round the loop — which is cheap, and which is why it
 *    is a separate call rather than something `paint` guesses at.
 *
 * Why it repaints on every keystroke: readline's own line refresh clears from
 * the prompt row to the end of the display, which is exactly where the bar is.
 * There is no arrangement in which readline redraws the line and the bar
 * survives, so the bar is drawn *after* the refresh, every time.
 *
 * A terminal that will not say how tall it is gets no bar at all. Guessing 24
 * rows and addressing row 22 on a window with 60 would paint the status into the
 * middle of the transcript, which is worse than not having one.
 */

import { truncateToWidth } from './text.js';
import { columnsOf, rowsOf, type TerminalOutput } from './screen.js';

/**
 * Written as escapes, never as bytes — a literal `0x1b` in a source file is
 * invisible in an editor and unsearchable with the tools everyone tries first.
 */
const ESC = '\u001b';
/** DECSC/DECRC: save and restore the cursor, including its column. */
const SAVE_CURSOR = `${ESC}7`;
const RESTORE_CURSOR = `${ESC}8`;
const CURSOR_UP = (rows: number): string => `${ESC}[${String(rows)}A`;
/** Absolute cursor position, 1-based. */
const CURSOR_TO_ROW = (row: number): string => `${ESC}[${String(row)};1H`;
const ERASE_BELOW = `${ESC}[0J`;
const SYNC_ON = `${ESC}[?2026h`;
const SYNC_OFF = `${ESC}[?2026l`;

export interface BottomBarOptions {
  readonly output: TerminalOutput;
  /** Used when the stream reports none. */
  readonly columns?: number | undefined;
  readonly rows?: number | undefined;
  /** Synchronized output around each repaint. Default `true`. */
  readonly synchronized?: boolean;
}

export interface BottomBar {
  readonly columns: number;
  /** `false` when the terminal will not say how tall it is. */
  readonly available: boolean;
  /**
   * Pushes the transcript up so a prompt drawn *next* has `height` rows beneath
   * it. Must be called before whatever owns the input line writes anything.
   */
  reserve(height: number): void;
  /** Draws the lines across the bottom rows, leaving the cursor where it was. */
  paint(lines: readonly string[]): void;
  /** Erases them. */
  clear(): void;
  /** Erases and stops. Idempotent. */
  close(): void;
}

export function openBottomBar(options: BottomBarOptions): BottomBar {
  const { output } = options;
  const synchronized = options.synchronized !== false;

  let painted = 0;
  let closed = false;

  const width = (): number => columnsOf(output, options.columns ?? 0);
  const height = (): number => rowsOf(output, options.rows ?? 0);
  // `0` is the fallback above, so an unknown size stays unknown here rather
  // than becoming a confident 80×24 the bar would then address rows in.
  const available = (): boolean => !closed && width() > 0 && height() > 0;

  const frame = (body: string): string =>
    synchronized ? `${SYNC_ON}${body}${SYNC_OFF}` : body;

  const bar: BottomBar = {
    get columns(): number {
      return width();
    },
    get available(): boolean {
      return available();
    },

    reserve(rows: number): void {
      if (!available() || rows <= 0) return;
      // Blank lines, then back over them. At the bottom of the screen this
      // scrolls once — which is the point — and everywhere else it is invisible.
      output.write(`${'\n'.repeat(rows)}${CURSOR_UP(rows)}`);
    },

    paint(lines: readonly string[]): void {
      if (!available()) return;
      if (lines.length === 0) {
        bar.clear();
        return;
      }

      const columns = width();
      const rows = height();
      const body = lines
        .slice(-rows)
        .map((line) => truncateToWidth(line, columns))
        .join('\n');

      output.write(
        frame(
          `${SAVE_CURSOR}${CURSOR_TO_ROW(rows - lines.length + 1)}${ERASE_BELOW}${body}${RESTORE_CURSOR}`,
        ),
      );
      painted = lines.length;
    },

    clear(): void {
      if (!available() || painted === 0) return;
      const rows = height();
      output.write(
        frame(
          `${SAVE_CURSOR}${CURSOR_TO_ROW(rows - painted + 1)}${ERASE_BELOW}${RESTORE_CURSOR}`,
        ),
      );
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
