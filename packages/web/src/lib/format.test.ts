/**
 * The formatters, at their boundaries.
 *
 * Each of these is three lines with one place it can be wrong, and the wrong
 * version is invisible: 59.9 seconds reading as "60s", a zero-byte upload
 * reading as "NaN B", a tool whose arguments failed to serialise reading as
 * "[object Object]".
 */

import { describe, expect, it } from 'vitest';

import { formatArgs, formatBytes, formatDuration, summariseArgs } from './format.js';

describe('formatDuration', () => {
  it('keeps milliseconds below a second', () => {
    expect(formatDuration(0)).toBe('0ms');
    expect(formatDuration(999)).toBe('999ms');
  });

  it('shows a decimal below ten seconds, where the difference is worth seeing', () => {
    expect(formatDuration(1000)).toBe('1.0s');
    expect(formatDuration(9949)).toBe('9.9s');
    expect(formatDuration(10_000)).toBe('10s');
    expect(formatDuration(59_999)).toBe('59s');
  });

  it('keeps the seconds past a minute', () => {
    // "2m" for a 2m59s command reads as a rounding error.
    expect(formatDuration(179_000)).toBe('2m 59s');
    expect(formatDuration(60_000)).toBe('1m 00s');
  });

  it('folds into hours, and refuses nonsense', () => {
    expect(formatDuration(3_900_000)).toBe('1h 05m');
    expect(formatDuration(-1)).toBe('—');
    expect(formatDuration(Number.NaN)).toBe('—');
  });
});

describe('formatBytes', () => {
  it('handles the empty file and the boundary', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(999)).toBe('999 B');
    expect(formatBytes(1000)).toBe('1.0 kB');
  });

  it('climbs the units and stops at the top of the table', () => {
    expect(formatBytes(1_500_000)).toBe('1.5 MB');
    expect(formatBytes(12_000_000)).toBe('12 MB');
    expect(formatBytes(5e15)).toBe('5000 TB');
  });

  it('refuses nonsense', () => {
    expect(formatBytes(-5)).toBe('—');
  });
});

describe('tool arguments', () => {
  it('collapse to one line for the collapsed header', () => {
    expect(summariseArgs({ command: 'ls\n-la' })).toBe('{"command":"ls\\n-la"}');
  });

  it('truncate rather than wrap', () => {
    const long = summariseArgs({ text: 'x'.repeat(200) }, 20);

    expect(long).toHaveLength(20);
    expect(long.endsWith('…')).toBe(true);
  });

  it('survive the string a model emitted when its JSON did not parse', () => {
    expect(summariseArgs('{"command": ')).toBe('{"command":');
    expect(formatArgs('{"command": ')).toBe('{"command": ');
  });

  it('are nothing at all when there are none', () => {
    expect(summariseArgs(undefined)).toBe('');
    expect(summariseArgs(null)).toBe('');
  });

  it('pretty-print for the expanded card', () => {
    expect(formatArgs({ a: 1 })).toBe('{\n  "a": 1\n}');
  });

  it('say so rather than printing [object Object] when serialisation fails', () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;

    expect(formatArgs(cycle)).toBe('[unserialisable]');
  });
});
