import { describe, expect, it } from 'vitest';
import pc from 'picocolors';

import { stripAnsi } from '#src/text.js';
import {
  PLAIN_THEME,
  paletteFor,
  themeFor,
  themeFrom,
  type Theme,
} from '#src/theme.js';

const ESC = String.fromCharCode(27);
/** SGR 2, "faint" — the attribute this package deliberately does not use. */
const FAINT = `${ESC}[2m`;
/** SGR 90, bright black — the colour it uses instead. */
const BRIGHT_BLACK = `${ESC}[90m`;

const ROLES: ReadonlyArray<keyof Theme> = [
  'text',
  'dim',
  'cursor',
  'match',
  'title',
  'accent',
  'warn',
];

describe('PLAIN_THEME', () => {
  it('is the identity function in every role', () => {
    // What a pipe, `--no-color` and every test get. It is also why an assertion
    // can be written against the text rather than against escape sequences.
    for (const role of ROLES) {
      expect(PLAIN_THEME[role]('hello')).toBe('hello');
    }
  });
});

describe('themeFrom', () => {
  it('fills every role from the palette it was given', () => {
    const theme = themeFrom(pc.createColors(true));
    for (const role of ROLES) {
      expect(stripAnsi(theme[role]('hello'))).toBe('hello');
    }
  });

  it('distinguishes the cursor from an ordinary row', () => {
    const theme = themeFrom(pc.createColors(true));
    expect(theme.cursor('x')).not.toBe(theme.text('x'));
  });
});

describe('themeFor', () => {
  it('produces plain text when colour is switched off', () => {
    const theme = themeFor(false);
    for (const role of ROLES) {
      expect(theme[role]('hello')).toBe('hello');
    }
  });

  it('produces escape sequences when colour is switched on', () => {
    expect(themeFor(true).cursor('hello')).not.toBe('hello');
  });
});

describe('the accent', () => {
  it('is spent on the three marks that are the CLI’s own', () => {
    // The caret, the banner and the selected row. Colour that appears
    // everywhere stops meaning anything, and a transcript is mostly somebody
    // else's words.
    const theme = themeFor(true);

    expect(theme.accent('x')).not.toBe('x');
    expect(theme.accent('x')).toBe(theme.cursor('x'));
  });

  it('is the identity when colour is off, like every other role', () => {
    expect(themeFor(false).accent('x')).toBe('x');
    expect(PLAIN_THEME.accent('x')).toBe('x');
  });
});

describe('secondary text', () => {
  it('is a colour rather than the faint attribute', () => {
    // SGR 2 is optional in ECMA-48, and the Linux kernel console and PuTTY are
    // two of the terminals that do not implement it: colour worked there and
    // every hint, header label and status row drew at the weight of ordinary
    // prose. SGR 90 is a colour, and a terminal that ignores it draws plain
    // text — which is what those terminals were already doing.
    expect(paletteFor(true).dim('x')).toContain(BRIGHT_BLACK);
    expect(paletteFor(true).dim('x')).not.toContain(FAINT);
  });

  it('reaches the theme by both routes into it', () => {
    // `themeFor` builds through `paletteFor`, and `themeFrom` reads `gray`
    // itself — so a caller holding a palette straight from picocolors cannot
    // end up with the one attribute that does not render.
    expect(themeFor(true).dim('x')).toContain(BRIGHT_BLACK);
    expect(themeFrom(pc.createColors(true)).dim('x')).toContain(BRIGHT_BLACK);
    expect(themeFor(true).dim('x')).not.toContain(FAINT);
  });

  it('leaves the plain path alone', () => {
    // The rebinding is a no-op when colour is off: picocolors hands back the
    // identity for `gray` as for everything else, which is what keeps
    // `PLAIN_THEME` an accurate description of what a pipe gets.
    const plain = paletteFor(false);
    expect(plain.dim('hello')).toBe('hello');
    expect(plain.green('hello')).toBe('hello');
    expect(themeFor(false).dim('hello')).toBe('hello');
  });
});
