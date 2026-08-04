/**
 * A menu: keys in, one value or nothing out.
 *
 * Short, because `SelectList` owns every decision about what is selected and
 * the renderer owns every byte. What is left is a key map and a frame.
 *
 * It is a component and not a loop of its own, which is the part that changed
 * when the renderer arrived. A menu used to open its own region, take stdin and
 * paint itself; now it is rows in the same frame as everything else, so it
 * refolds on a resize for the same reason the transcript does and there is no
 * second thing on screen for the two of them to disagree about.
 *
 * **Cancelling answers `undefined` rather than throwing.** The operator pressed
 * Escape, which is a perfectly ordinary answer to "which agent?"; a rejection
 * would make every call site wrap this in a `try` to say so.
 *
 * **`Ctrl-P`/`Ctrl-N` move as well as the arrow keys.** They are plain control
 * bytes, which makes them the only movement keys that survive a terminal whose
 * cursor sequences arrive in a form nothing recognises — legacy Windows conhost
 * being the case that actually happens.
 */

import type { Component } from './component.js';
import { isCtrl, type Key } from './keys.js';
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
  readonly items: ReadonlyArray<SelectItem<T>>;
  readonly labels: SelectLabels;
  /** Defaults to `PLAIN_THEME`, so a caller that forgets colour still reads. */
  readonly theme?: Theme | undefined;
  readonly index?: number | undefined;
  /** Visible rows, clamped by the caller to what the window can hold. */
  readonly maxRows?: number | undefined;
}

/** What a keystroke did to the menu. */
export type SelectOutcome<T> =
  | { readonly kind: 'open' }
  | { readonly kind: 'chosen'; readonly value: T }
  | { readonly kind: 'cancelled' };

export interface Select<T> extends Component {
  handleKey(key: Key): SelectOutcome<T>;
  /** Clamps the list to what the window can spare. */
  setRows(rows: number): void;
}

export const DEFAULT_MAX_ROWS = 10;
/** Title, filter, footer, the scroll counter, and a row of breathing space. */
export const CHROME_ROWS = 5;
const DEFAULT_FILTER_PREFIX = '/';
const OPEN: SelectOutcome<never> = { kind: 'open' };
const CANCELLED: SelectOutcome<never> = { kind: 'cancelled' };

export function createSelect<T>(options: SelectOptions<T>): Select<T> {
  const { labels } = options;
  const theme = options.theme ?? PLAIN_THEME;
  const prefix = labels.filterPrefix ?? DEFAULT_FILTER_PREFIX;

  const list = new SelectList({
    items: options.items,
    rows: options.maxRows ?? DEFAULT_MAX_ROWS,
    ...(options.index === undefined ? {} : { index: options.index }),
  });

  return {
    setRows(rows): void {
      list.setRows(rows);
    },

    render(width): readonly string[] {
      const fit = (text: string): string => truncateToWidth(text, width);
      const rows = list.render(width, theme);
      return [
        theme.title(fit(labels.title)),
        theme.dim(fit(`${prefix}${list.filter}`)),
        ...(rows.length > 0 ? rows : [theme.dim(fit(`  ${labels.empty}`))]),
        theme.dim(fit(`  ${labels.footer}`)),
      ];
    },

    handleKey(key): SelectOutcome<T> {
      if (key.name === 'escape' || isCtrl(key, 'c') || isCtrl(key, 'd')) {
        return CANCELLED;
      }

      if (key.name === 'enter') {
        const item = list.selected();
        // Nothing matched: Enter means "give up" rather than "choose the row
        // that is not there". A disabled row is different — it is on screen, so
        // the key doing nothing is the honest answer.
        if (item === undefined) return CANCELLED;
        return item.disabled === true
          ? OPEN
          : { kind: 'chosen', value: item.value };
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
      }

      return OPEN;
    },
  };
}
