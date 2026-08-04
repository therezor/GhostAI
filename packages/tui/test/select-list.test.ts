import { describe, expect, it } from 'vitest';

import { SelectList, type SelectItem } from '#src/select-list.js';
import { visibleWidth } from '#src/text.js';
import { PLAIN_THEME, themeFrom } from '#src/theme.js';
import pc from 'picocolors';

/** Values are their own labels, which keeps every assertion below readable. */
function items(...labels: string[]): Array<SelectItem<string>> {
  return labels.map((label) => ({ value: label, label }));
}

function labelsOf(list: SelectList<string>): string[] {
  return list.matches.map((item) => item.label);
}

/** The rows only — `render` also emits a counter once some are off-screen. */
function rowsOf(list: SelectList<string>, width = 40): string[] {
  return list
    .render(width, PLAIN_THEME)
    .filter((line) => !/^\s*\(\d+\/\d+\)/u.test(line));
}

/** The rows with the two-column cursor marker and the padding taken off. */
function bodiesOf(list: SelectList<string>, width = 40): string[] {
  return rowsOf(list, width).map((row) => row.slice(2).trim());
}

describe('the cursor', () => {
  it('starts at the top, or wherever the caller asked for', () => {
    expect(new SelectList({ items: items('a', 'b', 'c') }).index).toBe(0);
    expect(
      new SelectList({ items: items('a', 'b', 'c'), index: 2 }).index,
    ).toBe(2);
  });

  it('clamps a starting index the list cannot honour', () => {
    expect(new SelectList({ items: items('a', 'b'), index: 9 }).index).toBe(1);
    expect(new SelectList({ items: items('a', 'b'), index: -3 }).index).toBe(0);
  });

  it('wraps at both ends rather than stopping', () => {
    // Reaching the last of four agents by pressing up once beats pressing down
    // three times, and "the key did nothing" is the worst answer a menu gives.
    const list = new SelectList({ items: items('a', 'b', 'c') });
    list.moveUp();
    expect(list.index).toBe(2);
    list.moveDown();
    expect(list.index).toBe(0);
  });

  it('moves by more than one, wrapping the same way', () => {
    const list = new SelectList({ items: items('a', 'b', 'c', 'd', 'e') });
    list.moveBy(3);
    expect(list.index).toBe(3);
    list.moveBy(4);
    expect(list.index).toBe(2);
  });

  it('goes to the first and last rows', () => {
    const list = new SelectList({ items: items('a', 'b', 'c') });
    list.last();
    expect(list.index).toBe(2);
    list.first();
    expect(list.index).toBe(0);
  });

  it('does nothing at all on an empty list', () => {
    const list = new SelectList<string>({ items: [] });
    list.moveDown();
    list.last();
    expect(list.index).toBe(0);
    expect(list.selected()).toBeUndefined();
  });

  it('steps over a disabled row', () => {
    const list = new SelectList({
      items: [
        { value: 'a', label: 'a' },
        { value: 'b', label: 'b', disabled: true },
        { value: 'c', label: 'c' },
      ],
    });
    list.moveDown();
    expect(list.selected()?.value).toBe('c');
    list.moveUp();
    expect(list.selected()?.value).toBe('a');
  });

  it('gives up rather than spinning when every row is disabled', () => {
    const list = new SelectList({
      items: [
        { value: 'a', label: 'a', disabled: true },
        { value: 'b', label: 'b', disabled: true },
      ],
    });
    list.moveDown();
    expect(list.selected()?.disabled).toBe(true);
  });
});

describe('the filter', () => {
  it('matches case-insensitively across the label, the hint and the keywords', () => {
    const list = new SelectList({
      items: [
        { value: 'a', label: 'Reviewer' },
        { value: 'b', label: 'Scout', hint: 'claude-opus-5' },
        { value: 'c', label: 'Archivist', keywords: 'memory recall' },
      ],
    });

    list.setFilter('REVIEW');
    expect(labelsOf(list)).toEqual(['Reviewer']);
    list.setFilter('opus');
    expect(labelsOf(list)).toEqual(['Scout']);
    list.setFilter('recall');
    expect(labelsOf(list)).toEqual(['Archivist']);
  });

  it('ranks an earlier match first, which puts a label hit above a hint hit', () => {
    // Not a rule written anywhere: the haystack is built label-first, so a hit
    // in the label simply has a lower index than a hit in the hint.
    const list = new SelectList({
      items: [
        { value: 'a', label: 'scout', hint: 'sonnet' },
        { value: 'b', label: 'sonnet-runner' },
      ],
    });
    list.setFilter('sonnet');
    expect(labelsOf(list)).toEqual(['sonnet-runner', 'scout']);
  });

  it('returns every item for an empty or whitespace filter', () => {
    const list = new SelectList({ items: items('a', 'b') });
    list.setFilter('   ');
    expect(labelsOf(list)).toEqual(['a', 'b']);
  });

  it('puts the cursor back at the top, so Enter never chooses an unseen row', () => {
    // Keeping the cursor where it was would mean a keystroke that removes rows
    // above it silently moves the selection to a different item.
    const list = new SelectList({ items: items('alpha', 'beta', 'gamma') });
    list.last();
    expect(list.index).toBe(2);
    list.setFilter('a');
    expect(list.index).toBe(0);
    expect(list.selected()?.label).toBe('alpha');
  });

  it('leaves nothing selected when nothing matches', () => {
    const list = new SelectList({ items: items('a', 'b') });
    list.setFilter('zzz');
    expect(list.matches).toEqual([]);
    expect(list.selected()).toBeUndefined();
  });
});

