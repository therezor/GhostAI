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
