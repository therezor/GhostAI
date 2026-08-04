import { describe, expect, it } from 'vitest';

import { parseKey } from '#src/keys.js';
import { createSelect, type Select, type SelectLabels } from '#src/select.js';
import type { SelectItem } from '#src/select-list.js';
import { visibleWidth } from '#src/text.js';
import { PLAIN_THEME } from '#src/theme.js';

const ESC = String.fromCharCode(27);
const DOWN = `${ESC}[B`;
const ENTER = '\r';
const CTRL_C = String.fromCharCode(3);
const CTRL_U = String.fromCharCode(21);

const LABELS: SelectLabels = {
  title: 'Pick an agent',
  empty: 'nothing matches',
  footer: 'move choose cancel',
};

const ITEMS: Array<SelectItem<string>> = [
  { value: 'default', label: 'Default', hint: 'qwen3' },
  { value: 'research', label: 'Research', hint: 'sonnet' },
  { value: 'gone', label: 'Retired', disabled: true },
];

function menu(items: Array<SelectItem<string>> = ITEMS): Select<string> {
  return createSelect<string>({ items, labels: LABELS, theme: PLAIN_THEME });
}

/** Feeds bytes the way the real key loop does, and returns the last outcome. */
function press(
  subject: Select<string>,
  ...sequences: string[]
): ReturnType<Select<string>['handleKey']> {
  let outcome = subject.handleKey(parseKey(CTRL_U)!);
  for (const bytes of sequences) {
    const key = parseKey(bytes);
    if (key !== undefined) outcome = subject.handleKey(key);
  }
  return outcome;
}

describe('choosing', () => {
  it('answers the row the cursor is on', () => {
    const outcome = press(menu(), DOWN, ENTER);
    expect(outcome).toEqual({ kind: 'chosen', value: 'research' });
  });

  it('answers nothing on Escape', () => {
    expect(menu().handleKey(parseKey(ESC)!)).toEqual({
      kind: 'cancelled',
    });
  });

  it('answers nothing on Ctrl-C, which raw mode delivers as a byte', () => {
    // The terminal stops turning it into SIGINT, so a menu that did not read
    // `0x03` itself would be a menu Ctrl-C could not close.
    expect(menu().handleKey(parseKey(CTRL_C)!)).toEqual({
      kind: 'cancelled',
    });
  });

  it('stays open when Enter lands on a row that cannot be chosen', () => {
    // A disabled row is on screen, so the key doing nothing is the honest
    // answer — unlike a filter matching nothing, where there is no row at all.
    // Reached by starting on it: the arrow keys step over disabled rows.
    const subject = createSelect<string>({
      items: ITEMS,
      labels: LABELS,
      theme: PLAIN_THEME,
      index: 2,
    });

    expect(subject.handleKey(parseKey(ENTER)!)).toEqual({ kind: 'open' });
  });

  it('gives up when the filter matches nothing and Enter is pressed', () => {
    expect(press(menu(), 'z', 'q', ENTER)).toEqual({ kind: 'cancelled' });
  });
});

describe('drawing', () => {
  it('never draws a row wider than it was given', () => {
    for (const row of menu().render(24)) {
      expect(visibleWidth(row)).toBeLessThanOrEqual(24);
    }
  });

  it('says so when the filter matches nothing', () => {
    const subject = menu();
    press(subject, 'z', 'q');
    expect(subject.render(40).join('\n')).toContain('nothing matches');
  });

  it('shows the filter as it is typed', () => {
    const subject = menu();
    press(subject, 'r', 'e');
    expect(subject.render(40)[1]).toContain('/re');
  });

  it('clamps the list to the rows it is told it can have', () => {
    const roomy = menu();
    roomy.setRows(3);
    const cramped = menu();
    cramped.setRows(1);

    expect(cramped.render(40).length).toBeLessThan(roomy.render(40).length);
  });
});