describe('the visible window', () => {
  it('shows no more rows than it was given room for', () => {
    const list = new SelectList({
      items: items('a', 'b', 'c', 'd', 'e'),
      rows: 3,
    });
    expect(rowsOf(list)).toHaveLength(3);
  });

  it('follows the cursor down, moving the least it can', () => {
    const list = new SelectList({
      items: items('a', 'b', 'c', 'd', 'e'),
      rows: 3,
    });
    for (let step = 0; step < 3; step += 1) list.moveDown();
    // The cursor is on `d`; the window slid by exactly one to reach it.
    expect(bodiesOf(list)).toEqual(['b', 'c', 'd']);
  });

  it('follows the cursor back up', () => {
    const list = new SelectList({
      items: items('a', 'b', 'c', 'd', 'e'),
      rows: 2,
    });
    list.last();
    list.first();
    expect(bodiesOf(list)).toEqual(['a', 'b']);
  });

  it('shows the last rows when the cursor wraps to the end', () => {
    const list = new SelectList({
      items: items('a', 'b', 'c', 'd', 'e'),
      rows: 2,
    });
    list.moveUp();
    expect(bodiesOf(list)).toEqual(['d', 'e']);
  });

  it('adds a counter only once some rows are off-screen', () => {
    const roomy = new SelectList({ items: items('a', 'b'), rows: 5 });
    expect(roomy.render(40, PLAIN_THEME).some((l) => l.includes('/'))).toBe(
      false,
    );

    const cramped = new SelectList({ items: items('a', 'b', 'c'), rows: 2 });
    expect(cramped.render(40, PLAIN_THEME).at(-1)).toContain('(1/3)');
  });

  it('renders nothing at all when nothing matches, leaving the wording to the caller', () => {
    const list = new SelectList({ items: items('a') });
    list.setFilter('zzz');
    expect(list.render(40, PLAIN_THEME)).toEqual([]);
  });

  it('takes a new row count when the window is resized', () => {
    const list = new SelectList({ items: items('a', 'b', 'c', 'd'), rows: 4 });
    list.setRows(2);
    expect(rowsOf(list)).toHaveLength(2);
    // A window with no room at all still shows one row rather than none.
    list.setRows(0);
    expect(rowsOf(list)).toHaveLength(1);
  });
});

describe('rendering', () => {
  it('never produces a line wider than it was given, even in colour', () => {
    // Asserted with `visibleWidth` rather than `length`, so it holds for the
    // coloured output too — which is the case that would actually wrap.
    const list = new SelectList({
      items: [
        {
          value: 'a',
          label: 'a-very-long-label-that-will-not-fit',
          hint: 'and a long hint too',
        },
        { value: 'b', label: '日本語のラベルもある', hint: 'ヒント' },
      ],
      rows: 2,
    });

    for (const width of [10, 20, 32, 60]) {
      for (const theme of [PLAIN_THEME, themeFrom(pc.createColors(true))]) {
        for (const line of list.render(width, theme)) {
          expect(visibleWidth(line)).toBeLessThanOrEqual(width);
        }
      }
    }
  });

  it('marks the selected row with a glyph, so colour is never the only signal', () => {
    // Under NO_COLOR every formatter is the identity function. A menu whose
    // selection was indicated by colour alone would become unusable, not plainer.
    const list = new SelectList({ items: items('alpha', 'beta') });
    const [first, second] = list.render(40, PLAIN_THEME);
    expect(first?.startsWith('❯ ')).toBe(true);
    expect(second?.startsWith('  ')).toBe(true);
  });

  it('drops the hint column before it squeezes the label', () => {
    // A label the operator cannot read is a menu they cannot use; a model id
    // they cannot read is only a menu that tells them less.
    const list = new SelectList({
      items: [{ value: 'a', label: 'reviewer', hint: 'claude-opus-5' }],
    });
    expect(list.render(40, PLAIN_THEME)[0]).toContain('claude-opus-5');
    expect(list.render(14, PLAIN_THEME)[0]).not.toContain('claude');
  });

  it('aligns the hint column across rows', () => {
    const list = new SelectList({
      items: [
        { value: 'a', label: 'x', hint: 'one' },
        { value: 'b', label: 'a-longer-label', hint: 'two' },
      ],
    });
    const rendered = list.render(60, PLAIN_THEME);
    expect(rendered[0]?.indexOf('one')).toBe(rendered[1]?.indexOf('two'));
  });
});
