import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  dropLastGrapheme,
  fitToWidth,
  justify,
  padToWidth,
  rule,
  stripAnsi,
  truncateToWidth,
  visibleWidth,
} from '#src/text.js';

const ESC = String.fromCharCode(27);
const RED = `${ESC}[31m`;
const BOLD = `${ESC}[1m`;
const RESET = `${ESC}[0m`;

describe('stripAnsi', () => {
  it('removes SGR sequences and leaves the text', () => {
    expect(stripAnsi(`${RED}danger${RESET}`)).toBe('danger');
  });

  it('removes cursor movement and erase sequences', () => {
    expect(stripAnsi(`${ESC}[2A${ESC}[0Jhi`)).toBe('hi');
  });

  it('removes an OSC string, which is terminated by BEL rather than by a letter', () => {
    const bell = String.fromCharCode(7);
    expect(stripAnsi(`${ESC}]0;a title${bell}text`)).toBe('text');
  });

  it('removes the save and restore a status bar is built on', () => {
    // `ESC 7` and `ESC 8` are two-byte private escapes, not CSI sequences. A
    // pattern that only knows CSI counts each of them as one visible column,
    // and every width measured over such a line comes out two too wide.
    expect(stripAnsi(`${ESC}7text${ESC}8`)).toBe('text');
    expect(visibleWidth(`${ESC}7text${ESC}8`)).toBe(4);
  });

  it('leaves a string with no escapes untouched', () => {
    expect(stripAnsi('plain')).toBe('plain');
  });
});

describe('visibleWidth', () => {
  it('counts an ASCII string as its length', () => {
    expect(visibleWidth('hello')).toBe(5);
  });

  it('charges nothing for escape sequences', () => {
    // The reason this module exists: `String.length` here is 15, and a menu
    // that believed it would truncate a five-column row to nothing.
    expect(visibleWidth(`${RED}hello${RESET}`)).toBe(5);
  });

  it('counts a CJK character as two columns, because that is what a terminal draws', () => {
    expect(visibleWidth('日本語')).toBe(6);
    expect(visibleWidth('한글')).toBe(4);
  });

  it('counts an emoji as two columns whether or not it needs a variation selector', () => {
    expect(visibleWidth('🚀')).toBe(2);
    expect(visibleWidth('✅')).toBe(2);
    // U+2714 is one column as text and two with the emoji presentation selector.
    expect(visibleWidth('✔')).toBe(1);
    expect(visibleWidth(`✔${String.fromCharCode(0xfe0f)}`)).toBe(2);
  });

  it('counts a ZWJ emoji sequence once, not once per component', () => {
    // One grapheme cluster, drawn in two columns, spelled with seven code units.
    const family = '👨‍👩‍👧';
    expect(family.length).toBeGreaterThan(2);
    expect(visibleWidth(family)).toBe(2);
  });

  it('charges nothing for a combining mark, and one column for what it sits on', () => {
    expect(visibleWidth('é')).toBe(1);
    expect(visibleWidth('́')).toBe(0);
  });

  it('counts an empty string as zero', () => {
    expect(visibleWidth('')).toBe(0);
  });
});

describe('truncateToWidth', () => {
  it('returns the string unchanged when it already fits', () => {
    expect(truncateToWidth('hello', 10)).toBe('hello');
    expect(truncateToWidth('hello', 5)).toBe('hello');
  });

  it('includes the ellipsis in the budget, so the result never exceeds the width', () => {
    // One column over budget is a line that wraps, and a wrapped line is a row
    // the erase in `screen.ts` never reaches.
    const cut = truncateToWidth('abcdefghij', 5);
    expect(visibleWidth(cut)).toBeLessThanOrEqual(5);
    expect(cut).toBe('abcd…');
  });

  it('never cuts inside an escape sequence', () => {
    const cut = truncateToWidth(`${RED}abcdefghij${RESET}`, 5);
    expect(stripAnsi(cut)).toBe('abcd…');
    expect(cut.startsWith(RED)).toBe(true);
  });

  it('closes an open attribute when it cuts, so the colour does not bleed down the menu', () => {
    const cut = truncateToWidth(`${RED}abcdefghij`, 5);
    expect(cut.endsWith(RESET)).toBe(true);
  });

  it('does not append a reset when nothing was left open', () => {
    const cut = truncateToWidth(`${RED}abc${RESET}defghij`, 5);
    expect(cut.endsWith(RESET)).toBe(false);
  });

  it('never splits a wide character across the boundary', () => {
    // Two columns will not fit in one, so the character is dropped whole.
    expect(visibleWidth(truncateToWidth('日本語', 3))).toBeLessThanOrEqual(3);
  });

  it('returns nothing at all for a width of zero or less', () => {
    expect(truncateToWidth('hello', 0)).toBe('');
    expect(truncateToWidth('hello', -1)).toBe('');
  });

  it('drops the ellipsis rather than exceed a width too small to hold it', () => {
    expect(visibleWidth(truncateToWidth('日本語', 1))).toBeLessThanOrEqual(1);
  });

  it('accepts a different ellipsis', () => {
    expect(truncateToWidth('abcdefghij', 6, '..')).toBe('abcd..');
  });
});

