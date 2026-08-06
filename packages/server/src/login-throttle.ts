/**
 * What stands between one password and everyone who can reach the port.
 *
 * `@fastify/rate-limit` is already on the login at ten attempts a minute, and
 * that limit is keyed by `request.ip`. Against one host hammering the form it
 * is the right tool and this module would be redundant. Against the attack that
 * is actually run against an internet-facing box it does nothing at all: a
 * botnet with a thousand addresses gets ten thousand guesses a minute and never
 * trips a single bucket, because no individual address ever makes an eleventh
 * request.
 *
 * So there are two scopes here, and they are asymmetric on purpose:
 *
 *  - **Per address**, capped at fifteen minutes. One host that guesses wrong
 *    repeatedly is not making a mistake, and locking it out for a long time
 *    costs nothing that matters.
 *  - **Per account**, capped at thirty seconds. This is the scope the botnet
 *    cannot spread out of — every guess against the single account lands in the
 *    same bucket regardless of where it came from, which caps the *aggregate*
 *    guess rate at roughly two a minute no matter how many addresses are in
 *    play. A twelve-character password is out of reach at that rate for longer
 *    than the universe has been around.
 *
 * The thirty seconds is the whole design, and it is a ceiling rather than an
 * escalation because of what this server is: a single-account install. An
 * account lockout that grows without bound is a denial of service an attacker
 * can trigger *deliberately* — fail four logins an hour and the operator can
 * never sign in again, and there is no second admin to appeal to. A short cap
 * makes the operator's worst case "wait half a minute" while leaving the
 * attacker's throughput just as dead, because the attacker needs millions of
 * guesses and the operator needs one.
 *
 * State is on the shared connection rather than in memory, for the same reason
 * the sessions table is: a counter that resets when the process does is a
 * counter an attacker clears by arranging a restart, and a self-hosted agent
 * that runs out of memory under load restarts on its own.
 *
 * A note on what is *not* here: this never answers "was the username right".
 * Both scopes are recorded on any failed attempt, so the throttle cannot be
 * used to distinguish a wrong name from a wrong password.
 */

import type { DatabaseSync } from 'node:sqlite';

