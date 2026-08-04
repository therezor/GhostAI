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

import { truncateToWidth, visibleWidth } from './text.js';
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
/** DECTCEM: the terminal's own cursor, hidden and shown. */
const HIDE_CURSOR = `${ESC}[?25l`;
const SHOW_CURSOR = `${ESC}[?25h`;
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
  /**
   * Writes text into the transcript *above* the footer, and redraws it.
   *
   * This is what lets a turn stream while the editor and the status stay put.
   * The order matters and is not the obvious one: the footer has to be erased
   * *before* the text is written, not after. Writing first and erasing after
   * leaves whatever of the footer sat to the right of the new text on its row —
   * a rule with two words of an answer printed over its first columns.
   *
   * The column the transcript left off at is tracked here rather than asked
   * for, because a streamed answer arrives in fragments that mostly do not end
   * on a line break, and only this knows where the last one stopped.
   */
  writeAbove(text: string, lines: readonly string[]): void;
  /**
   * Redraws the footer without moving the transcript's cursor.
   *
   * The column comes from what `writeAbove` last wrote, which is the only thing
   * that knows it — a streamed answer mostly does not end on a line break, and
   * repainting to column zero would put the next fragment at the start of the
   * row rather than after the words already on it.
   */
  repaint(lines: readonly string[]): void;
  /**
   * Steps back `rows` and erases everything from there down.
   *
   * For taking down a whole prompt block — the rule above the editor, the
   * caret and the echoed line — so the caller can print the message into the
   * transcript in its own words. Relative, like everything else here, so a
   * scroll between the measurement and the erase cannot move it.
   */
  eraseBlock(rows: number): void;
  /**
   * Hides or shows the terminal's own cursor.
   *
   * For the stretch where there is nothing to point at: while a turn is waiting
   * to say its first word, the cursor sits on the blank row above the indicator
   * and reads as a stray block beside it. It comes back the moment there is
   * text for it to trail.
   *
   * `close` restores it unconditionally, and a caller that can crash should
   * arrange for `close` to run — a terminal left with no cursor is the same
   * class of damage as one left in raw mode.
   */
  setCursorVisible(visible: boolean): void;
  /** Erases from the cursor to the end of the display. */
  clear(): void;
  /** Erases and stops. Idempotent. */
  close(): void;
}

/**
 * Where the cursor ends up after `text` is written starting at `column`.
 *
 * Counted in display columns and wrapped at the window width, because a line
 * long enough to wrap leaves the cursor part way along a later row rather than
 * far off the right of the first one — and the number is only ever used to put
 * the cursor back.
 */
function advance(column: number, text: string, columns: number): number {
  const at = text.lastIndexOf('\n');
  const width =
    at < 0 ? column + visibleWidth(text) : visibleWidth(text.slice(at + 1));
  return columns > 0 ? width % columns : width;
}

export function openBottomBar(options: BottomBarOptions): BottomBar {
  const { output } = options;
  const synchronized = options.synchronized !== false;

  let painted = 0;
  let closed = false;
  let cursorVisible = true;
  /** Where the transcript's own cursor sits, between writes above the footer. */
  let column = 0;

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
    writeAbove(text: string, lines: readonly string[]): void {
      if (closed) return;

      const columns = width();
      // Step below the transcript's last row, erase the footer, and come back —
      // all relative, so a scroll cannot leave the cursor a row out.
      if (painted > 0) {
        output.write(
          `\n${ERASE_BELOW}${CURSOR_UP(1)}\r${CURSOR_RIGHT(column)}`,
        );
        painted = 0;
      }

      output.write(text);
      column = advance(column, text, columns);
      bar.paint(lines, column);
    },

    repaint(lines: readonly string[]): void {
      bar.paint(lines, column);
    },

    eraseBlock(rows: number): void {
      if (closed || rows <= 0) return;
      output.write(frame(`${CURSOR_UP(rows)}\r${ERASE_BELOW}`));
      painted = 0;
      column = 0;
    },

    setCursorVisible(visible: boolean): void {
      // Tracked rather than sent every time: the indicator repaints ten times a
      // second, and a terminal that receives DECTCEM on every frame is a
      // terminal doing ten times the work for no change.
      if (closed || visible === cursorVisible) return;
      cursorVisible = visible;
      output.write(visible ? SHOW_CURSOR : HIDE_CURSOR);
    },

    clear(): void {
      if (closed || painted === 0) return;
      // Back to column zero first, so the erase takes the whole row rather than
      // the part of it to the right of wherever the cursor happened to be. It
      // is only ever called with the cursor on the bar's own first row, so
      // there is nothing to the left of it worth keeping.
      output.write(frame(`\r${ERASE_BELOW}`));
      painted = 0;
      column = 0;
    },

    close(): void {
      if (closed) return;
      bar.clear();
      bar.setCursorVisible(true);
      closed = true;
    },
  };

  return bar;
}
