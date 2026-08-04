/**
 * A selection list, with no terminal attached.
 *
 * Everything a menu decides — which rows match, which one the cursor is on,
 * which slice of them is visible — happens here, in a class with no I/O, no
 * timers and no streams. `select.ts` is then a loop that feeds it keys and hands
 * its lines to a screen, and it is small enough to read in one sitting because
 * this file holds all the arithmetic.
 *
 * That split is what makes the hard part testable. A test for "the window
 * follows the cursor past the bottom of the visible range" constructs a list,
 * calls `moveDown` eleven times and reads `render`; it needs no fake TTY, no
 * event loop and no timing, which is the difference between an assertion that
 * holds and one that holds on a fast machine.
 *
 * **Filtering is substring, not fuzzy.** A subsequence matcher needs a scoring
 * function, and a scoring function nobody can predict from reading it produces
 * tests that assert whatever the implementation happened to do. A substring
 * match is predictable, and it makes highlighting the match a slice rather than
 * a second search.
 *
 * **No prose.** Not a title, not a footer, not a "nothing matches" line — those
 * are language, they belong to the caller, and they are why this package has no
 * dependency on the translation layer. The one thing rendered here that is not
 * an item is the `(3/12)` scroll counter, and digits are the same in every
 * locale this ships in.
 */

import { fitToWidth, truncateToWidth, visibleWidth } from './text.js';
import type { Theme } from './theme.js';

export interface SelectItem<T> {
  readonly value: T;
  readonly label: string;
  /** A dim right-hand column: a model id, a message count, "current". */
  readonly hint?: string | undefined;
  /** Matched by the filter but never drawn. */
  readonly keywords?: string | undefined;
  /** Drawn dim and skipped by the cursor. */
  readonly disabled?: boolean | undefined;
}

export interface SelectListOptions<T> {
  readonly items: ReadonlyArray<SelectItem<T>>;
  /** How many rows are visible at once. Default 10. */
  readonly rows?: number;
  /** Where the cursor starts. Clamped. Default 0. */
  readonly index?: number;
}

const DEFAULT_ROWS = 10;
/** `❯ ` and `  ` — the same two columns either way, so nothing shifts. */
const CURSOR_GLYPH = '❯ ';
const CURSOR_BLANK = '  ';
const GAP = 2;
/** Below this, a hint column would leave too little room for the label. */
const MIN_LABEL = 8;
const MIN_HINT = 6;

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(value, high));
}

export class SelectList<T> {
  private readonly allItems: ReadonlyArray<SelectItem<T>>;
  private filtered: ReadonlyArray<SelectItem<T>>;
  private filterText = '';
  private cursor = 0;
  /** The first visible row. Moves only as far as it must to keep up. */
  private start = 0;
  private rowCount: number;

  constructor(options: SelectListOptions<T>) {
    this.allItems = options.items;
    this.filtered = options.items;
    this.rowCount = Math.max(1, options.rows ?? DEFAULT_ROWS);
    this.cursor = clamp(
      options.index ?? 0,
      0,
      Math.max(0, options.items.length - 1),
    );
    this.follow();
  }

  get filter(): string {
    return this.filterText;
  }

  get index(): number {
    return this.cursor;
  }

  get rows(): number {
    return this.rowCount;
  }

  get matches(): ReadonlyArray<SelectItem<T>> {
    return this.filtered;
  }

  selected(): SelectItem<T> | undefined {
    return this.filtered[this.cursor];
  }

  /**
   * Narrows the list, and puts the cursor back at the top.
   *
   * Keeping the cursor where it was would mean a keystroke that removes rows
   * above it silently moves the selection to a different item — so the next
   * Enter chooses something the operator did not look at.
   */
  setFilter(text: string): void {
    this.filterText = text;
    this.filtered = this.match(text);
    this.cursor = 0;
    this.start = 0;
    this.skipDisabled(1);
    this.follow();
  }

  setRows(rows: number): void {
    this.rowCount = Math.max(1, rows);
    this.follow();
  }

  moveUp(): void {
    this.moveBy(-1);
  }

  moveDown(): void {
    this.moveBy(1);
  }

  /**
   * Moves the cursor, wrapping at both ends.
   *
   * Wrapping rather than stopping because a list of four agents is faster to
   * reach the last of by pressing up once than by pressing down three times,
   * and because "the key did nothing" is the worst answer a menu can give.
   */
  moveBy(delta: number): void {
    const total = this.filtered.length;
    if (total === 0) return;
    const step = delta === 0 ? 0 : delta / Math.abs(delta);
    this.cursor = (((this.cursor + delta) % total) + total) % total;
    this.skipDisabled(step === 0 ? 1 : step);
    this.follow();
  }

  first(): void {
    this.cursor = 0;
    this.skipDisabled(1);
    this.follow();
  }

  last(): void {
    this.cursor = Math.max(0, this.filtered.length - 1);
    this.skipDisabled(-1);
    this.follow();
  }

