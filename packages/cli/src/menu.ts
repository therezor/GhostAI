/**
 * Opening a menu, and deciding whether this terminal can have one.
 *
 * A menu used to be a second thing on screen: it opened a region of its own,
 * took stdin away from readline, painted itself on every keystroke and erased
 * itself on the way out. All of that is gone. A menu is now rows in the same
 * frame as the transcript and the editor, drawn by the same renderer, so there
 * is nothing to hand over and nothing to erase — and, the reason it matters, no
 * second set of row arithmetic to disagree with the first when the window
 * changes size.
 *
 * What is left here is the seam. `open` is supplied by whoever owns the frame,
 * because only that code knows where a menu goes in it; this file knows only
 * that a menu can be shown and eventually answers.
 *
 * `NO_MENU` is the other half of the design. Every non-interactive path — a
 * pipe, `--json`, `TERM=dumb`, a one-shot, a test — gets it by construction
 * rather than by remembering an `if`, which is what makes "the scripted paths
 * are untouched" a property of the type rather than a convention.
 */

import {
  columnsOf,
  type SelectItem,
  type SelectLabels,
  type TerminalInput,
  type TerminalOutput,
} from '@ghostbot/tui';

import type { Env } from './i18n.js';

export interface MenuRequest<T> {
  readonly items: ReadonlyArray<SelectItem<T>>;
  /** Already translated: the toolkit holds no keys. */
  readonly labels: SelectLabels;
  readonly index?: number | undefined;
}

export interface Menu {
  /** `false` when there is no terminal to draw one on. */
  readonly available: boolean;
  /** `undefined` for a cancelled menu, and for every unavailable one. */
  choose<T>(request: MenuRequest<T>): Promise<T | undefined>;
}

/** Never draws, always answers nothing. */
export const NO_MENU: Menu = {
  available: false,
  // Not `async`: there is nothing to await, and a body of `return await
  // Promise.resolve(undefined)` written only to satisfy `require-await` says
  // less than the promise it hands back.
  choose<T>(): Promise<T | undefined> {
    return Promise.resolve(undefined);
  },
};

/**
 * A terminal narrower than this cannot hold a label and a cursor marker, so a
 * menu on it would be a column of ellipses.
 */
const MIN_COLUMNS = 12;

interface MenuAvailableOptions {
  readonly input: TerminalInput;
  readonly output: TerminalOutput;
  /** `--json`: stdout carries one event per line and nothing else. */
  readonly json: boolean;
  readonly env: Env;
}

/**
 * Whether this invocation can draw a menu at all.
 *
 * One predicate in one place, so the answer cannot differ between the picker
 * that asks and the code that decided to offer one. `TERM=dumb` is in here for
 * the same reason Node's own readline checks it before doing any cursor work:
 * on a terminal that does not move a cursor, every escape sequence is printed
 * as literal text into the transcript. Emacs' `M-x shell` is the case that
 * actually happens.
 */
export function menuAvailable(options: MenuAvailableOptions): boolean {
  if (options.json) return false;
  if (options.input.isTTY !== true) return false;
  if (options.output.isTTY !== true) return false;
  if (options.env.TERM === 'dumb') return false;
  // `columnsOf` rather than `?? MIN_COLUMNS`, because a stream can report zero
  // and zero is not nullish — a pty allocated by `script(1)` does exactly that,
  // and the naive spelling refuses to draw a menu on a terminal that is fine.
  return columnsOf(options.output) >= MIN_COLUMNS;
}

interface MenuOptions {
  /**
   * Puts the menu into the frame and answers when it closes.
   *
   * The frame's owner supplies it, because only that code knows where a menu
   * belongs among the rows and which keystrokes should reach it.
   */
  readonly open: <T>(request: MenuRequest<T>) => Promise<T | undefined>;
}

export function createMenu(options: MenuOptions): Menu {
  return {
    available: true,
    choose<T>(request: MenuRequest<T>): Promise<T | undefined> {
      return options.open(request);
    },
  };
}