describe('padToWidth', () => {
  it('pads a short string and leaves a long one alone', () => {
    expect(padToWidth('ab', 5)).toBe('ab   ');
    expect(padToWidth('abcdef', 3)).toBe('abcdef');
  });

  it('pads by columns rather than by code units', () => {
    expect(visibleWidth(padToWidth(`${RED}ab${RESET}`, 5))).toBe(5);
    expect(visibleWidth(padToWidth('日', 5))).toBe(5);
  });
});

describe('fitToWidth', () => {
  it('produces exactly the requested width either way', () => {
    expect(visibleWidth(fitToWidth('ab', 6))).toBe(6);
    expect(visibleWidth(fitToWidth('abcdefghij', 6))).toBe(6);
  });
});

describe('dropLastGrapheme', () => {
  it('removes what a person can see, not a code unit', () => {
    // `slice(0, -1)` takes a UTF-16 code unit and cuts an emoji in half;
    // spreading takes a code point and strips one member of a family.
    expect(dropLastGrapheme('ab')).toBe('a');
    expect(dropLastGrapheme('a🚀')).toBe('a');
    expect(dropLastGrapheme('a👨‍👩‍👧')).toBe('a');
    expect(dropLastGrapheme('aé')).toBe('a');
  });

  it('has nothing to remove from nothing', () => {
    expect(dropLastGrapheme('')).toBe('');
  });
});

describe('justify', () => {
  it('pushes the two halves to opposite ends of the width', () => {
    expect(justify('left', 'right', 20)).toBe('left           right');
  });

  it('measures the gap in columns, so colour and CJK land in the right place', () => {
    expect(visibleWidth(justify(`${RED}left${RESET}`, 'right', 20))).toBe(20);
    expect(visibleWidth(justify('日本語', 'right', 20))).toBe(20);
  });

  it('keeps the right-hand side whole and truncates the left', () => {
    // The right end is the model and the context budget — the fields that
    // change. A bar that dropped them to keep a workspace name would be showing
    // the part nobody is watching.
    const line = justify('a-very-long-workspace-name', 'ollama/qwen3', 20);
    expect(line).toContain('ollama/qwen3');
    expect(visibleWidth(line)).toBeLessThanOrEqual(20);
  });

  it('leaves at least one column between them', () => {
    expect(justify('abcdefgh', 'right', 14)).toContain(' right');
  });

  it('gives the width to the right-hand side when both cannot fit', () => {
    expect(visibleWidth(justify('left', 'right', 4))).toBeLessThanOrEqual(4);
    expect(justify('left', 'right', 0)).toBe('');
  });
});

describe('rule', () => {
  it('is exactly the width asked for', () => {
    expect(visibleWidth(rule(10))).toBe(10);
    expect(rule(3)).toBe('───');
  });

  it('takes another character', () => {
    expect(rule(3, '=')).toBe('===');
  });

  it('is nothing at all for no width', () => {
    expect(rule(0)).toBe('');
    expect(rule(-2)).toBe('');
  });
});

describe('the properties the menu relies on', () => {
  // A column table is exactly the kind of code where a hand-picked example
  // passes and the next locale does not, so the three invariants `screen.ts`
  // actually depends on are asserted over generated input rather than samples.
  const anyText = fc.string({ unit: 'grapheme' });

  it('measures a stripped string the same as the string it was stripped from', () => {
    fc.assert(
      fc.property(anyText, (text) => {
        const styled = `${BOLD}${text}${RESET}`;
        expect(visibleWidth(styled)).toBe(visibleWidth(stripAnsi(styled)));
      }),
    );
  });

  it('never returns more columns than asked for', () => {
    fc.assert(
      fc.property(anyText, fc.integer({ min: 1, max: 40 }), (text, max) => {
        expect(visibleWidth(truncateToWidth(text, max))).toBeLessThanOrEqual(
          max,
        );
      }),
    );
  });

  it('pads to exactly the requested width whenever the text fits inside it', () => {
    fc.assert(
      fc.property(anyText, fc.integer({ min: 0, max: 40 }), (text, width) => {
        fc.pre(visibleWidth(text) <= width);
        expect(visibleWidth(padToWidth(text, width))).toBe(width);
      }),
    );
  });
});
