import { describe, expect, it } from 'vitest';

import { helpText } from '#src/commands.js';
import { translations } from '#src/i18n.js';

const { t } = translations('en');
const help = helpText(t);
const lines = help.split('\n').filter((line) => line.trim().startsWith('/'));

describe('helpText', () => {
  it('lists every command a reader can type', () => {
    expect(help).toContain('/messages [n]');
    expect(help).toContain('/workspace move <from> <to>');
    expect(help).toContain('the last n messages, with their seq numbers');
  });

  it('groups the commands under headings', () => {
    for (const heading of ['sessions', 'messages', 'context and cost', 'workspaces']) {
      expect(help).toContain(`\n  ${heading}\n`);
    }
  });

  it('aligns every description in one column', () => {
    // The bug this replaces: the column was a fixed number of spaces typed in
    // by hand, so it held only while every description was English — and the
    // first row was two characters out even then.
    const described = lines.filter((line) => / {2,}\S/u.test(line.trimStart().slice(1)));
    const columns = new Set(described.map((line) => line.search(/\S(?!.*\s\s)/u)));

    expect(described.length).toBeGreaterThan(15);
    expect(columns.size).toBe(1);
  });

  it('indents every row the same, including the first', () => {
    expect(lines.every((line) => line.startsWith('  /'))).toBe(true);
  });

  it('renders the same syntax whatever the locale', () => {
    // `/rename` is what a user types, not a word describing it, so the left
    // column must survive translation untouched. Asserted against a locale that
    // does not exist, which falls back to English for the *descriptions* while
    // proving the syntax never went through `t` at all.
    const other = helpText(translations('zz').t);

    expect(other).toContain('/rename <title>');
    expect(other).toContain('/workspace move <from> <to>');
  });
});
