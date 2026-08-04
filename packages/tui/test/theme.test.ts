import { describe, expect, it } from 'vitest';
import pc from 'picocolors';

import { stripAnsi } from '#src/text.js';
import { PLAIN_THEME, themeFor, themeFrom, type Theme } from '#src/theme.js';

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
