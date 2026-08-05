import { describe, expect, it } from 'vitest';

import { parseFrontmatter } from '#src/frontmatter.js';

describe('parseFrontmatter', () => {
  it('splits the fenced block from the body', () => {
    const parsed = parseFrontmatter(
      ['---', 'name: review', 'description: Read a diff.', '---', '', 'Body.'] //
        .join('\n'),
    );

    expect(parsed.fields).toEqual({
      name: 'review',
      description: 'Read a diff.',
    });
    expect(parsed.body).toBe('Body.');
  });

  it('treats a file with no fence as all body', () => {
    const parsed = parseFrontmatter('# Just markdown\n\nNo fence here.');

    expect(parsed.fields).toEqual({});
    expect(parsed.body).toBe('# Just markdown\n\nNo fence here.');
  });

  it('treats an unterminated fence as all body', () => {
    // The alternative reading — everything after the opening fence is
    // frontmatter — turns one missing line into a skill with no instructions,
    // which is the failure nobody would look for.
    const parsed = parseFrontmatter('---\ndescription: Oops.\n\nThe body.');

    expect(parsed.fields).toEqual({});
    expect(parsed.body).toContain('The body.');
  });

  it('finds the closing fence through CRLF line endings', () => {
    const parsed = parseFrontmatter('---\r\ndescription: A.\r\n---\r\nBody.');

    expect(parsed.fields.description).toBe('A.');
    expect(parsed.body).toBe('Body.');
  });

  it('strips one matching pair of quotes, and only a matching pair', () => {
    const parsed = parseFrontmatter(
      ['---', 'a: "quoted"', "b: 'single'", 'c: "unbalanced', '---', ''] //
        .join('\n'),
    );

    expect(parsed.fields).toEqual({
      a: 'quoted',
      b: 'single',
      c: '"unbalanced',
    });
  });

  it('leaves a lone quote alone rather than deleting it', () => {
    // A one-character value cannot be a quoted pair, and stripping it would
    // turn a typo into an empty field.
    expect(parseFrontmatter('---\na: "\n---\n').fields.a).toBe('"');
  });

  it('keeps a colon inside a value', () => {
    const parsed = parseFrontmatter(
      '---\ndescription: Use it: it is good.\n---\n',
    );

    expect(parsed.fields.description).toBe('Use it: it is good.');
  });

  it('skips blank lines, comments and anything that is not key: value', () => {
    // Skipped rather than refused: a `tags:` list nobody reads is not a reason
    // to refuse the two fields that are read.
    const parsed = parseFrontmatter(
      [
        '---',
        '',
        '# a comment',
        'tags:',
        '  - one',
        'description: Kept.',
        '---',
        '',
      ].join('\n'),
    );

    expect(parsed.fields).toEqual({ tags: '', description: 'Kept.' });
  });

  it('lets a repeated key win last', () => {
    const parsed = parseFrontmatter('---\na: first\na: second\n---\n');

    expect(parsed.fields.a).toBe('second');
  });

  it('reads an empty value as empty rather than dropping the key', () => {
    const parsed = parseFrontmatter('---\ndescription:\n---\nBody.');

    expect(parsed.fields.description).toBe('');
  });
});
