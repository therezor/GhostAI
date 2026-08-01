/**
 * Five-field cron, evaluated in an IANA timezone.
 *
 * Hand-written rather than a dependency, for the same reason the rest of this
 * package is: a scheduled job is the one feature that must keep working on an
 * install that has never reached a registry, and "what fires at 2am" is not a
 * question worth answering by reading someone else's transitive tree.
 *
 * Three decisions carry the whole file.
 *
 * **The dialect is exactly five fields.** A six- or seven-field expression is
 * refused by name rather than absorbed. Every cron dialect that grew a seconds
 * column put it at the *front*, so reading `0 * * * * *` as a five-field
 * expression plus a stray does not run something slightly wrong — it runs it
 * sixty times more often than the operator asked for, and it does so silently.
 *
 * **Day-of-month and day-of-week are OR, not AND, but only when both are
 * restricted.** `0 0 13 * 5` is "the 13th, and also every Friday", not "Friday
 * the 13th". This is the single most misimplemented rule in cron and it is the
 * reason `CronSpec` carries `domRestricted` / `dowRestricted` rather than
 * inferring intent from a full set: `*` and `0-6` produce identical sets and
 * mean different things.
 *
 * **Time arithmetic never happens in local time.** A wall-clock time is not a
 * quantity — it can fail to exist and it can happen twice — so nothing here
 * adds an hour to a local time and hopes. The search walks *calendar days*,
 * which advance identically in every zone, and converts a matched wall-clock
 * slot to an instant through `Intl`, verifying the round trip. A slot that does
 * not round-trip did not exist (spring forward) and is skipped; an ambiguous
 * one (fall back) resolves to the earlier instant, so it fires once.
 *
 * That last rule has a consequence worth stating rather than discovering: an
 * hourly job sees the repeated wall-clock hour once, so on a fall-back night
 * there is a single two-hour gap in real time. The alternative — firing on both
 * instants — means a job the operator wrote as "hourly" running twenty-five
 * times that day, and a heartbeat billing for it. Once is the answer.
 */

import { GhostError } from './errors.js';

/** Cap on the forward search. `0 0 30 2 *` matches nothing, ever. */
const MAX_SEARCH_DAYS = 1464;

/**
 * Cap on slots examined across the whole search.
 *
 * The day walk is bounded above, but a pathological expression could still ask
 * for 1440 instant conversions a day for four years. This is the backstop that
 * keeps `nextCronRun` a function rather than a hang; a real expression returns
 * within a handful.
 */
const MAX_SLOT_PROBES = 100_000;

const MONTH_NAMES: Readonly<Record<string, number>> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

const DAY_NAMES: Readonly<Record<string, number>> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

/**
 * A parsed expression.
 *
 * Values are sorted ascending arrays rather than sets: every consumer iterates
 * them in order looking for the first match, and a `Set` has no order to
 * promise. Membership tests are over ranges small enough (≤60) that a linear
 * scan is not worth a second structure.
 */
export interface CronSpec {
  /** 0–59, ascending. */
  readonly minutes: readonly number[];
  /** 0–23, ascending. */
  readonly hours: readonly number[];
  /** 1–31, ascending. */
  readonly daysOfMonth: readonly number[];
  /** 1–12, ascending. */
  readonly months: readonly number[];
  /** 0–6, Sunday is 0, ascending. */
  readonly daysOfWeek: readonly number[];
  /** Whether the day-of-month field was anything but `*`. Drives the OR rule. */
  readonly domRestricted: boolean;
  /** Whether the day-of-week field was anything but `*`. Drives the OR rule. */
  readonly dowRestricted: boolean;
  /** IANA name. The host zone when absent. */
  readonly tz: string | undefined;
}

interface LocalParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

/**
 * One formatter per zone, kept.
 *
 * `Intl.DateTimeFormat` construction is the expensive half of this file and the
 * search calls it per candidate slot. The map is unbounded only in the sense
 * that zones are: they come from a job's `tz`, which an operator types, so the
 * live set is the number of zones an install has jobs in.
 */
const FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function formatterFor(tz: string | undefined): Intl.DateTimeFormat {
  const key = tz ?? '';
  const cached = FORMATTERS.get(key);
  if (cached !== undefined) return cached;
  const created = new Intl.DateTimeFormat('en-US', {
    ...(tz === undefined ? {} : { timeZone: tz }),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    // `h23` rather than `hour12: false`, which is specified to produce hour 24
    // for midnight in some locales — a value no arithmetic here expects.
    hourCycle: 'h23',
  });
  FORMATTERS.set(key, created);
  return created;
}

