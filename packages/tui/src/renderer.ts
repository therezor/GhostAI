/**
 * Draws a frame, and redraws it when it changes.
 *
 * The frame is the *whole* of what this program has put on the screen — the
 * transcript, the editor, the status rows — held as one array of drawn rows.
 * Everything else follows from holding all of it rather than only the part that
 * moves, and the reason to hold all of it is a resize.
 *
 * ## Why a footer cannot be patched in place
 *
 * A terminal rewraps its own screen when the window changes width, and it does
 * that *before* the process is told anything: by the time `SIGWINCH` arrives,
 * every row the program drew has already been folded or joined, moved up or
 * down, and the cursor is somewhere the program has no way to ask about. An
 * erase is relative to the cursor, so it reaches whatever the reflow left below
 * it and cannot touch what the reflow carried above it. Measured on a narrowing
 * from 120 to 80 columns, a three-row footer became six rows, three of which
 * were now above the cursor — and stayed on screen, one stranded copy per
 * resize. No amount of arithmetic fixes that, because the arithmetic is applied
 * to coordinates the reflow already invalidated.
 *
 * So a width change is not patched here. It throws the screen away — including
 * the scrollback, which is this program's own output and nobody else's — and
 * prints the frame again at the new width. That is only possible because the
 * frame is all of it; a renderer holding just a footer would have nothing to
 * print the transcript back from. It is the same trade `@earendil-works/pi`
 * makes, and it is why pi does not have this bug.
 *
 * ## The rest of the time
 *
 * Every other render is differential: the new frame is compared against the
 * last one, and only rows that actually changed are rewritten, from the first
 * changed row down. A keystroke touches the editor row and the status rows, so
 * that is what gets redrawn — the transcript above is not touched, and a long
 * conversation costs the same as a short one.
 *
 * Two invariants make the row arithmetic sound, and both are checked here
 * rather than trusted from callers:
 *
 *  - **One array entry is one row.** Anything wider than the window is cut, so
 *    the terminal is never the one deciding how tall the frame is.
 *  - **Rows are addressed within the frame, not the screen.** When the frame
 *    grows past the bottom the terminal scrolls, and every row moves up
 *    together — which a frame-relative offset survives and a screen coordinate
 *    does not. `viewportTop` records how much of the frame has scrolled off, and
 *    a change above it forces the full redraw, because a row in the scrollback
 *    cannot be moved to.
 */

import { CURSOR_MARKER, type Component } from './component.js';
import { columnsOf, rowsOf, type TerminalOutput } from './terminal.js';
import { truncateToWidth, visibleWidth } from './text.js';

/**
 * Written as escapes, never as bytes — a literal `0x1b` in a source file is
 * invisible in an editor and unsearchable with the tools everyone tries first.
 */
const ESC = '\u001b';
const CURSOR_UP = (rows: number): string => `${ESC}[${String(rows)}A`;
const CURSOR_DOWN = (rows: number): string => `${ESC}[${String(rows)}B`;
const CURSOR_RIGHT = (cols: number): string => `${ESC}[${String(cols)}C`;
const ERASE_ROW = `${ESC}[2K`;
const ERASE_BELOW = `${ESC}[0J`;
/**
 * Clear the screen, go home, and drop the scrollback with it.
 *
 * The scrollback goes because it has to. A narrowing rewraps every row this
 * program drew, and a frame that was sixteen rows at 120 columns is forty at
 * 20 — far more than the window holds, so the terminal scrolls and the top of
 * the old frame lands in the history. Erasing only the viewport leaves that
 * fragment behind: measured at 120 → 20, eight rows of a half-wrapped banner
 * sat above the new frame, one copy per resize. Nothing the program can ask
 * tells it whether that happened, so the only sound answer is to assume it did.
 *
 * What is lost is whatever the operator's shell printed before `ghostai` started.
 * What is gained is that the conversation is reprinted whole, correctly folded,
 * with no stale copy behind it — and the conversation is what the scrollback of
 * a chat session is for.
 */
const CLEAR_ALL = `${ESC}[2J${ESC}[H${ESC}[3J`;
const HIDE_CURSOR = `${ESC}[?25l`;
const SHOW_CURSOR = `${ESC}[?25h`;
const SYNC_ON = `${ESC}[?2026h`;
const SYNC_OFF = `${ESC}[?2026l`;