import { GhostError, systemClock, type Clock } from '@ghostai/core';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS auth_throttle (
  scope           TEXT    PRIMARY KEY,
  failures        INTEGER NOT NULL,
  last_failed_ms  INTEGER NOT NULL,
  locked_until_ms INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS auth_throttle_last_failed ON auth_throttle(last_failed_ms);
`;

/** The bucket every attempt lands in, wherever it came from. */
export const ACCOUNT_SCOPE = 'account';

/**
 * Failures that cost nothing.
 *
 * People mistype passwords, and a form that starts punishing on the second
 * attempt is a form that punishes its owner far more often than an attacker —
 * who is not inconvenienced by the first four guesses either way.
 */
export const FREE_ATTEMPTS = 4;

/** The first delay imposed, doubling from there. */
const BASE_DELAY_MS = 1_000;

/**
 * The per-address ceiling. Long, because a single address that has guessed
 * wrong a dozen times is not a person who forgot their password.
 */
export const MAX_ADDRESS_DELAY_MS: number = 15 * 60_000;

/**
 * The account-wide ceiling, and the reason it is nowhere near the one above.
 * See the header: an unbounded lockout on a single-account server is a denial
 * of service an attacker can trigger on purpose.
 */
export const MAX_ACCOUNT_DELAY_MS = 30_000;

/**
 * How long a bucket survives without a new failure.
 *
 * Without decay a counter only ever climbs, and an install that has been up for
 * a year is one that locks its owner out on their first typo. An hour of
 * silence is not an attack in progress.
 */
export const DECAY_MS: number = 60 * 60_000;

/**
 * How many address buckets are kept.
 *
 * A distributed attack writes one row per address, and the table is on the same
 * file the transcript is. Past the cap the least recently active addresses are
 * dropped — which forgives them, and is safe precisely because the account
 * bucket is the one holding the aggregate rate down and is never evicted.
 */
const MAX_TRACKED_ADDRESSES = 4096;

interface LoginThrottleOptions {
  /** Shared with `AuthStore`, `SessionStore` and everything else. */
  readonly database: DatabaseSync;
  readonly clock?: Clock;
}

/** How long the caller must wait, and which scope is asking them to. */
export interface ThrottleBlock {
  readonly scope: string;
  readonly retryAfterMs: number;
}

function readNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  throw new GhostError(
    'storage',
    'Expected an integer column in auth_throttle',
  );
}

/**
 * `1s`, `2s`, `4s` … capped, and clamped to at least one second.
 *
 * Exported because the delay is the security property: a test that asserts the
 * sequence is asserting on the thing the module exists for, and one that
 * recomputed the formula alongside it would agree with a bug.
 */
export function delayFor(failures: number, maxDelayMs: number): number {
  if (failures <= FREE_ATTEMPTS) return 0;
  const steps = failures - FREE_ATTEMPTS - 1;
  // `2 ** steps` overflows to `Infinity` long before it matters, and `Infinity`
  // clamps to the cap correctly — but only if the multiplication happens first.
  return Math.min(maxDelayMs, BASE_DELAY_MS * 2 ** steps);
}

export class LoginThrottle {
  private readonly db: DatabaseSync;
  private readonly clock: Clock;

  constructor(options: LoginThrottleOptions) {
    this.db = options.database;
    this.clock = options.clock ?? systemClock;
    this.db.exec(SCHEMA);
  }

  /**
   * The block in force for this attempt, or `undefined` to let it through.
   *
   * Called *before* the password is checked, so a locked-out caller never
   * reaches argon2id — which is the second thing this buys. A KDF tuned to cost
   * 50 ms and 19 MiB is a denial-of-service amplifier when an anonymous caller
   * can invoke it at will.
   */
  check(address: string): ThrottleBlock | undefined {
    const now = this.clock.now();
    // Both scopes, and the longer of them — not the first one that happens to
    // be locked. `Retry-After` is a promise: a caller told to come back in
    // thirty seconds because the account bucket said so, while their own
    // address is locked for fifteen minutes, is a caller who returns on time
    // and is refused again. Answering with the real wait is the difference
    // between a throttle and a lie.
    return longest([
      this.blockFor(ACCOUNT_SCOPE, now),
      this.blockFor(addressScope(address), now),
    ]);
  }

  /**
   * Records a failure against both scopes and returns the block it creates.
   *
   * Returning it rather than making the caller re-`check` is what lets a login
   * answer 429 on the attempt that crossed the line instead of on the next one:
   * an attacker who gets a 401 back learns the guess was wrong and is free to
   * send another, and the delay only becomes real when the response says so.
   */
  fail(address: string): ThrottleBlock | undefined {
    const now = this.clock.now();
    const account = this.record(ACCOUNT_SCOPE, now, MAX_ACCOUNT_DELAY_MS);
    const perAddress = this.record(
      addressScope(address),
      now,
      MAX_ADDRESS_DELAY_MS,
    );
    this.prune(now);

    return longest([account, perAddress]);
  }

  /**
   * Clears both scopes after a login that worked.
   *
   * The address is forgiven along with the account, and that is deliberate:
   * whoever just proved they know the password is entitled to mistype it on
   * their next four attempts too.
   */
  succeed(address: string): void {
    this.db
      .prepare('DELETE FROM auth_throttle WHERE scope IN (?, ?)')
      .run(ACCOUNT_SCOPE, addressScope(address));
  }

  /** For the operator who locked themselves out and has a shell on the host. */
  reset(): number {
    return Number(this.db.prepare('DELETE FROM auth_throttle').run().changes);
  }

  private blockFor(scope: string, now: number): ThrottleBlock | undefined {
    const row = this.db
      .prepare(
        'SELECT last_failed_ms, locked_until_ms FROM auth_throttle WHERE scope = ?',
      )
      .get(scope);
    if (row === undefined) return undefined;
    // A decayed bucket is not consulted even though the row is still there —
    // pruning is opportunistic, and a lock that outlived its window must not be
    // enforced just because nothing has swept it yet.
    if (now - readNumber(row.last_failed_ms) > DECAY_MS) return undefined;
    const lockedUntil = readNumber(row.locked_until_ms);
    return lockedUntil > now
      ? { scope, retryAfterMs: lockedUntil - now }
      : undefined;
  }

  private record(
    scope: string,
    now: number,
    maxDelayMs: number,
  ): ThrottleBlock | undefined {
    const row = this.db
      .prepare(
        'SELECT failures, last_failed_ms FROM auth_throttle WHERE scope = ?',
      )
      .get(scope);
    const previous =
      row === undefined || now - readNumber(row.last_failed_ms) > DECAY_MS
        ? 0
        : readNumber(row.failures);

    const failures = previous + 1;
    const delay = delayFor(failures, maxDelayMs);
    const lockedUntil = now + delay;

    this.db
      .prepare(
        `INSERT INTO auth_throttle (scope, failures, last_failed_ms, locked_until_ms)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(scope) DO UPDATE SET
           failures = excluded.failures,
           last_failed_ms = excluded.last_failed_ms,
           locked_until_ms = excluded.locked_until_ms`,
      )
      .run(scope, failures, now, lockedUntil);

    return delay === 0 ? undefined : { scope, retryAfterMs: delay };
  }

  /**
   * Drops decayed buckets, then the oldest addresses past the cap.
   *
   * Only on failure, which is the only path that grows the table, and which is
   * itself throttled by everything above.
   */
  private prune(now: number): void {
    this.db
      .prepare(
        'DELETE FROM auth_throttle WHERE scope <> ? AND last_failed_ms < ?',
      )
      .run(ACCOUNT_SCOPE, now - DECAY_MS);

    this.db
      .prepare(
        `DELETE FROM auth_throttle WHERE scope IN (
           SELECT scope FROM auth_throttle WHERE scope <> ?
           ORDER BY last_failed_ms DESC LIMIT -1 OFFSET ?
         )`,
      )
      .run(ACCOUNT_SCOPE, MAX_TRACKED_ADDRESSES);
  }
}

/**
 * Prefixed, so an address can never collide with `ACCOUNT_SCOPE`.
 *
 * `request.ip` is the socket peer — the server does not enable `trustProxy`, so
 * this is not attacker-supplied — but the prefix costs nothing and makes that a
 * property of this module rather than of a setting somewhere else.
 */
function addressScope(address: string): string {
  return `ip:${address}`;
}

/**
 * The block a caller is actually subject to.
 *
 * Both scopes refuse independently, so the wait is the longer of them — being
 * released by one while the other still holds is not being released.
 */
function longest(
  blocks: ReadonlyArray<ThrottleBlock | undefined>,
): ThrottleBlock | undefined {
  let worst: ThrottleBlock | undefined;
  for (const block of blocks) {
    if (
      block !== undefined &&
      (worst === undefined || block.retryAfterMs > worst.retryAfterMs)
    ) {
      worst = block;
    }
  }
  return worst;
}