  /**
   * The visible rows, and a `(n/total)` counter when some are off-screen.
   *
   * Never returns a line wider than `width`: every cell is measured and cut
   * before it is coloured, because a line that wraps is a row the erase in
   * `screen.ts` will not reach.
   */
  render(width: number, theme: Theme): string[] {
    if (this.filtered.length === 0) return [];

    const visible = Math.min(this.rowCount, this.filtered.length);
    const lines: string[] = [];

    for (let row = this.start; row < this.start + visible; row += 1) {
      const item = this.filtered[row];
      if (item === undefined) continue;
      lines.push(this.renderRow(item, row === this.cursor, width, theme));
    }

    if (this.filtered.length > visible) {
      const counter = `  (${String(this.cursor + 1)}/${String(this.filtered.length)})`;
      lines.push(theme.dim(truncateToWidth(counter, width)));
    }

    return lines;
  }

  private renderRow(
    item: SelectItem<T>,
    isCursor: boolean,
    width: number,
    theme: Theme,
  ): string {
    const glyph = isCursor ? CURSOR_GLYPH : CURSOR_BLANK;
    const available = Math.max(1, width - visibleWidth(glyph));
    const hint = item.hint ?? '';

    // The hint is the first thing to go when the window is narrow: a label the
    // operator cannot read is a menu they cannot use, and a model id they
    // cannot read is only a menu that tells them less.
    const room = available - GAP - MIN_HINT;
    if (hint === '' || room < MIN_LABEL) {
      const label = truncateToWidth(item.label, available);
      return this.paint(
        glyph,
        this.highlight(label, theme),
        '',
        isCursor,
        item,
        theme,
      );
    }

    const widest = Math.max(
      ...this.filtered.map((entry) => visibleWidth(entry.label)),
    );
    const labelWidth = clamp(widest, MIN_LABEL, room);
    const hintWidth = available - labelWidth - GAP;
    const label = this.highlight(fitToWidth(item.label, labelWidth), theme);

    return this.paint(
      glyph,
      label,
      truncateToWidth(hint, hintWidth),
      isCursor,
      item,
      theme,
    );
  }

  /**
   * Colour, applied last.
   *
   * Every width above was measured on uncoloured text, and escape sequences
   * cost no columns — so doing this at the end is what keeps the arithmetic and
   * the output describing the same line.
   */
  private paint(
    glyph: string,
    label: string,
    hint: string,
    isCursor: boolean,
    item: SelectItem<T>,
    theme: Theme,
  ): string {
    const body =
      hint === '' ? label : `${label}${' '.repeat(GAP)}${theme.dim(hint)}`;
    if (item.disabled === true) return theme.dim(`${glyph}${body}`);
    if (isCursor) return theme.cursor(`${glyph}${body}`);
    return `${glyph}${theme.text(body)}`;
  }

  /** The matched span, marked. A no-op when nothing is being filtered. */
  private highlight(label: string, theme: Theme): string {
    if (this.filterText === '') return label;
    const at = label.toLowerCase().indexOf(this.filterText.toLowerCase());
    if (at < 0) return label;
    const end = at + this.filterText.length;
    return (
      label.slice(0, at) + theme.match(label.slice(at, end)) + label.slice(end)
    );
  }

  /**
   * Case-insensitive substring, over the label, the hint and the keywords.
   *
   * Ranked by where the match landed, then by the caller's own order. Because
   * the haystack is built label-first, a hit in the label outranks a hit in the
   * hint without that having to be a rule anywhere.
   */
  private match(text: string): ReadonlyArray<SelectItem<T>> {
    const needle = text.trim().toLowerCase();
    if (needle === '') return this.allItems;

    const hits: Array<{
      readonly item: SelectItem<T>;
      readonly at: number;
      readonly order: number;
    }> = [];

    this.allItems.forEach((item, order) => {
      const hay =
        `${item.label} ${item.hint ?? ''} ${item.keywords ?? ''}`.toLowerCase();
      const at = hay.indexOf(needle);
      if (at >= 0) hits.push({ item, at, order });
    });

    hits.sort((left, right) => left.at - right.at || left.order - right.order);
    return hits.map((hit) => hit.item);
  }

  /**
   * Steps off a disabled row in the given direction.
   *
   * Bounded by the list length so a list of nothing but disabled rows leaves the
   * cursor where it was rather than spinning.
   */
  private skipDisabled(step: number): void {
    const total = this.filtered.length;
    if (total === 0) return;
    for (let tried = 0; tried < total; tried += 1) {
      if (this.filtered[this.cursor]?.disabled !== true) return;
      this.cursor = (((this.cursor + step) % total) + total) % total;
    }
  }

  /** Moves the window the least amount that puts the cursor back inside it. */
  private follow(): void {
    const visible = Math.min(this.rowCount, this.filtered.length);
    const highest = Math.max(0, this.filtered.length - visible);
    if (this.cursor < this.start) this.start = this.cursor;
    else if (this.cursor >= this.start + visible) {
      this.start = this.cursor - visible + 1;
    }
    this.start = clamp(this.start, 0, highest);
  }
}
