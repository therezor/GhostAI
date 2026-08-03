import { describe, expect, it } from 'vitest';

import { coerceArgv } from '#src/argv.js';

describe('coerceArgv', () => {
  it('passes an argv through unchanged', () => {
    expect(coerceArgv(['--json', '-n', '3', 'sqlite wal'])).toEqual([
      '--json',
      '-n',
      '3',
      'sqlite wal',
    ]);
  });

  it('recovers the argument list a model half-serialised', () => {
    // Verbatim from a real call. An index marker at the front, a stray quote and
    // bracket at the back, the query in the middle. Refusing it is correct and
    // also a wasted turn: the model answers a validation error with another
    // broken string until the iteration cap.
    expect(coerceArgv('[0] SUFFOLK wildfire 2024 fires reports UK US news updates"]')).toEqual([
      'SUFFOLK',
      'wildfire',
      '2024',
      'fires',
      'reports',
      'UK',
      'US',
      'news',
      'updates',
    ]);
  });

  it('parses a properly stringified array', () => {
    // A model that got it nearly right should not be punished for the quotes.
    expect(coerceArgv('["--json", "-n", "3", "sqlite wal mode"]')).toEqual([
      '--json',
      '-n',
      '3',
      'sqlite wal mode',
    ]);
  });

  it('keeps a quoted phrase as one argument', () => {
    expect(coerceArgv('--site docs.python.org "async task group"')).toEqual([
      '--site',
      'docs.python.org',
      'async task group',
    ]);
    expect(coerceArgv("--query 'two words' --json")).toEqual(['--query', 'two words', '--json']);
  });

  it('treats an empty quoted string as an argument', () => {
    expect(coerceArgv('--name "" --json')).toEqual(['--name', '', '--json']);
  });

  it('never builds a pipeline out of a string', () => {
    // The argv contract is what keeps `guardExec`'s allow-list meaningful. Shell
    // operators survive as literal text inside whichever argument they landed in,
    // and are never interpreted.
    expect(coerceArgv('a | b > c ; d')).toEqual(['a', '|', 'b', '>', 'c', ';', 'd']);
    expect(coerceArgv('echo $HOME')).toEqual(['echo', '$HOME']);
  });

  it('gives an empty argv for nothing at all', () => {
    // Whether empty is *allowed* is `requiresArgs`' decision, not this one's.
    expect(coerceArgv('')).toEqual([]);
    expect(coerceArgv('   ')).toEqual([]);
    expect(coerceArgv(undefined)).toEqual([]);
    expect(coerceArgv(null)).toEqual([]);
    expect(coerceArgv(42)).toEqual([]);
  });

  it('stringifies whatever an array happens to hold', () => {
    // A model that sends `["-n", 3]` means `-n 3`, and the program takes text.
    expect(coerceArgv(['-n', 3])).toEqual(['-n', '3']);
  });

  it('leaves an empty JSON array empty rather than falling through to splitting', () => {
    expect(coerceArgv('[]')).toEqual([]);
  });
});
