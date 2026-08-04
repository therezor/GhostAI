/**
 * A menu: keys in, one value or nothing out.
 *
 * The whole of the interactive part, and it is short because `SelectList` owns
 * every decision and `Screen` owns every byte. What is left here is a key map,
 * a frame, and the promise that ties them together.
 *
 * **Cancelling resolves rather than rejects.** `undefined` is a perfectly
 * ordinary answer to "which agent?" — the operator pressed Escape — and a
 * rejection would make every call site wrap this in a `try` to express that.
 *
 * **Ctrl-C is handled here, not by a signal handler.** In raw mode the terminal
 * stops translating `0x03` into SIGINT and delivers the byte, so the CLI's
 * `process.on('SIGINT')` does not fire while a menu is open. A menu that did not
 * read `0x03` itself would be a menu Ctrl-C could not close.
 *
 * **`Ctrl-P`/`Ctrl-N` move as well as the arrow keys.** They are plain control
 * bytes, which makes them the only movement keys that survive a terminal whose
 * cursor sequences arrive in a form nothing recognises — legacy Windows conhost
 * being the case that actually happens.
 */

import { isCtrl, type Key } from './keys.js';
import type { Screen } from './screen.js';
import { SelectList, type SelectItem } from './select-list.js';
import { truncateToWidth } from './text.js';
import { PLAIN_THEME, type Theme } from './theme.js';

/** Everything a menu says. Already translated: this package holds no keys. */
export interface SelectLabels {
  readonly title: string;
  /** Shown in place of the rows when the filter matches nothing. */
  readonly empty: string;
  /** The dim line under the rows, naming the keys. */
  readonly footer: string;
  /** Drawn before the filter text. Default `/`. */
  readonly filterPrefix?: string | undefined;
}

export interface SelectOptions<T> {
  readonly screen: Screen;
  readonly items: ReadonlyArray<SelectItem<T>>;
  readonly labels: SelectLabels;
  /** Defaults to `PLAIN_THEME`, so a caller that forgets colour still reads. */
  readonly theme?: Theme | undefined;
  readonly index?: number | undefined;
  /** Visible rows, clamped to what the window can hold. Default 10. */
  readonly maxRows?: number | undefined;
  readonly signal?: AbortSignal | undefined;
}

const DEFAULT_MAX_ROWS = 10;
/** Title, filter, footer, the scroll counter, and a row of breathing space. */
const CHROME_ROWS = 5;
const DEFAULT_FILTER_PREFIX = '/';

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(value, high));
}

/**
 * Runs a menu until it is answered or abandoned.
 *
 * Always erases the region before resolving, on every path including an abort —
 * a menu left painted after its promise settled is a menu the next prompt draws
 * on top of.
 */
export async function select<T>(
  options: SelectOptions<T>,
): Promise<T | undefined> {
  const { screen, labels } = options;
  const theme = options.theme ?? PLAIN_THEME;
  const prefix = labels.filterPrefix ?? DEFAULT_FILTER_PREFIX;

  const visibleRows = (): number =>
    clamp(
      options.maxRows ?? DEFAULT_MAX_ROWS,
      1,
      Math.max(1, screen.rows - CHROME_ROWS),
    );

  const list = new SelectList({
    items: options.items,
    rows: visibleRows(),
    ...(options.index === undefined ? {} : { index: options.index }),
  });

  const frame = (): string[] => {
    const width = screen.columns;
    const fit = (text: string): string => truncateToWidth(text, width);

    const rows = list.render(width, theme);
    return [
      theme.title(fit(labels.title)),
      theme.dim(fit(`${prefix}${list.filter}`)),
      ...(rows.length > 0 ? rows : [theme.dim(fit(`  ${labels.empty}`))]),
      theme.dim(fit(`  ${labels.footer}`)),
    ];
  };

  return await new Promise<T | undefined>((resolve) => {
    let settled = false;
    // Collected rather than held in named variables, because the handlers are
    // registered *after* `finish` is defined and `handle` calls `finish` — so
    // neither order lets both be a `const`.
    const undo: Array<() => void> = [];

    const finish = (value: T | undefined): void => {
      if (settled) return;
      settled = true;
      for (const off of undo) off();
      options.signal?.removeEventListener('abort', onAbort);
      screen.clear();
      resolve(value);
    };

    function onAbort(): void {
      finish(undefined);
    }

    const draw = (): void => {
      screen.paint(frame());
    };

    const handle = (key: Key): void => {
      if (key.name === 'escape' || isCtrl(key, 'c') || isCtrl(key, 'd')) {
        finish(undefined);
        return;
      }

      if (key.name === 'enter') {
        const item = list.selected();
        // Nothing matched: Enter means "give up" rather than "choose the row
        // that is not there". A disabled row is different — it is on screen, so
        // the key doing nothing is the honest answer.
        if (item === undefined) finish(undefined);
        else if (item.disabled !== true) finish(item.value);
        return;
      }

      if (key.name === 'up' || isCtrl(key, 'p')) list.moveUp();
      else if (key.name === 'down' || isCtrl(key, 'n')) list.moveDown();
      else if (key.name === 'tab') {
        if (key.shift) list.moveUp();
        else list.moveDown();
      } else if (key.name === 'pageUp') list.moveBy(-list.rows);
      else if (key.name === 'pageDown') list.moveBy(list.rows);
      else if (key.name === 'home') list.first();
      else if (key.name === 'end') list.last();
      else if (key.name === 'backspace') {
        list.setFilter(list.filter.slice(0, -1));
      } else if (isCtrl(key, 'u')) list.setFilter('');
      else if (key.name === 'char' && !key.ctrl && !key.meta) {
        list.setFilter(list.filter + key.char);
      } else return;

      draw();
    };

    if (options.signal?.aborted === true) {
      finish(undefined);
      return;
    }
    options.signal?.addEventListener('abort', onAbort, { once: true });

    undo.push(
      screen.onKey(handle),
      screen.onResize(() => {
        list.setRows(visibleRows());
        draw();
      }),
    );

    draw();
  });
}
