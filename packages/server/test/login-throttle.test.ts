import { DatabaseSync } from 'node:sqlite';

import type { Clock } from '@ghostai/core';
import { afterEach, describe, expect, it } from 'vitest';

import {
  ACCOUNT_SCOPE,
  DECAY_MS,
  FREE_ATTEMPTS,
  LoginThrottle,
  MAX_ACCOUNT_DELAY_MS,
  MAX_ADDRESS_DELAY_MS,
  delayFor,
} from '#src/login-throttle.js';

const open: DatabaseSync[] = [];

afterEach(() => {
  while (open.length > 0) open.pop()?.close();
});

interface TestClock extends Clock {
  advance(ms: number): void;
}

function testClock(start = 1_700_000_000_000): TestClock {
  let current = start;
  return {
    now: () => current,
    monotonic: () => current,
    setTimeout: (callback, delay) => globalThis.setTimeout(callback, delay),
    clearTimeout: (handle) => {
      globalThis.clearTimeout(handle);
    },
    sleep: async () => {
      /* nothing here sleeps */
    },
    advance: (ms) => {
      current += ms;
    },
  };
}

interface Built {
  readonly throttle: LoginThrottle;
  readonly clock: TestClock;
  readonly database: DatabaseSync;
}

function build(): Built {
  const database = new DatabaseSync(':memory:');
  open.push(database);
  const clock = testClock();
  return { throttle: new LoginThrottle({ database, clock }), clock, database };
}

/** Fails `count` times from one address, ignoring the blocks that result. */
function failTimes(
  throttle: LoginThrottle,
  address: string,
  count: number,
): void {
  for (let index = 0; index < count; index += 1) throttle.fail(address);
}

describe('delayFor', () => {
  it('charges nothing for the attempts a person actually mistypes', () => {
    for (let failures = 1; failures <= FREE_ATTEMPTS; failures += 1) {
      expect(delayFor(failures, MAX_ADDRESS_DELAY_MS)).toBe(0);
    }
  });

  it('doubles from one second', () => {
    expect(delayFor(FREE_ATTEMPTS + 1, MAX_ADDRESS_DELAY_MS)).toBe(1_000);
    expect(delayFor(FREE_ATTEMPTS + 2, MAX_ADDRESS_DELAY_MS)).toBe(2_000);
    expect(delayFor(FREE_ATTEMPTS + 3, MAX_ADDRESS_DELAY_MS)).toBe(4_000);
    expect(delayFor(FREE_ATTEMPTS + 4, MAX_ADDRESS_DELAY_MS)).toBe(8_000);
  });

  it('clamps at the cap rather than overflowing to Infinity', () => {
    expect(delayFor(1_000, MAX_ADDRESS_DELAY_MS)).toBe(MAX_ADDRESS_DELAY_MS);
    expect(delayFor(Number.MAX_SAFE_INTEGER, MAX_ACCOUNT_DELAY_MS)).toBe(
      MAX_ACCOUNT_DELAY_MS,
    );
  });
});

describe('the per-address scope', () => {
  it('lets a fresh caller through', () => {
    expect(build().throttle.check('10.0.0.1')).toBeUndefined();
  });

  it('reports the block on the attempt that creates it, not the next one', () => {
    const { throttle } = build();
    for (let index = 0; index < FREE_ATTEMPTS; index += 1) {
      expect(throttle.fail('10.0.0.1')).toBeUndefined();
    }
    expect(throttle.fail('10.0.0.1')?.retryAfterMs).toBe(1_000);
  });

  it('refuses until the delay has passed, then allows again', () => {
    const { throttle, clock } = build();
    failTimes(throttle, '10.0.0.1', FREE_ATTEMPTS + 1);

    expect(throttle.check('10.0.0.1')).toBeDefined();
    clock.advance(999);
    expect(throttle.check('10.0.0.1')).toBeDefined();
    clock.advance(2);
    expect(throttle.check('10.0.0.1')).toBeUndefined();
  });

  it('never holds one address longer than its cap', () => {
    const { throttle } = build();
    failTimes(throttle, '10.0.0.1', 40);

    const block = throttle.check('10.0.0.1');
    expect(block?.retryAfterMs).toBeLessThanOrEqual(MAX_ADDRESS_DELAY_MS);
  });

  it('forgets a bucket that has gone quiet for the decay window', () => {
    const { throttle, clock } = build();
    failTimes(throttle, '10.0.0.1', 12);
    expect(throttle.check('10.0.0.1')).toBeDefined();

    clock.advance(DECAY_MS + 1);
    expect(throttle.check('10.0.0.1')).toBeUndefined();

    // And the counter restarted rather than resuming where it left off: the
    // next four failures are free again.
    expect(throttle.fail('10.0.0.1')).toBeUndefined();
  });

  it('forgives both scopes on a login that worked', () => {
    const { throttle } = build();
    failTimes(throttle, '10.0.0.1', FREE_ATTEMPTS + 3);
    expect(throttle.check('10.0.0.1')).toBeDefined();

    throttle.succeed('10.0.0.1');
    expect(throttle.check('10.0.0.1')).toBeUndefined();
    expect(throttle.check('10.0.0.2')).toBeUndefined();
  });
});