export interface RendererOptions {
  readonly output: TerminalOutput;
  /** Used when the stream reports none, as a recorded pty does. */
  readonly columns?: number | undefined;
  readonly rows?: number | undefined;
  /** Synchronized output around each frame. Default `true`. */
  readonly synchronized?: boolean;
}

interface Renderer {
  readonly columns: number;
  readonly rows: number;
  /** How many frames were printed whole rather than patched. For tests. */
  readonly fullRedraws: number;
  setRoot(root: Component | undefined): void;
  /** Draws the frame now. */
  render(): void;
  /** Draws it on the next turn of the loop, once, however often this is called. */
  requestRender(): void;
  onResize(handler: () => void): () => void;
  setCursorVisible(visible: boolean): void;
  /**
   * Leaves the cursor below the frame and stops drawing.
   *
   * Idempotent, and it has to be: it runs from a `finally`, from a signal
   * handler and from `process.on('exit')`, and a terminal left with no cursor
   * is the same class of damage as one left in raw mode.
   */
  stop(): void;
}

/** Where in the frame the cursor goes, and the frame with the marker removed. */
function extractCursor(lines: readonly string[]): {
  readonly lines: string[];
  readonly row: number | undefined;
  readonly column: number;
} {
  const out: string[] = [];
  let row: number | undefined;
  let column = 0;

  for (const line of lines) {
    const at = line.indexOf(CURSOR_MARKER);
    // Untouched rows are pushed as they came, not rebuilt: the transcript hands
    // back the same strings between keystrokes, and the diff below leans on
    // that to compare a long conversation by pointer rather than by character.
    if (at < 0) {
      out.push(line);
      continue;
    }
    // The first marker wins the cursor; every one of them is still removed.
    // Scrubbing only the first would let a second reach the terminal, and what
    // a terminal does with an APC string it does not recognise is its own
    // business rather than something to find out in front of an operator.
    if (row === undefined) {
      row = out.length;
      column = visibleWidth(line.slice(0, at));
    }
    out.push(line.replaceAll(CURSOR_MARKER, ''));
  }

  return { lines: out, row, column };
}

