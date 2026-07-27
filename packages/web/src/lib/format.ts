/**
 * The small formatters the transcript needs.
 *
 * Here rather than inline in a component for one reason: every one of them has
 * a boundary that is easy to get wrong and invisible when it is — 59.9 seconds
 * rounding to "60s", a zero-byte file reading as "NaN B", a tool that finished
 * in under a millisecond reporting "0ms" as though it never ran. They are three
 * lines each and they have tests.
 */

/**
 * A duration a human reads at a glance.
 *
 * Sub-second stays in milliseconds because that is the resolution that
 * distinguishes a cache hit from a request; past a minute the seconds are
 * still shown, because "2m" for a 2m59s command reads as a rounding error.
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${String(Math.round(ms))}ms`;

  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) {
    // One decimal below ten seconds, where the difference is worth seeing.
    return totalSeconds < 10 ? `${(ms / 1000).toFixed(1)}s` : `${String(totalSeconds)}s`;
  }

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${String(minutes)}m ${String(seconds).padStart(2, '0')}s`;

  const hours = Math.floor(minutes / 60);
  return `${String(hours)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

/**
 * How long ago something happened, for a list that is read at a glance.
 *
 * `now` is a parameter rather than a `Date.now()` call so the boundaries can be
 * tested without a fake clock, and so a list re-rendering mid-scroll cannot show
 * two rows measured against two different instants.
 *
 * A timestamp slightly in the *future* reads as "just now" rather than
 * "-3s ago": the server and the browser have separate clocks, and a few seconds
 * of skew is normal rather than an error worth rendering.
 */
export function formatRelativeTime(atMs: number, now: number): string {
  if (!Number.isFinite(atMs)) return '—';

  const elapsed = now - atMs;
  if (elapsed < 60_000) return 'just now';

  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 60) return `${String(minutes)}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${String(hours)}h ago`;

  const days = Math.floor(hours / 24);
  // Past a week the relative form stops being informative — "23d ago" is worse
  // than a date, because nobody counts back three weeks in their head.
  return days < 7 ? `${String(days)}d ago` : formatDate(atMs);
}

/** An absolute date, in the browser's locale, for anything older than a week. */
export function formatDate(atMs: number): string {
  if (!Number.isFinite(atMs)) return '—';
  return new Date(atMs).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/**
 * A token count with thousands separators.
 *
 * Grouped by hand rather than through `toLocaleString`, because the separator
 * this returns is compared in tests and a machine set to `de-DE` would produce
 * `8.192` — a number that reads as eight in the one panel whose entire job is
 * making a budget legible.
 */
export function formatTokens(tokens: number): string {
  if (!Number.isFinite(tokens)) return '—';

  const rounded = Math.round(Math.abs(tokens));
  const grouped = String(rounded).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return tokens < 0 ? `-${grouped}` : grouped;
}

const UNITS = ['B', 'kB', 'MB', 'GB', 'TB'] as const;

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1000) return `${String(Math.round(bytes))} B`;

  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < UNITS.length - 1) {
    value /= 1000;
    unit += 1;
  }

  return `${value < 10 ? value.toFixed(1) : String(Math.round(value))} ${UNITS[unit] ?? 'B'}`;
}

/**
 * Tool arguments as one line, for the collapsed header.
 *
 * The arguments are whatever the model emitted — an object when the JSON
 * parsed, the raw string when it did not — so this has to survive both. It is a
 * preview and not a serialisation: it is truncated, and the expanded card shows
 * the real thing.
 */
export function summariseArgs(args: unknown, maxChars = 80): string {
  if (args === undefined || args === null) return '';

  const text = typeof args === 'string' ? args : stringify(args);
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length <= maxChars ? oneLine : `${oneLine.slice(0, maxChars - 1)}…`;
}

/** Pretty JSON when it is JSON, and the string itself when it never was. */
export function formatArgs(args: unknown): string {
  if (typeof args === 'string') return args;
  return stringify(args, 2);
}

function stringify(value: unknown, space?: number): string {
  // `JSON.stringify` is typed as returning `string` and returns `undefined` for
  // exactly these two. Neither can arrive from a JSON wire format, but `args` is
  // `unknown`, so the guard is here rather than in the type system.
  if (value === undefined || typeof value === 'function') return typeof value;

  try {
    return JSON.stringify(value, null, space);
  } catch {
    // A cycle, or a BigInt. Neither can reach here from a JSON wire format,
    // but `args` is typed `unknown` and this is the honest handling of that.
    // Not `String(value)`: on the object that just failed to serialise, that
    // produces `[object Object]`, which tells the reader nothing at all.
    return '[unserialisable]';
  }
}
