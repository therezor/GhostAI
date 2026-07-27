/**
 * Workspace paths.
 *
 * The whole file exists because one directory has two spellings on the wire —
 * the listing route defaults its query to `.` and answers with `''` — so every
 * case here is about the two collapsing to one. A breadcrumb built from the raw
 * value would show an empty first crumb for `./a`, and a query key built from it
 * would cache the root twice.
 */

import { describe, expect, it } from 'vitest';

import {
  breadcrumbs,
  joinPath,
  MAX_TEXT_PREVIEW_BYTES,
  normalisePath,
  parentOf,
  previewKind,
  ROOT_PATH,
} from './paths.js';

describe('normalisePath', () => {
  it('collapses every spelling of the root', () => {
    expect(normalisePath('')).toBe(ROOT_PATH);
    expect(normalisePath('.')).toBe(ROOT_PATH);
    expect(normalisePath('./')).toBe(ROOT_PATH);
    expect(normalisePath('  ')).toBe(ROOT_PATH);
  });

  it('strips a leading ./ and a trailing slash', () => {
    expect(normalisePath('./a/b/')).toBe('a/b');
    expect(normalisePath('a/b')).toBe('a/b');
  });

  it('leaves a traversal alone, because judging it is the jail’s job', () => {
    // A second, weaker copy of the jail's rules in a component is worse than
    // none: it would be the one nobody security-tests.
    expect(normalisePath('../etc')).toBe('../etc');
  });
});

describe('breadcrumbs', () => {
  it('starts at the workspace even at the root', () => {
    expect(breadcrumbs(ROOT_PATH)).toEqual([{ label: 'workspace', path: ROOT_PATH }]);
  });

  it('accumulates a clickable path per segment', () => {
    expect(breadcrumbs('notes/2026/july')).toEqual([
      { label: 'workspace', path: '' },
      { label: 'notes', path: 'notes' },
      { label: '2026', path: 'notes/2026' },
      { label: 'july', path: 'notes/2026/july' },
    ]);
  });

  it('is unchanged by the other spelling of the same directory', () => {
    expect(breadcrumbs('./notes/')).toEqual(breadcrumbs('notes'));
  });
});

describe('joinPath', () => {
  it('does not produce a leading slash at the root', () => {
    expect(joinPath(ROOT_PATH, 'a.txt')).toBe('a.txt');
    expect(joinPath('.', 'a.txt')).toBe('a.txt');
  });

  it('joins inside a directory', () => {
    expect(joinPath('notes', 'a.txt')).toBe('notes/a.txt');
  });
});

describe('parentOf', () => {
  it('walks up one level, stopping at the root', () => {
    expect(parentOf('a/b/c.txt')).toBe('a/b');
    expect(parentOf('a.txt')).toBe(ROOT_PATH);
    expect(parentOf(ROOT_PATH)).toBe(ROOT_PATH);
  });
});

describe('previewKind', () => {
  it('reads the type the server assigned', () => {
    expect(previewKind('image/png')).toBe('image');
    expect(previewKind('text/markdown; charset=utf-8')).toBe('text');
    expect(previewKind('application/json; charset=utf-8')).toBe('text');
  });

  it('treats anything unrecognised as a download', () => {
    // `application/octet-stream` is exactly what the server answers for a type
    // it will not let a browser render inline, so an `<img>` around one would
    // draw a broken image over a refusal.
    expect(previewKind('application/octet-stream')).toBe('other');
    expect(previewKind(undefined)).toBe('other');
  });
});

describe('the preview limit', () => {
  it('is small enough that a log a turn produced cannot hang the tab', () => {
    expect(MAX_TEXT_PREVIEW_BYTES).toBeLessThanOrEqual(1024 * 1024);
  });
});