describe('the account scope', () => {
  /**
   * The reason this module exists.
   *
   * Every address here is used exactly once, so no per-address bucket ever
   * reaches its free allowance and `@fastify/rate-limit` would see nothing at
   * all. The account bucket is what notices.
   */
  it('catches a distributed attack that no per-address bucket would', () => {
    const { throttle } = build();
    for (let index = 0; index < FREE_ATTEMPTS + 1; index += 1) {
      throttle.fail(`10.0.0.${String(index)}`);
    }

    // A brand new address, which has never failed and is refused anyway.
    const block = throttle.check('203.0.113.7');
    expect(block?.scope).toBe(ACCOUNT_SCOPE);
    expect(block?.retryAfterMs).toBeGreaterThan(0);
  });

  it('caps far below the per-address ceiling, so a lockout is not a denial of service', () => {
    const { throttle } = build();
    // A hundred failures from a hundred addresses: enough to drive the account
    // counter far past anything the exponent would otherwise survive.
    for (let index = 0; index < 100; index += 1) {
      throttle.fail(`10.0.0.${String(index)}`);
    }

    const block = throttle.check('203.0.113.7');
    expect(block?.retryAfterMs).toBeLessThanOrEqual(MAX_ACCOUNT_DELAY_MS);
    expect(MAX_ACCOUNT_DELAY_MS).toBeLessThan(MAX_ADDRESS_DELAY_MS);
  });

  it('reports the longer of the two blocks', () => {
    const { throttle } = build();
    // One address doing all the failing drives its own bucket past the account
    // cap, so the address block is the one that has to be reported.
    failTimes(throttle, '10.0.0.1', 20);

    const block = throttle.check('10.0.0.1');
    expect(block?.retryAfterMs).toBeGreaterThan(MAX_ACCOUNT_DELAY_MS);
  });
});

describe('persistence and pruning', () => {
  it('survives a restart on the same database', () => {
    const { throttle, database, clock } = build();
    failTimes(throttle, '10.0.0.1', FREE_ATTEMPTS + 4);
    expect(throttle.check('10.0.0.1')).toBeDefined();

    // A second instance over the same file is what a restarted process gets.
    // An in-memory counter would hand the attacker a clean slate here.
    const restarted = new LoginThrottle({ database, clock });
    expect(restarted.check('10.0.0.1')).toBeDefined();
  });

  it('drops decayed address rows without touching the account row', () => {
    const { throttle, database, clock } = build();
    failTimes(throttle, '10.0.0.1', 3);
    clock.advance(DECAY_MS + 1);
    // Any failure prunes; this one is from a different address.
    throttle.fail('10.0.0.2');

    const scopes = database
      .prepare('SELECT scope FROM auth_throttle ORDER BY scope')
      .all()
      .map((row) => row.scope);
    expect(scopes).toEqual([ACCOUNT_SCOPE, 'ip:10.0.0.2']);
  });

  it('clears everything for an operator who locked themselves out', () => {
    const { throttle } = build();
    failTimes(throttle, '10.0.0.1', 20);

    expect(throttle.reset()).toBeGreaterThan(0);
    expect(throttle.check('10.0.0.1')).toBeUndefined();
  });
});
