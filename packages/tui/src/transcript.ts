/**
 * Everything already said, kept as text rather than as pixels on a screen.
 *
 * The renderer redraws the whole frame when the window changes width, so the
 * frame has to include the conversation — which means something has to hold it.
 * This is that: writes arrive the way a stream takes them, in fragments that
 * mostly do not end on a line break, and are kept as *logical* lines. The wrap
 * happens at render time against the current width, so a narrower window
 * refolds the paragraph instead of clipping it.
 *
 * Two things are worth knowing before changing it:
 *
 *  - **The wrap is cached per width.** A keystroke re-renders the frame, and
 *    the renderer's diff compares row against row; re-wrapping a long
 *    conversation on every keypress would make typing cost the size of the
 *    session. The cache returns the same strings, so the diff finds them equal
 *    by identity and stops at the editor.
 *  - **It is bounded.** A session that streams for hours would otherwise grow
 *    without limit, and a redraw prints every row it holds. The oldest lines are
 *    dropped in blocks rather than one at a time, because dropping one shifts
 *    every row and costs a full redraw.
 */

import type { Component } from './component.js';
import { carryStyles, STYLE_RESET, wrapToWidth } from './text.js';

/** Past this many logical lines the oldest are dropped. */
const LIMIT = 10_000;
/** How many go at once when it does, so the redraw is paid rarely. */
const DROP = 2_000;

export interface Transcript extends Component {
  /** Takes text the way a stream does, newlines and all. */
  write(text: string): void;
  /** Whether the last thing written ended a line. */
  readonly atLineStart: boolean;
  readonly lines: readonly string[];
  clear(): void;
}

export function createTranscript(): Transcript {
  let logical: string[] = [];
  let cachedWidth = -1;
  let cached: readonly string[] = [];
  /** Style sequences still open at the end of the line being written to. */
  let open = '';

  const invalidate = (): void => {
    cachedWidth = -1;
  };

  return {
    get atLineStart(): boolean {
      const last = logical.at(-1);
      return last === undefined || last === open;
    },

    get lines(): readonly string[] {
      return logical;
    },

    write(text): void {
      if (text === '') return;
      const parts = text.split('\n');
      // The first part continues whatever line was open; every later one starts
      // its own. A trailing newline leaves an empty open line, which is exactly
      // what `atLineStart` reports.
      const first = parts[0] ?? '';
      const held = logical.pop();
      logical.push(held === undefined ? first : held + first);
      open = carryStyles(open, first);

      // Each new line re-opens whatever was still on, and the line it left
      // closes what it had. A style that spans a break would otherwise arrive
      // with its `\x1b[2m` on the row above — which is a row the terminal has
      // already drawn — so the text under it renders plain. A streamed chunk of
      // reasoning is routinely `"\n\nLet me think"`, dimmed whole, which is
      // exactly that shape.
      for (const part of parts.slice(1)) {
        if (open !== '') {
          const closing = logical.pop() ?? '';
          logical.push(closing + STYLE_RESET);
        }
        logical.push(open + part);
        open = carryStyles(open, part);
      }

      if (logical.length > LIMIT) logical = logical.slice(DROP);
      invalidate();
    },

    clear(): void {
      logical = [];
      open = '';
      invalidate();
    },

    render(width): readonly string[] {
      if (width === cachedWidth) return cached;
      const rows: string[] = [];
      for (const line of logical) rows.push(...wrapToWidth(line, width));
      cachedWidth = width;
      cached = rows;
      return rows;
    },
  };
}
