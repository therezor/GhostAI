/**
 * The one place that knows both readline and `@ghostai/tui`.
 *
 * A menu has to read stdin, and in the REPL something else already is: a
 * readline `Interface` in the middle of a pending `question`. This file performs
 * the handover in both directions and nothing else does — which is what lets the
 * toolkit take a `handover` callback and stay a package that has never heard of
 * a REPL, and what the lint zone in `eslint.config.js` enforces.
 *
 * Three details make the handover safe, and each of them was wrong in an
 * earlier sketch:
 *
 *  - **`rl.pause()` is not enough.** `emitKeypressEvents`'s own `data` hook
 *    stays attached to the stream, so resuming would feed readline again.
 *    readline's `keypress` listener has to be *detached* and put back, not
 *    starved. Node re-attaches its `data` hook by itself when a `keypress`
 *    listener returns, which is why restoring the saved listeners is the whole
 *    of the restore.
 *  - **Raw mode is never touched here.** readline set it when the interface was
 *    created with `terminal: true`, and it stays set across the takeover. A
 *    `setRawMode` call on either side of this is how a shell ends up with no
 *    echo after the process exits.
 *  - **The pending `question` is never cancelled.** Aborting it to run a menu
 *    would mean restructuring the REPL's single `AbortController`, and it is
 *    unnecessary: the promise is simply still pending when the menu closes, and
 *    resolves normally afterwards.
 *
 * `NO_MENU` is the other half of the design. Every non-interactive path — a
 * pipe, `--json`, `TERM=dumb`, a one-shot, a test — gets it by construction
 * rather than by remembering an `if`, which is what makes "the scripted paths
 * are untouched" a property of the type rather than a convention.
 */

import type { Interface } from 'node:readline/promises';

import {
  columnsOf,
  openScreen,
  select,
  type InputHandover,
  type Screen,
  type SelectItem,
  type SelectLabels,
  type TerminalInput,
  type TerminalOutput,
  type Theme,
} from '@ghostai/tui';

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

export interface MenuAvailableOptions {
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

/**
 * Detaches readline from stdin, and puts it back.
 *
 * See the note at the top of this file for why each step is what it is. Safe to
 * release twice: a `Screen` closed by both its own `finally` and an exit hook
 * would otherwise restore the listeners twice and leave readline seeing every
 * keystroke in duplicate.
 */
export function suspendReadline(
  rl: Interface,
  input: TerminalInput,
): InputHandover {
  rl.pause();
  const saved = input.listeners('keypress');
  input.removeAllListeners('keypress');

  let released = false;
  return {
    release: (): void => {
      if (released) return;
      released = true;
      for (const listener of saved) {
        input.on('keypress', listener as (...args: unknown[]) => void);
      }
      rl.resume();
    },
  };
}

export interface MenuOptions {
  readonly input: TerminalInput;
  readonly output: TerminalOutput;
  /** The REPL's interface, suspended for the life of each menu. */
  readonly rl: Interface;
  readonly theme: Theme;
  /**
   * Registers the last-resort restore. Injected so a test does not accumulate
   * listeners on the real process, and so `chatCommand` stays the only place
   * that decides this run owns them.
   */
  readonly onExit?: ((restore: () => void) => void) | undefined;
}

/**
 * A menu bound to a running REPL.
 *
 * The exit hook is not belt-and-braces. Under raw mode there is no echo and no
 * line discipline, so a process that dies inside a menu leaves the operator's
 * shell unusable until they type `stty sane` blind. `Screen.close()` in
 * `select`'s own `finally` covers every ordinary path; this covers the rest.
 */
export function createMenu(options: MenuOptions): Menu {
  let open: Screen | undefined;

  const register =
    options.onExit ??
    ((restore): void => {
      process.once('exit', restore);
    });
  register(() => {
    open?.close();
    open = undefined;
  });

  return {
    available: true,
    async choose<T>(request: MenuRequest<T>): Promise<T | undefined> {
      const screen = openScreen({
        input: options.input,
        output: options.output,
        handover: () => suspendReadline(options.rl, options.input),
      });
      open = screen;

      try {
        return await select<T>({
          screen,
          items: request.items,
          labels: request.labels,
          theme: options.theme,
          ...(request.index === undefined ? {} : { index: request.index }),
        });
      } finally {
        screen.close();
        open = undefined;
      }
    },
  };
}
