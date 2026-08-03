import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { nextCronRun, parseCron, type CronSpec } from '#src/cron.js';
import { isGhostError } from '#src/errors.js';

/** The instant a zone's wall clock reads this, as an ISO-ish string for assertions. */
function localOf(instantMs: number, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
    .format(new Date(instantMs))
    .replace(', ', ' ');
}

function nextLocal(expr: string, tz: string, fromIso: string): string {
  const spec = parseCron(expr, tz);
  const next = nextCronRun(spec, Date.parse(fromIso));
  expect(next).not.toBeNull();
  return localOf(next!, tz);
}

describe('parseCron', () => {
  it('parses the five fields', () => {
    const spec = parseCron('30 9 * * *');
    expect(spec.minutes).toEqual([30]);
    expect(spec.hours).toEqual([9]);
    expect(spec.daysOfMonth).toHaveLength(31);
    expect(spec.months).toHaveLength(12);
    expect(spec.daysOfWeek).toHaveLength(7);
  });

  it('refuses a six-field expression by name rather than absorbing it', () => {
    // The failure this prevents is not "slightly wrong": read as five fields
    // plus a stray, `0 * * * * *` runs sixty times more often than asked.
    expect(() => parseCron('0 * * * * *')).toThrow(
      /Seconds and years are not supported/u,
    );
    expect(() => parseCron('* * * *')).toThrow(/expected 5 fields/u);
  });

  it('expands ranges, lists and steps', () => {
    expect(parseCron('0,30 * * * *').minutes).toEqual([0, 30]);
    expect(parseCron('*/15 * * * *').minutes).toEqual([0, 15, 30, 45]);
    expect(parseCron('10-13 * * * *').minutes).toEqual([10, 11, 12, 13]);
    expect(parseCron('10-20/5 * * * *').minutes).toEqual([10, 15, 20]);
  });

  it('accepts a bare start with a step, running to the end of the range', () => {
    expect(parseCron('0/20 * * * *').minutes).toEqual([0, 20, 40]);
  });

  it('accepts month and weekday names, case-insensitively', () => {
    expect(parseCron('0 0 1 JAN *').months).toEqual([1]);
    expect(parseCron('0 0 1 jan-mar *').months).toEqual([1, 2, 3]);
    expect(parseCron('0 0 * * mon,FRI').daysOfWeek).toEqual([1, 5]);
  });

  it('folds day-of-week 7 onto Sunday', () => {
    expect(parseCron('0 0 * * 7').daysOfWeek).toEqual([0]);
    expect(parseCron('0 0 * * 0,7').daysOfWeek).toEqual([0]);
  });

  it('records whether each day field was restricted, which `*` and `0-6` cannot show', () => {
    // Identical sets, different meanings — this is what the OR rule reads.
    expect(parseCron('0 0 * * *').dowRestricted).toBe(false);
    expect(parseCron('0 0 * * 0-6').dowRestricted).toBe(true);
    expect(parseCron('0 0 1-31 * *').domRestricted).toBe(true);
  });

  it('refuses out-of-range values, backwards ranges and bad steps', () => {
    expect(() => parseCron('60 * * * *')).toThrow(
      /minute must be between 0 and 59/u,
    );
    expect(() => parseCron('* 24 * * *')).toThrow(
      /hour must be between 0 and 23/u,
    );
    expect(() => parseCron('* * 0 * *')).toThrow(
      /day-of-month must be between 1 and 31/u,
    );
    expect(() => parseCron('* * * 13 *')).toThrow(
      /month must be between 1 and 12/u,
    );
    expect(() => parseCron('20-10 * * * *')).toThrow(/runs backwards/u);
    expect(() => parseCron('*/0 * * * *')).toThrow(/positive whole number/u);
    expect(() => parseCron('*/-2 * * * *')).toThrow(/positive whole number/u);
    expect(() => parseCron('1,,2 * * * *')).toThrow(/empty term/u);
  });

  it('refuses a value that is not a number or a known name', () => {
    expect(() => parseCron('* * * * funday')).toThrow(
      /not a value day-of-week accepts/u,
    );
  });

  it('throws a config GhostError, so the route can answer 422 instead of 500', () => {
    try {
      parseCron('nonsense');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(isGhostError(error)).toBe(true);
      expect((error as { kind: string }).kind).toBe('config');
    }
  });

  it('refuses an unknown timezone while the operator still has the request', () => {
    try {
      parseCron('0 9 * * *', 'Mars/Olympus_Mons');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(isGhostError(error)).toBe(true);
      expect((error as { kind: string }).kind).toBe('config');
      expect((error as Error).message).toMatch(/Unknown timezone/u);
    }
  });
});

