import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { DEFAULT_MIME_TYPE, MAX_TEXT_BYTES, mimeTypeFor, readText } from '#src/workspace-files.js';

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() ?? '', { recursive: true, force: true });
});

/** One temp directory, cleaned up after the test that made it. */
function workspace(): string {
  const created = mkdtempSync(join(tmpdir(), 'ghostai-workspace-files-'));
  roots.push(created);
  return created;
}

/** Writes `contents` and returns its absolute path and byte length. */
function file(contents: string | Buffer): { path: string; sizeBytes: number } {
  const path = join(workspace(), 'sample');
  const bytes = typeof contents === 'string' ? Buffer.from(contents, 'utf8') : contents;
  writeFileSync(path, bytes);
  return { path, sizeBytes: bytes.byteLength };
}

describe('mimeTypeFor', () => {
  it.each([
    ['photo.PNG', 'image/png'],
    ['notes.md', 'text/markdown; charset=utf-8'],
    ['data.json', 'application/json; charset=utf-8'],
  ])('maps %s', (path, expected) => {
    expect(mimeTypeFor(path)).toBe(expected);
  });

  // A type this table does not know downloads rather than executes, which is
  // the safe direction for a tree a language model writes to.
  it.each(['archive.7z', 'no-extension', 'script.sh'])('falls back for %s', (path) => {
    expect(mimeTypeFor(path)).toBe(DEFAULT_MIME_TYPE);
  });

  // The property everything downstream depends on: this table cannot be asked
  // whether a file is text. `readText` answers that, from the bytes.
  it.each(['module.ts', 'script.py', 'config.yaml'])('does not claim %s is text', (path) => {
    expect(mimeTypeFor(path)).toBe(DEFAULT_MIME_TYPE);
  });
});

describe('readText', () => {
  it('reads a whole small file', () => {
    const { path, sizeBytes } = file('date,amount\n2026-01-01,12\n');
    expect(readText(path, sizeBytes)).toEqual({
      content: 'date,amount\n2026-01-01,12\n',
      truncated: false,
    });
  });

  it('reads a source file the MIME table calls a binary', () => {
    // The reason the NUL heuristic exists: `.py` is `application/octet-stream`
    // and is obviously text.
    const { path, sizeBytes } = file('def main():\n    return 1\n');
    expect(readText(path, sizeBytes)?.content).toContain('def main()');
  });

  it('returns nothing for bytes holding a NUL', () => {
    const { path, sizeBytes } = file(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x1a]));
    expect(readText(path, sizeBytes)).toBeUndefined();
  });

  it('reads a prefix and says so past the cap', () => {
    const { path, sizeBytes } = file('x'.repeat(MAX_TEXT_BYTES + 10));
    const text = readText(path, sizeBytes);
    expect(text?.truncated).toBe(true);
    expect(text?.content).toHaveLength(MAX_TEXT_BYTES);
  });

  it('handles an empty file', () => {
    const { path } = file('');
    expect(readText(path, 0)).toEqual({ content: '', truncated: false });
  });
});