function partsOf(instantMs: number, tz: string | undefined): LocalParts {
  const parts = formatterFor(tz).formatToParts(new Date(instantMs));
  let year = 0;
  let month = 1;
  let day = 1;
  let hour = 0;
  let minute = 0;
  let second = 0;
  for (const part of parts) {
    const value = Number.parseInt(part.value, 10);
    if (Number.isNaN(value)) continue;
    if (part.type === 'year') year = value;
    else if (part.type === 'month') month = value;
    else if (part.type === 'day') day = value;
    else if (part.type === 'hour') hour = value;
    else if (part.type === 'minute') minute = value;
    else if (part.type === 'second') second = value;
  }
  return { year, month, day, hour, minute, second };
}

/** Wide enough to bracket any DST transition. See `instantOfLocal`. */
const DAY_MS = 86_400_000;

/** Milliseconds to add to UTC to reach local wall-clock time at this instant. */
function offsetAt(instantMs: number, tz: string | undefined): number {
  const p = partsOf(instantMs, tz);
  const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asIfUtc - Math.floor(instantMs / 1000) * 1000;
}

/**
 * The instant at which the local wall clock reads exactly this, or `null`.
 *
 * `null` means the time does not exist — the hour a spring-forward transition
 * skips. Where the time exists twice, the **earlier** instant wins, so a job at
 * 01:30 on a fall-back night runs once rather than twice.
 *
 * The offset has to be discovered rather than assumed, and discovering it needs
 * an instant, which is what we are solving for. So the offset is sampled at
 * three points — a day before, at the naive guess, and a day after — and each
 * sample yields a candidate instant. Away from a transition all three agree and
 * the loop below runs once for nothing; across one they disagree, which is
 * exactly when more than one candidate is worth testing.
 *
 * **The day either side is what makes "the earlier instant" reachable**, and it
 * is the fix for a case this used to get backwards. Probing only at the guess
 * and at the instant it corrects to cannot find both sides of a fall-back: both
 * probes land after the transition, so they read the same post-transition
 * offset, the pre-transition candidate is never generated, and the *later*
 * instant wins by default — the opposite of what the header promises. No
 * transition is more than a day wide, so a day either side brackets any of them.
 */
function instantOfLocal(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  tz: string | undefined,
): number | null {
  const asIfUtc = Date.UTC(year, month - 1, day, hour, minute, 0);
  const candidates = new Set<number>();
  for (const probe of [asIfUtc - DAY_MS, asIfUtc, asIfUtc + DAY_MS]) {
    candidates.add(asIfUtc - offsetAt(probe, tz));
  }

  let best: number | null = null;
  for (const candidate of candidates) {
    const p = partsOf(candidate, tz);
    const roundTrips =
      p.year === year &&
      p.month === month &&
      p.day === day &&
      p.hour === hour &&
      p.minute === minute;
    if (!roundTrips) continue;
    if (best === null || candidate < best) best = candidate;
  }
  return best;
}

function fail(expr: string, detail: string): never {
  throw new GhostError('config', `Invalid cron expression "${expr}": ${detail}`, {
    details: { expr },
  });
}

function parseValue(
  raw: string,
  min: number,
  max: number,
  names: Readonly<Record<string, number>> | undefined,
  expr: string,
  field: string,
): number {
  const named = names?.[raw.toLowerCase()];
  const value = named ?? Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || String(value) !== raw.trim()) {
    if (named === undefined) fail(expr, `"${raw}" is not a value ${field} accepts.`);
  }
  if (value < min || value > max) {
    fail(expr, `${field} must be between ${String(min)} and ${String(max)}, got ${raw}.`);
  }
  return value;
}

/**
 * One field to the sorted values it matches.
 *
 * Accepts a star, `a`, `a-b`, and a `/step` suffix on any of those. `a/n` — a
 * bare start with a step, meaning "from a to the end of the range" — is the one
 * common extension included, because operators reach for `0/15` as often as the
 * star form, and refusing it teaches nothing.
 */
function parseField(
  raw: string,
  min: number,
  max: number,
  names: Readonly<Record<string, number>> | undefined,
  expr: string,
  field: string,
  normalise?: (value: number) => number,
): number[] {
  const matched = new Set<number>();

  for (const item of raw.split(',')) {
    const term = item.trim();
    if (term === '') fail(expr, `${field} has an empty term.`);

    const [rangePart = '', stepPart, ...extra] = term.split('/');
    if (extra.length > 0) fail(expr, `${field} has more than one step in "${term}".`);

    let step = 1;
    if (stepPart !== undefined) {
      step = Number.parseInt(stepPart, 10);
      if (!Number.isInteger(step) || step < 1 || String(step) !== stepPart.trim()) {
        fail(expr, `${field} has a step that is not a positive whole number: "${stepPart}".`);
      }
    }

    let from: number;
    let to: number;
    if (rangePart === '*') {
      from = min;
      to = max;
    } else if (rangePart.includes('-')) {
      const [lo = '', hi = '', ...rest] = rangePart.split('-');
      if (rest.length > 0) fail(expr, `${field} has a malformed range "${rangePart}".`);
      from = parseValue(lo, min, max, names, expr, field);
      to = parseValue(hi, min, max, names, expr, field);
      if (from > to) fail(expr, `${field} range "${rangePart}" runs backwards.`);
    } else {
      from = parseValue(rangePart, min, max, names, expr, field);
      // A bare value with a step runs to the end of the range; without one it is
      // just itself.
      to = stepPart === undefined ? from : max;
    }

    for (let value = from; value <= to; value += step) {
      matched.add(normalise === undefined ? value : normalise(value));
    }
  }

  return [...matched].sort((a, b) => a - b);
}

