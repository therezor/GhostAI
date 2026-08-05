import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  MAX_MESSAGE_CHARS,
  chunkMessage,
  escapeMarkdownV2,
  toMarkdownV2,
} from '#src/telegram/format.js';

/** The eighteen MarkdownV2 reserves, plus the backslash that escapes them. */
const RESERVED = '_*[]()~`>#+-=|{}.!\\';

describe('escapeMarkdownV2', () => {
  it('escapes every reserved character', () => {
    const escaped = escapeMarkdownV2(RESERVED);

    expect(escaped).toBe(
      Array.from(RESERVED, (character) => `\\${character}`).join(''),
    );
  });

  it('leaves ordinary prose alone', () => {
    expect(escapeMarkdownV2('hello world')).toBe('hello world');
  });

  it('escapes the full stop that ends a sentence', () => {
    // The single commonest way to earn a `can't parse entities` 400.
    expect(escapeMarkdownV2('Done.')).toBe('Done\\.');
  });
});

describe('toMarkdownV2', () => {
  it('passes a fenced block through with only backticks escaped', () => {
    const out = toMarkdownV2('```ts\nconst a = b.c;\n```');

    // The `.` inside code is untouched: escaping it would render as `b\.c`.
    expect(out).toBe('```ts\nconst a = b.c;\n```');
  });

  it('escapes prose around a fenced block', () => {
    const out = toMarkdownV2('Here.\n```\nx = 1.0\n```\nDone.');

    expect(out).toContain('Here\\.');
    expect(out).toContain('x = 1.0');
    expect(out).toContain('Done\\.');
  });

  it('keeps inline code as code', () => {
    expect(toMarkdownV2('run `npm i -D x` now')).toBe('run `npm i -D x` now');
  });

  it('escapes a backtick inside inline code', () => {
    expect(toMarkdownV2('`a\\b`')).toBe('`a\\\\b`');
  });

  it('rewrites ** bold ** into MarkdownV2’s single asterisk', () => {
    expect(toMarkdownV2('a **bold** word')).toBe('a *bold* word');
  });

  it('keeps underscore italics', () => {
    expect(toMarkdownV2('an _italic_ word')).toBe('an _italic_ word');
  });

  it('escapes an unpaired asterisk rather than opening an entity', () => {
    // A half-finished sentence from a truncated turn must still send.
    expect(toMarkdownV2('2 ** 8')).toBe('2 \\*\\* 8');
  });

  it('does not treat a snake_case identifier as italics', () => {
    expect(toMarkdownV2('read_file and write_file')).toBe(
      'read\\_file and write\\_file',
    );
  });

  it('treats an unterminated fence as prose rather than failing', () => {
    // A turn that hit its iteration limit mid-code-block produces exactly this.
    const out = toMarkdownV2('```ts\nconst a = 1.');

    expect(out).toContain('\\.');
    expect(out).toContain('\\`\\`\\`');
  });

  it('leaves an empty message empty', () => {
    expect(toMarkdownV2('')).toBe('');
  });
});

describe('chunkMessage', () => {
  it('leaves a message that fits as one piece', () => {
    expect(chunkMessage('short')).toEqual(['short']);
  });

  it('cuts on a line boundary rather than mid-line', () => {
    const chunks = chunkMessage('aaaa\nbbbb\ncccc', 10);

    expect(chunks.every((chunk) => !chunk.startsWith('a'))).toBe(false);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(10);
  });

  it('never ends a piece on a dangling backslash', () => {
    // Half an escape sequence sends a stray backslash and leaves the character
    // it was protecting unescaped at the head of the next message.
    const line = '\\.'.repeat(40);
    const chunks = chunkMessage(line, 11);

    for (const chunk of chunks) expect(chunk.endsWith('\\')).toBe(false);
  });

  it('closes and reopens a fence that spans a cut', () => {
    const body = Array.from({ length: 20 }, (slot, i) => `line ${String(i)}`);
    const chunks = chunkMessage(`\`\`\`\n${body.join('\n')}\n\`\`\``, 60);

    expect(chunks.length).toBeGreaterThan(1);
    // Every piece carries an even number of fence markers, which is what makes
    // it valid on its own.
    for (const chunk of chunks) {
      expect((chunk.match(/```/gu) ?? []).length % 2).toBe(0);
    }
  });

  it('does not reopen a fence that closed on the boundary', () => {
    const chunks = chunkMessage('```\nabc\n```\n\nthen prose here', 16);
    const last = chunks.at(-1);

    expect(last).not.toContain('```');
  });

  it('returns one empty piece for empty input', () => {
    // A caller that is sending a message must get something to send.
    expect(chunkMessage('')).toEqual(['']);
  });

  it('never exceeds the limit, for any text', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 2000 }), (text) => {
        for (const chunk of chunkMessage(text, 40)) {
          expect(chunk.length).toBeLessThanOrEqual(40);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('keeps every non-newline character, for any text', () => {
    // Reassembly is lossy by exactly the separators and the synthetic fences,
    // so the property is about characters surviving rather than a round trip.
    fc.assert(
      fc.property(
        fc.string({ maxLength: 500 }).filter((s) => !s.includes('`')),
        (text) => {
          const joined = chunkMessage(text, 40).join('\n');
          const strip = (s: string): string => s.replaceAll('\n', '');
          expect(strip(joined)).toBe(strip(text));
        },
      ),
      { numRuns: 200 },
    );
  });

  it('uses Telegram’s own ceiling by default', () => {
    expect(MAX_MESSAGE_CHARS).toBe(4096);
    expect(chunkMessage('x'.repeat(5000))).toHaveLength(2);
  });
});