describe('nextCronRun', () => {
  it('finds the next daily occurrence in the named zone, not the host zone', () => {
    // 08:00 UTC is 09:00 in Kyiv in winter, so a 09:00 Kyiv job is already past.
    expect(nextLocal('0 9 * * *', 'Europe/Kyiv', '2026-01-15T08:00:00Z')).toBe(
      '2026-01-16 09:00',
    );
    expect(nextLocal('0 9 * * *', 'Europe/Kyiv', '2026-01-15T06:00:00Z')).toBe(
      '2026-01-15 09:00',
    );
  });

  it('is strictly after the instant given, so a job does not refire on its own tick', () => {
    const spec = parseCron('0 9 * * *', 'UTC');
    const at = Date.parse('2026-01-15T09:00:00Z');
    expect(nextCronRun(spec, at)).toBe(Date.parse('2026-01-16T09:00:00Z'));
  });

  it('rolls over a month and a year boundary', () => {
    expect(nextLocal('0 0 1 * *', 'UTC', '2026-12-15T00:00:00Z')).toBe(
      '2027-01-01 00:00',
    );
    expect(nextLocal('0 0 * * *', 'UTC', '2026-02-28T12:00:00Z')).toBe(
      '2026-03-01 00:00',
    );
  });

  it('finds 29 February only in a leap year', () => {
    expect(nextLocal('0 0 29 2 *', 'UTC', '2026-03-01T00:00:00Z')).toBe(
      '2028-02-29 00:00',
    );
  });

  describe('the day-of-month / day-of-week OR rule', () => {
    it('matches either when both are restricted', () => {
      // "The 13th, and also every Friday" — not "Friday the 13th".
      const spec = parseCron('0 0 13 * 5', 'UTC');
      const from = Date.parse('2026-11-01T00:00:00Z');
      const first = nextCronRun(spec, from)!;
      // 6 November 2026 is a Friday and comes before the 13th.
      expect(localOf(first, 'UTC')).toBe('2026-11-06 00:00');
      expect(localOf(nextCronRun(spec, first)!, 'UTC')).toBe(
        '2026-11-13 00:00',
      );
    });

    it('applies only the restricted one when the other is `*`', () => {
      expect(nextLocal('0 0 13 * *', 'UTC', '2026-11-01T00:00:00Z')).toBe(
        '2026-11-13 00:00',
      );
      expect(nextLocal('0 0 * * 5', 'UTC', '2026-11-01T00:00:00Z')).toBe(
        '2026-11-06 00:00',
      );
    });

    it('treats an explicit full weekday range as restricted, so the OR applies', () => {
      // `0-6` covers every weekday, so ORing it with the 13th matches daily.
      expect(nextLocal('0 0 13 * 0-6', 'UTC', '2026-11-01T12:00:00Z')).toBe(
        '2026-11-02 00:00',
      );
    });
  });

  describe('daylight saving', () => {
    // London springs forward at 01:00 UTC on 29 March 2026: 01:00 -> 02:00
    // local, so 01:30 local does not exist that day.
    it('skips a wall-clock time the zone never reaches', () => {
      const next = nextLocal(
        '30 1 * * *',
        'Europe/London',
        '2026-03-28T12:00:00Z',
      );
      expect(next).toBe('2026-03-30 01:30');
    });

    it('still fires on a day whose skipped hour is not the scheduled one', () => {
      expect(
        nextLocal('30 3 * * *', 'Europe/London', '2026-03-28T12:00:00Z'),
      ).toBe('2026-03-29 03:30');
    });

    // New York falls back at 06:00 UTC on 1 November 2026: 02:00 -> 01:00
    // local, so 01:30 local happens twice.
    it('fires once on an ambiguous time, at the earlier instant', () => {
      const spec = parseCron('30 1 * * *', 'America/New_York');
      const from = Date.parse('2026-10-31T12:00:00Z');
      const first = nextCronRun(spec, from)!;
      expect(localOf(first, 'America/New_York')).toBe('2026-11-01 01:30');
      // The earlier of the two, which is EDT (UTC-4), not EST (UTC-5).
      expect(new Date(first).toISOString()).toBe('2026-11-01T05:30:00.000Z');

      // And the next one is the following day, not the second 01:30.
      const second = nextCronRun(spec, first)!;
      expect(localOf(second, 'America/New_York')).toBe('2026-11-02 01:30');
    });

    // Kyiv falls back at 01:00 UTC on 25 October 2026: 04:00 -> 03:00 local,
    // so 03:30 local happens twice.
    it('fires at the earlier instant east of UTC too, not just west of it', () => {
      // This is the case the old two-probe search got backwards, and the reason
      // it survived: the sign of the offset decides whether the naive guess
      // lands before or after the transition. West of UTC (New York, above) it
      // lands before, so the first probe reads the pre-transition offset and
      // the earlier instant falls out. East of UTC it lands *after*, both
      // probes read the post-transition offset, and the later instant won —
      // silently, in every European and Asian zone, against a header that
      // promised the opposite.
      const spec = parseCron('30 3 * * *', 'Europe/Kyiv');
      const from = Date.parse('2026-10-24T12:00:00Z');
      const first = nextCronRun(spec, from)!;
      expect(localOf(first, 'Europe/Kyiv')).toBe('2026-10-25 03:30');
      // The earlier of the two, which is EEST (UTC+3), not EET (UTC+2).
      expect(new Date(first).toISOString()).toBe('2026-10-25T00:30:00.000Z');

      // And the next one is the following day, not the second 03:30.
      const second = nextCronRun(spec, first)!;
      expect(localOf(second, 'Europe/Kyiv')).toBe('2026-10-26 03:30');
    });

    it('skips a wall-clock time an east-of-UTC zone never reaches', () => {
      // The spring-forward half of the same asymmetry. Kyiv goes 03:00 -> 04:00
      // on 29 March 2026, so 03:30 does not exist that day.
      const spec = parseCron('30 3 * * *', 'Europe/Kyiv');
      const at = nextCronRun(spec, Date.parse('2026-03-28T12:00:00Z'))!;
      expect(localOf(at, 'Europe/Kyiv')).toBe('2026-03-30 03:30');
    });

    it('runs an hourly job once per wall-clock hour, skipping the repeated one', () => {
      // The consequence of the fire-once rule, stated so it is a decision and
      // not a surprise: on a fall-back night an hourly job sees 01:00 once, so
      // there is a single two-hour gap in *real* time. Firing it twice would
      // mean a job that says "hourly" running 25 times that day.
      const spec = parseCron('0 * * * *', 'America/New_York');
      let at = Date.parse('2026-11-01T04:00:00Z');
      const seen: number[] = [];
      for (let i = 0; i < 4; i += 1) {
        at = nextCronRun(spec, at)!;
        seen.push(at);
      }

      expect(seen.map((t) => localOf(t, 'America/New_York'))).toEqual([
        '2026-11-01 01:00',
        '2026-11-01 02:00',
        '2026-11-01 03:00',
        '2026-11-01 04:00',
      ]);
      // Each local hour appears exactly once, and the gap across the repeat is
      // two real hours rather than one.
      const gaps = seen.slice(1).map((t, i) => t - seen[i]!);
      expect(gaps).toEqual([7_200_000, 3_600_000, 3_600_000]);
    });
  });

  it('returns null for an expression that can never match', () => {
    // 30 February is legal to write and impossible to reach.
    expect(
      nextCronRun(
        parseCron('0 0 30 2 *', 'UTC'),
        Date.parse('2026-01-01T00:00:00Z'),
      ),
    ).toBeNull();
  });

  it('returns null rather than searching forever past the bound', () => {
    // 29 February on a Monday in January — the month rules it out entirely.
    expect(
      nextCronRun(
        parseCron('0 0 31 4 *', 'UTC'),
        Date.parse('2026-01-01T00:00:00Z'),
      ),
    ).toBeNull();
  });

  describe('properties', () => {
    const EXPRESSIONS = [
      '* * * * *',
      '0 * * * *',
      '*/7 * * * *',
      '30 9 * * 1-5',
      '0 0 13 * 5',
      '15 3 1 * *',
      '0 12 * jan,jul *',
      '0 0 29 2 *',
    ];
    const ZONES = [
      'UTC',
      'Europe/London',
      'America/New_York',
      'Asia/Kolkata',
      'Australia/Lord_Howe',
    ];

    /** Whether an instant's local wall clock satisfies the spec. */
    function satisfies(spec: CronSpec, instantMs: number): boolean {
      const f = new Intl.DateTimeFormat('en-CA', {
        timeZone: spec.tz ?? 'UTC',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      }).formatToParts(new Date(instantMs));
      const get = (type: string): number =>
        Number.parseInt(f.find((p) => p.type === type)?.value ?? '0', 10);
      const [year, month, day, hour, minute] = [
        get('year'),
        get('month'),
        get('day'),
        get('hour'),
        get('minute'),
      ] as [number, number, number, number, number];

      if (!spec.minutes.includes(minute) || !spec.hours.includes(hour)) {
        return false;
      }
      if (!spec.months.includes(month)) return false;
      const domHit = spec.daysOfMonth.includes(day);
      const dowHit = spec.daysOfWeek.includes(
        new Date(Date.UTC(year, month - 1, day)).getUTCDay(),
      );
      return spec.domRestricted && spec.dowRestricted
        ? domHit || dowHit
        : domHit && dowHit;
    }

    it('returns an instant that satisfies the expression', () => {
      fc.assert(
        fc.property(
          fc.constantFrom(...EXPRESSIONS),
          fc.constantFrom(...ZONES),
          fc.integer({
            min: Date.parse('2024-01-01T00:00:00Z'),
            max: Date.parse('2029-01-01T00:00:00Z'),
          }),
          (expr, tz, from) => {
            const spec = parseCron(expr, tz);
            const next = nextCronRun(spec, from);
            if (next === null) return;
            expect(next).toBeGreaterThan(from);
            expect(satisfies(spec, next)).toBe(true);
          },
        ),
        { numRuns: 300 },
      );
    });

    /**
     * Minimality, without walking every minute in between.
     *
     * The obvious formulation — step a minute at a time from `from` to the
     * answer and assert none matches — is correct and quadratic: `0 0 13 * 5`
     * can be twelve days away, which is 17,000 `Intl` calls per case. It passed
     * alone and timed out under the full suite, which is the load-sensitive
     * shape `CLAUDE.md` warns about.
     *
     * Asking again from a point *inside* the gap is the same guarantee in O(1):
     * if some instant strictly between `from` and `next` satisfied the spec,
     * then asking from just before that instant would return it rather than
     * `next`. Sampling the gap catches exactly the non-minimal answer, and the
     * exhaustive walk survives below over one short fixed window.
     */
    it('gives the same answer asked again from anywhere inside the gap', () => {
      fc.assert(
        fc.property(
          fc.constantFrom(
            '30 9 * * 1-5',
            '0 0 13 * 5',
            '*/7 * * * *',
            '0 2 * * *',
          ),
          fc.constantFrom('UTC', 'Europe/London', 'America/New_York'),
          fc.integer({
            min: Date.parse('2026-01-01T00:00:00Z'),
            max: Date.parse('2026-12-01T00:00:00Z'),
          }),
          fc.double({ min: 0, max: 1, noNaN: true }),
          (expr, tz, from, fraction) => {
            const spec = parseCron(expr, tz);
            const next = nextCronRun(spec, from);
            if (next === null) return;

            const inside = from + Math.floor((next - from - 1) * fraction);
            expect(nextCronRun(spec, inside)).toBe(next);
          },
        ),
        { numRuns: 200 },
      );
    });

    it('skips every minute in a known gap, checked exhaustively', () => {
      // The exact check the property above trades away, over a window small
      // enough to pay for: a weekday-09:30 job asked from Saturday morning.
      const spec = parseCron('30 9 * * 1-5', 'UTC');
      const from = Date.parse('2026-11-07T00:00:00Z');
      const next = nextCronRun(spec, from);
      expect(next).not.toBeNull();

      for (let t = from + 60_000; t < next!; t += 60_000) {
        expect(satisfies(spec, t)).toBe(false);
      }
      expect(satisfies(spec, next!)).toBe(true);
    });
  });
});