/**
 * Parses a five-field expression, and validates `tz` while a caller is still
 * holding the request that supplied it.
 *
 * Both failures are `config` rather than `invalid_input` so the REST layer maps
 * them to the same 422 naming the field: an unparseable schedule and an
 * unknown zone are the same mistake from the operator's side, and neither may
 * become a job that silently never fires.
 */
export function parseCron(expr: string, tz?: string): CronSpec {
  if (tz !== undefined) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz });
    } catch {
      throw new GhostError('config', `Unknown timezone "${tz}".`, { details: { tz } });
    }
  }

  const fields = expr.trim().split(/\s+/u).filter(Boolean);
  if (fields.length !== 5) {
    fail(
      expr,
      fields.length > 5
        ? `expected 5 fields and got ${String(fields.length)}. Seconds and years are not supported.`
        : `expected 5 fields and got ${String(fields.length)}.`,
    );
  }

  const [minute = '', hour = '', dom = '', month = '', dow = ''] = fields;

  return {
    minutes: parseField(minute, 0, 59, undefined, expr, 'minute'),
    hours: parseField(hour, 0, 23, undefined, expr, 'hour'),
    daysOfMonth: parseField(dom, 1, 31, undefined, expr, 'day-of-month'),
    months: parseField(month, 1, 12, MONTH_NAMES, expr, 'month'),
    // 7 is Sunday in every dialect that accepts it, and 0 already is here.
    daysOfWeek: parseField(dow, 0, 7, DAY_NAMES, expr, 'day-of-week', (v) => v % 7),
    domRestricted: dom.trim() !== '*',
    dowRestricted: dow.trim() !== '*',
    // Present-and-undefined rather than absent, matching `Clock`'s neighbours
    // in this package: `CronSpec` declares it `string | undefined` so that
    // reading `spec.tz` is always legal and always means "the host zone".
    tz,
  };
}

/** Whether a calendar day satisfies the month and the day-of-* rule. */
function dayMatches(spec: CronSpec, year: number, month: number, day: number): boolean {
  if (!spec.months.includes(month)) return false;

  const domHit = spec.daysOfMonth.includes(day);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  const dowHit = spec.daysOfWeek.includes(weekday);

  // The rule: restricted on both sides means either may satisfy it. Restricted
  // on one means the other is `*`, whose set is full, so the AND below is the
  // same answer written once.
  return spec.domRestricted && spec.dowRestricted ? domHit || dowHit : domHit && dowHit;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * The first instant strictly after `afterMs` that the expression matches, or
 * `null` when there is none within the search bound.
 *
 * `null` is a real answer, not a failure: `0 0 30 2 *` is a legal expression
 * that never matches, and a caller writes it down as "unscheduled, here is why"
 * rather than retrying forever.
 *
 * The walk is over calendar days rather than minutes because a day is the
 * coarsest unit the day-of-* rules decide, and because a calendar day advances
 * the same way in every zone — the one piece of local-time arithmetic that is
 * safe. Only a day that matches pays for instant conversion.
 */
export function nextCronRun(spec: CronSpec, afterMs: number): number | null {
  const start = partsOf(afterMs, spec.tz);
  let { year, month, day } = start;
  let probes = 0;

  for (let dayIndex = 0; dayIndex < MAX_SEARCH_DAYS; dayIndex += 1) {
    if (dayMatches(spec, year, month, day)) {
      for (const hour of spec.hours) {
        for (const minute of spec.minutes) {
          probes += 1;
          if (probes > MAX_SLOT_PROBES) return null;
          const instant = instantOfLocal(year, month, day, hour, minute, spec.tz);
          // `null` is a wall-clock time the zone skipped. Not an error, and not
          // a reason to stop: the job simply has no occurrence in the hour that
          // did not happen, and the next slot is the right answer.
          if (instant !== null && instant > afterMs) return instant;
        }
      }
    }

    day += 1;
    if (day > daysInMonth(year, month)) {
      day = 1;
      month += 1;
      if (month > 12) {
        month = 1;
        year += 1;
      }
    }
  }

  return null;
}