export function createRenderer(options: RendererOptions): Renderer {
  const { output } = options;
  const synchronized = options.synchronized !== false;

  let root: Component | undefined;
  let previous: string[] = [];
  let previousWidth = 0;
  let previousHeight = 0;
  /** Where the terminal's cursor sits, as a row of the frame. */
  let hardwareRow = 0;
  /** How many rows of the frame have scrolled off the top. */
  let viewportTop = 0;
  let fullRedraws = 0;
  let scheduled = false;
  let stopped = false;
  let cursorVisible = true;

  const width = (): number => columnsOf(output, options.columns);
  const height = (): number => rowsOf(output, options.rows);

  const frame = (body: string): string =>
    synchronized ? `${SYNC_ON}${body}${SYNC_OFF}` : body;

  /** Moves from `hardwareRow` to `row`, then to `column`. */
  const moveTo = (row: number, column: number): string => {
    const delta = row - hardwareRow;
    hardwareRow = row;
    const vertical =
      delta > 0 ? CURSOR_DOWN(delta) : delta < 0 ? CURSOR_UP(-delta) : '';
    return `${vertical}\r${column > 0 ? CURSOR_RIGHT(column) : ''}`;
  };

  const renderer: Renderer = {
    get columns(): number {
      return width();
    },
    get rows(): number {
      return height();
    },
    get fullRedraws(): number {
      return fullRedraws;
    },

    setRoot(next): void {
      root = next;
    },

    requestRender(): void {
      if (stopped || scheduled) return;
      scheduled = true;
      queueMicrotask(() => {
        scheduled = false;
        renderer.render();
      });
    },

    render(): void {
      if (stopped || root === undefined) return;

      const columns = width();
      const screenRows = height();
      const built = extractCursor(root.render(columns));
      const lines = built.lines;

      const cursorRow = built.row ?? Math.max(0, lines.length - 1);
      const cursorColumn = built.row === undefined ? 0 : built.column;

      const widthChanged = previousWidth !== 0 && previousWidth !== columns;
      const heightChanged =
        previousHeight !== 0 && previousHeight !== screenRows;

      const settle = (): void => {
        previous = lines;
        previousWidth = columns;
        previousHeight = screenRows;
      };

      /**
       * The row as it goes to the terminal.
       *
       * The cut is enforced here rather than trusted from the component,
       * because everything else assumes one entry is one row, and a single
       * wrapped line puts every later row's address out by one. Applied at the
       * moment a row is written rather than to the whole frame, so a keystroke
       * costs the rows it redraws and not the length of the conversation.
       */
      const fit = (line: string): string => truncateToWidth(line, columns);

      const printWhole = (clear: boolean): void => {
        fullRedraws += 1;
        hardwareRow = Math.max(0, lines.length - 1);
        viewportTop = Math.max(0, lines.length - screenRows);
        output.write(
          frame(
            (clear ? CLEAR_ALL : '') +
              lines.map(fit).join('\r\n') +
              moveTo(cursorRow, cursorColumn),
          ),
        );
        settle();
      };

      // Nothing on screen yet, or the window moved and every row on it has
      // already been rewrapped by the terminal into places this cannot address.
      if (previous.length === 0 || widthChanged || heightChanged) {
        printWhole(previous.length > 0);
        return;
      }

      let firstChanged = -1;
      let lastChanged = -1;
      const total = Math.max(lines.length, previous.length);
      for (let at = 0; at < total; at += 1) {
        if ((lines[at] ?? '') !== (previous[at] ?? '')) {
          if (firstChanged < 0) firstChanged = at;
          lastChanged = at;
        }
      }

      if (firstChanged < 0) {
        output.write(frame(moveTo(cursorRow, cursorColumn)));
        settle();
        return;
      }

      // A row that has scrolled into the scrollback cannot be moved to, so the
      // only honest answer is to print the frame again.
      if (firstChanged < viewportTop) {
        printWhole(true);
        return;
      }

      // A row past the end of the last frame does not exist yet, and `CUD`
      // cannot make one: moving down from the bottom row of a screen does
      // nothing at all, where a newline scrolls and creates one. A frame that
      // grew — which is what every turn does to the transcript — would
      // otherwise have its new rows written over its last old row.
      //
      // So the walk starts at the last row that *was* drawn and steps into the
      // new ones with `\r\n`, the only sequence that adds a row.
      const anchor = Math.min(firstChanged, previous.length - 1);
      // Stopping at the last row that *differs*, rather than running to the
      // bottom of the frame. Rows below an edit are usually identical — the
      // rules, the status — and rewriting them costs a repaint of the whole
      // lower frame for a one-row change. That is what a spinner does ten times
      // a second, and it is the difference between one row of traffic per tick
      // and six. pi's renderer draws the same bound for the same reason.
      const end = Math.min(lastChanged, lines.length - 1);

      let body = '';
      if (end >= anchor) {
        body += moveTo(anchor, 0);
        for (let at = anchor; at <= end; at += 1) {
          if (at > anchor) {
            body += '\r\n';
            hardwareRow += 1;
          }
          if (at >= firstChanged) body += `${ERASE_ROW}${fit(lines[at] ?? '')}`;
        }
      } else {
        // Only deletions: nothing to write, but the erase below has to start
        // from the last row that survives.
        body += moveTo(Math.max(0, lines.length - 1), 0);
      }
      // Rows the frame no longer has. Erasing below the last one takes them all
      // in a single sequence, and it cannot reach anything else: everything
      // under the frame is this renderer's too.
      if (previous.length > lines.length) {
        body += `\r\n${ERASE_BELOW}${CURSOR_UP(1)}`;
      }

      // Writing past the bottom scrolls, and the whole frame moves up with it.
      // Frame-relative rows survive that; the record of what has gone is the
      // only thing that has to be corrected.
      viewportTop = Math.max(viewportTop, lines.length - screenRows);
      body += moveTo(cursorRow, cursorColumn);
      output.write(frame(body));
      settle();
    },

    onResize(handler): () => void {
      output.on('resize', handler);
      return () => {
        output.off('resize', handler);
      };
    },

    setCursorVisible(visible): void {
      // Tracked rather than sent every time: a spinner repaints ten times a
      // second, and a terminal taking DECTCEM on every frame is doing ten times
      // the work for no change.
      if (stopped || visible === cursorVisible) return;
      cursorVisible = visible;
      output.write(visible ? SHOW_CURSOR : HIDE_CURSOR);
    },

    stop(): void {
      if (stopped) return;
      stopped = true;
      // Below the last row of the frame, so a shell prompt does not land on it.
      const below = Math.max(0, previous.length - 1) - hardwareRow;
      output.write(`${below > 0 ? CURSOR_DOWN(below) : ''}\r\n${SHOW_CURSOR}`);
      cursorVisible = true;
    },
  };

  return renderer;
}
