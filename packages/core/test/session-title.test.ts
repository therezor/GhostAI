import { describe, expect, it } from 'vitest';

import { MAX_TITLE_CHARS, deriveSessionTitle } from '#src/session-title.js';

describe('deriveSessionTitle', () => {
  it('returns a short message unchanged', () => {
    expect(deriveSessionTitle('fix the login bug')).toBe('fix the login bug');
  });

  it('returns nothing for an empty message', () => {
    expect(deriveSessionTitle('')).toBe('');
    expect(deriveSessionTitle('   \n\t  ')).toBe('');
  });

  it('collapses newlines and runs of whitespace', () => {
    expect(deriveSessionTitle('fix   the\n\nlogin\tbug')).toBe(
      'fix the login bug',
    );
  });

  it('drops fenced code and keeps the prose around it', () => {
    const text =
      'why does this throw?\n\n```ts\nconst x: number = "no";\n```\n';
    expect(deriveSessionTitle(text)).toBe('why does this throw?');
  });

  it('names a code-only message after the code', () => {
    // Nothing else is available, and an unnamed conversation is worse than one
    // named after the snippet it is about.
    expect(deriveSessionTitle('```\nrg --files | wc -l\n```')).toBe(
      'rg --files | wc -l',
    );
  });

  it('strips mention tokens', () => {
    expect(deriveSessionTitle('@skill:runbooks how do I rotate the key')).toBe(
      'how do I rotate the key',
    );
    expect(
      deriveSessionTitle('check @mcp:github/issues and @skill:review please'),
    ).toBe('check and please');
  });

  it('strips leading markdown furniture', () => {
    expect(deriveSessionTitle('## Plan the migration')).toBe(
      'Plan the migration',
    );
    expect(deriveSessionTitle('- first item\n- second item')).toBe(
      'first item second item',
    );
    expect(deriveSessionTitle('1. step one\n2. step two')).toBe(
      'step one step two',
    );
    expect(deriveSessionTitle('> quoted question')).toBe('quoted question');
  });

  it('leaves a mid-line hash alone', () => {
    // Only *leading* furniture is markup; `#4` in a sentence is content.
    expect(deriveSessionTitle('look at issue #4 again')).toBe(
      'look at issue #4 again',
    );
  });

  it('cuts on a word boundary and keeps the ellipsis inside the budget', () => {
    const text =
      'the quick brown fox jumps over the lazy dog and keeps on running forever';
    const title = deriveSessionTitle(text, 30);

    expect(title.length).toBeLessThanOrEqual(30);
    expect(title.endsWith('…')).toBe(true);
    expect(title).toBe('the quick brown fox jumps…');
  });

  it('hard-cuts when no space falls near the budget', () => {
    const title = deriveSessionTitle(`short ${'x'.repeat(60)}`, 20);

    expect(title.length).toBe(20);
    expect(title.endsWith('…')).toBe(true);
  });

  it('never exceeds the default budget', () => {
    const title = deriveSessionTitle('word '.repeat(200));
    expect(title.length).toBeLessThanOrEqual(MAX_TITLE_CHARS);
  });

  it('returns nothing for a non-positive budget', () => {
    expect(deriveSessionTitle('anything', 0)).toBe('');
  });

  it('does not leave a trailing space before the ellipsis', () => {
    const title = deriveSessionTitle('alpha beta gamma delta epsilon zeta', 18);
    expect(title).not.toContain(' …');
  });
});
