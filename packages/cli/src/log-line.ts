/**
 * A pino record, as one line a person can read.
 *
 * The logger writes JSON because that is what a log is for — `ghostai serve
 * 2>ghost.log` produces something `jq` can answer questions about, and every
 * field is there on purpose. In a chat window it is the wrong shape entirely: a
 * wall of `{"level":40,"time":1786007865399,…}` between two turns says nothing
 * at a glance and buries the one part that matters, which is the sentence.
 *
 * So the JSON is what gets written, and this is what gets *shown* — and only
 * when the stream is a terminal this process is drawing into. A redirected
 * stderr still receives the record verbatim, because the thing reading it then
 * is a program.
 *
 * **A line that cannot be parsed is passed through unchanged.** This runs over
 * whatever reaches the destination, and losing a log line to a formatter is a
 * worse failure than showing an ugly one — including for the case that matters
 * most, a crash whose output is not a record at all.
 */

import type { Palette } from '@ghostwire/tui';

/** pino's numeric levels. Anything else prints as the number it was. */
const LEVELS: Readonly<Record<number, string>> = {
  10: 'trace',
  20: 'debug',
  30: 'info',
  40: 'warn',
  50: 'error',
  60: 'fatal',
};

/**
 * How each level is painted.
 *
 * **The word stays whatever the colour does.** `@ghostwire/tui`'s theme states the
 * rule this follows — colour is never the only signal — so `warn` reads as
 * `warn` under `NO_COLOR`, in a pipe, and to anyone who cannot tell the yellow
 * from the red. The colour is what makes it findable while scrolling, not what
 * makes it legible.
 *
 * The low levels are dimmed rather than left plain: at `--verbose` they are the
 * bulk of what arrives, and they are the half a reader is skimming past to find
 * the one line that matters.
 */
function paintLevel(c: Palette, level: string): string {
  switch (level) {
    case 'fatal':
    case 'error':
      return c.red(level);
    case 'warn':
      return c.yellow(level);
    case 'trace':
    case 'debug':
      return c.dim(level);
    default:
      return level;
  }
}

/**
 * Fields every record carries, which say nothing a reader wants.
 *
 * `time` goes because the line is being read as it happens; `pid` and
 * `hostname` because there is one process and it is this one; `name` because it
 * is `ghostai` on every line this formatter will ever see.
 */
const NOISE: ReadonlySet<string> = new Set([
  'level',
  'time',
  'pid',
  'hostname',
  'name',
  'msg',
]);

/** How much of one field's value survives. Long enough to identify, not to wrap. */
const MAX_VALUE_CHARS = 120;

export function formatLogLine(line: string, c: Palette): string {
  const trimmed = line.trim();
  if (trimmed === '') return line;

  let record: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed)
    ) {
      return line;
    }
    record = parsed as Record<string, unknown>;
  } catch {
    return line;
  }

  const message = typeof record.msg === 'string' ? record.msg : '';
  // No `msg` means this is not one of ours — a record from a library logging
  // its own shape, say. Its JSON is more informative than a level and a blank.
  if (message === '') return line;

  const level = record.level;
  const label =
    typeof level === 'number' ? (LEVELS[level] ?? String(level)) : 'log';

  const context = Object.entries(record)
    .filter(([key]) => !NOISE.has(key))
    .map(([key, value]) => `${key}=${render(value)}`)
    .join(' ');

  const head = `${paintLevel(c, label)}  ${message}`;
  // The context is dimmed as a whole: it is what identifies *which* thing the
  // sentence is about, which matters only once the sentence has been read.
  return context === '' ? `${head}\n` : `${head} ${c.dim(`· ${context}`)}\n`;
}

/**
 * One field's value, flattened.
 *
 * An object is re-serialised rather than spread, because a nested `err` is one
 * fact about the line and not several — and a formatter that walked into it
 * would reintroduce the wall of JSON this exists to avoid.
 *
 * `JSON.stringify` cannot answer `undefined` here, which it can in general: it
 * does that for a function, a symbol or `undefined` itself, and every value
 * reaching this came out of `JSON.parse`, so it is a JSON value or nothing.
 */
function render(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const flat = text.replaceAll(/\s+/gu, ' ');
  return flat.length <= MAX_VALUE_CHARS
    ? flat
    : `${flat.slice(0, MAX_VALUE_CHARS - 1)}…`;
}
