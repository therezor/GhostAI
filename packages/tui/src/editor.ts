/**
 * The line being typed, as a component rather than as a terminal.
 *
 * This replaced `node:readline`, and the reason is the whole of `renderer.ts`:
 * readline draws its own line, at a row it measured for itself, by moving up
 * over a row count it cached. Every one of those numbers is wrong the instant
 * the window changes width, and none of them is ours to correct — so a frame
 * with readline inside it is a frame nobody owns. Here the line is state, the
 * caret is an index, and drawing is the renderer's job like everything else.
 *
 * What that cost is real and worth naming: readline's history, its emacs
 * bindings, its kill ring and its bracketed-paste handling all had to be
 * written out again. What it bought is that the editor survives a resize,
 * because there is nothing to survive — the frame is asked for again at the new
 * width and the caret is still an index into a string.
 *
 * The bindings are the ones muscle memory expects from a shell. Movement and
 * deletion step by grapheme cluster, so a caret never lands inside an emoji.
 */

import { CURSOR_MARKER, type Component } from './component.js';
import { isCtrl, type Key } from './keys.js';
import {
  nextBoundary,
  previousBoundary,
  visibleWidth,
  wrapToWidth,
} from './text.js';
import type { Theme } from './theme.js';

/** What a keystroke asked the surrounding program to do. */
type EditorOutcome =
  | { readonly kind: 'none' }
  | { readonly kind: 'submit'; readonly text: string }
  /** Ctrl-C. Means "stop what is running", or "leave" when nothing is. */
  | { readonly kind: 'interrupt' }
  /** Ctrl-D on an empty line, which is end-of-input and not a character. */
  | { readonly kind: 'eof' };

const NONE: EditorOutcome = { kind: 'none' };

interface EditorOptions {
  readonly theme: Theme;
  /** Drawn before the caret. Defaults to `'› '`. */
  readonly prompt?: string;
  /** Shown in place of an empty line. */
  readonly placeholder?: string | undefined;
}

export interface Editor extends Component {
  readonly text: string;
  /** Replaces the line and puts the caret at its end. */
  setText(text: string): void;
  handleKey(key: Key): EditorOutcome;
  /** Adds a line to the history without submitting it. */
  remember(line: string): void;
}

/** Where a word ends, walking left from `at`. */
function wordStart(text: string, at: number): number {
  let start = at;
  while (start > 0 && /\s/.test(text[start - 1] ?? '')) start -= 1;
  while (start > 0 && !/\s/.test(text[start - 1] ?? '')) start -= 1;
  return start;
}

/** Where a word ends, walking right from `at`. */
function wordEnd(text: string, at: number): number {
  let end = at;
  while (end < text.length && /\s/.test(text[end] ?? '')) end += 1;
  while (end < text.length && !/\s/.test(text[end] ?? '')) end += 1;
  return end;
}

export function createEditor(options: EditorOptions): Editor {
  const { theme } = options;
  const prompt = options.prompt ?? '› ';

  let text = '';
  let caret = 0;
  const history: string[] = [];
  /** Where in the history the line came from; `history.length` means "not". */
  let recalled = history.length;
  /** What was being typed before the first Up, so Down can put it back. */
  let draft = '';

  const editor: Editor = {
    get text(): string {
      return text;
    },

    setText(next): void {
      text = next;
      caret = next.length;
    },

    remember(line): void {
      if (line === '' || history.at(-1) === line) return;
      history.push(line);
      recalled = history.length;
    },

    render(width): readonly string[] {
      const usable = Math.max(1, width - visibleWidth(prompt));
      const body =
        text === '' && options.placeholder !== undefined
          ? theme.dim(options.placeholder) + CURSOR_MARKER
          : text.slice(0, caret) + CURSOR_MARKER + text.slice(caret);

      // Wrapped rather than cut: a message longer than the window is ordinary,
      // and the renderer needs every row it will occupy, not a promise that it
      // fits. The marker rides along inside the text, so it lands on whichever
      // row the fold put it on with no second measurement to keep in step.
      const rows = wrapToWidth(body, usable);
      const head = rows[0] ?? '';
      return [
        // The caret is the one mark on this row that belongs to the CLI rather
        // than to whoever is typing, so it is the one that carries the colour.
        `${theme.accent(prompt)}${head}`,
        // Aligned under the first row's text, which is where a wrapped line
        // continues in every editor anyone has used.
        ...rows.slice(1).map((row) => ' '.repeat(visibleWidth(prompt)) + row),
      ];
    },

    handleKey(key): EditorOutcome {
      if (isCtrl(key, 'c')) return { kind: 'interrupt' };
      if (isCtrl(key, 'd')) {
        if (text === '') return { kind: 'eof' };
        if (caret < text.length) {
          text = text.slice(0, caret) + text.slice(nextBoundary(text, caret));
        }
        return NONE;
      }

      if (key.name === 'enter') {
        const line = text;
        text = '';
        caret = 0;
        recalled = history.length;
        draft = '';
        return { kind: 'submit', text: line };
      }

      if (key.name === 'backspace') {
        if (caret > 0) {
          const start = previousBoundary(text, caret);
          text = text.slice(0, start) + text.slice(caret);
          caret = start;
        }
        return NONE;
      }

      if (key.name === 'delete') {
        if (caret < text.length) {
          text = text.slice(0, caret) + text.slice(nextBoundary(text, caret));
        }
        return NONE;
      }

      if (key.name === 'left') {
        caret = key.meta
          ? wordStart(text, caret)
          : previousBoundary(text, caret);
        return NONE;
      }
      if (key.name === 'right') {
        caret = key.meta ? wordEnd(text, caret) : nextBoundary(text, caret);
        return NONE;
      }
      if (key.name === 'home' || isCtrl(key, 'a')) {
        caret = 0;
        return NONE;
      }
      if (key.name === 'end' || isCtrl(key, 'e')) {
        caret = text.length;
        return NONE;
      }
      if (isCtrl(key, 'b')) {
        caret = previousBoundary(text, caret);
        return NONE;
      }
      if (isCtrl(key, 'f')) {
        caret = nextBoundary(text, caret);
        return NONE;
      }

      if (isCtrl(key, 'u')) {
        text = text.slice(caret);
        caret = 0;
        return NONE;
      }
      if (isCtrl(key, 'k')) {
        text = text.slice(0, caret);
        return NONE;
      }
      if (isCtrl(key, 'w')) {
        const start = wordStart(text, caret);
        text = text.slice(0, start) + text.slice(caret);
        caret = start;
        return NONE;
      }

      // Up and Down walk the history rather than the wrapped rows. A line long
      // enough to wrap is rare and a history nobody can reach is not.
      if (key.name === 'up') {
        if (recalled === history.length) draft = text;
        if (recalled > 0) {
          recalled -= 1;
          editor.setText(history[recalled] ?? '');
        }
        return NONE;
      }
      if (key.name === 'down') {
        if (recalled < history.length) {
          recalled += 1;
          editor.setText(
            recalled === history.length ? draft : (history[recalled] ?? ''),
          );
        }
        return NONE;
      }

      if (key.name === 'char' && !key.ctrl) {
        text = text.slice(0, caret) + key.char + text.slice(caret);
        caret += key.char.length;
      }
      return NONE;
    },
  };

  return editor;
}
