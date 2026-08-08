import { DatabaseSync } from 'node:sqlite';

import type { Clock } from '@ghostbot/core';
import type { RandomSource } from '@ghostbot/security';
import { afterEach, describe, expect, it } from 'vitest';

import {
  AuthStore,
  argon2Hasher,
  type PasswordHasher,
} from '#src/auth-store.js';

const open: DatabaseSync[] = [];

afterEach(() => {
  while (open.length > 0) open.pop()?.close();
});

/** Cheap and reversible, so a test can assert *what* was hashed. */
const fakeHasher: PasswordHasher = {
  hash: async (password) => `fake:${password}`,
  verify: async (digest, password) => digest === `fake:${password}`,
};

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

/** Distinct per call, so two tokens never collide, and reproducible. */
function countingRandom(): RandomSource {
  let counter = 0;
  return (size) => {
    counter += 1;
    return Buffer.alloc(size, counter);
  };
}

interface Built {
  readonly store: AuthStore;
  readonly clock: TestClock;
  readonly database: DatabaseSync;
}

function build(
  options: {
    ttlMs?: number;
    hasher?: PasswordHasher;
    random?: RandomSource;
  } = {},
): Built {
  const database = new DatabaseSync(':memory:');
  open.push(database);
  const clock = testClock();
  const store = new AuthStore({
    database,
    sessionTtlMs: options.ttlMs ?? 60_000,
    clock,
    random: options.random ?? countingRandom(),
    hasher: options.hasher ?? fakeHasher,
  });
  return { store, clock, database };
}

describe('passwords', () => {
  it('reports no password before one is set', () => {
    expect(build().store.hasPassword()).toBe(false);
  });

  it('accepts the password it was given and nothing else', async () => {
    const { store } = build();
    await store.setPassword('correct horse');

    expect(store.hasPassword()).toBe(true);
    expect(await store.verifyPassword('correct horse')).toBe(true);
    expect(await store.verifyPassword('correct horse ')).toBe(false);
    expect(await store.verifyPassword('')).toBe(false);
  });

  it('refuses a password below the minimum rather than storing a hash of it', async () => {
    const { store } = build();
    await expect(store.setPassword('')).rejects.toThrow(
      /at least 12 characters/,
    );
    await expect(store.setPassword('short')).rejects.toThrow(
      /at least 12 characters/,
    );
    expect(store.hasPassword()).toBe(false);
  });

  it('fails verification when no password is set', async () => {
    expect(await build().store.verifyPassword('anything')).toBe(false);
  });

  // The reason to change a password is that the old one may be known. A token
  // minted under it outliving the change makes the change cosmetic.
  it('revokes every session when the password is rotated', async () => {
    const { store } = build();
    await store.setPassword('first password');
    const token = store.issue().token;
    expect(store.verify(token)).toBeDefined();

    await store.setPassword('second password');
    expect(store.verify(token)).toBeUndefined();
  });

  it('replaces the stored hash rather than adding a second row', async () => {
    const { store } = build();
    await store.setPassword('first password');
    await store.setPassword('second password');

    expect(await store.verifyPassword('first password')).toBe(false);
    expect(await store.verifyPassword('second password')).toBe(true);
  });
});

describe('the username', () => {
  it('is the default until one is set', () => {
    expect(build().store.username()).toBe('ghost');
  });

  it('moves only alongside a password', async () => {
    const { store } = build();
    await store.setPassword('a good password', 'Operator');
    // Normalised on the way in, so the value stored is the value compared.
    expect(store.username()).toBe('operator');
  });

  it('is left alone when a rotation does not name one', async () => {
    const { store } = build();
    await store.setPassword('a good password', 'operator');
    await store.setPassword('another password');

    expect(store.username()).toBe('operator');
  });

  it('refuses a name the login route would have refused', async () => {
    const { store } = build();
    await expect(
      store.setPassword('a good password', 'has spaces'),
    ).rejects.toThrow(/username/i);
    // Nothing is written on a refusal — a password stored beside a rejected
    // name would be a credential half-applied.
    expect(store.hasPassword()).toBe(false);
  });

  it('refuses a password that is the username', async () => {
    const { store } = build();
    await expect(
      store.setPassword('operatorname', 'operatorname'),
    ).rejects.toThrow(/must not be the username/);
  });

  it('will not be handed out or generated by ensureSecret', () => {
    const { store } = build();
    expect(() => store.ensureSecret('username')).toThrow(
      /not a readable secret/,
    );
    expect(store.username()).toBe('ghost');
  });
});

describe('verifyLogin', () => {
  it('takes both halves and nothing less', async () => {
    const { store } = build();
    await store.setPassword('a good password', 'operator');

    expect(await store.verifyLogin('operator', 'a good password')).toBe(true);
    expect(await store.verifyLogin('operator', 'wrong')).toBe(false);
    expect(await store.verifyLogin('ghost', 'a good password')).toBe(false);
  });

  it('folds the case and the surrounding space of the name, and only the name', async () => {
    const { store } = build();
    await store.setPassword('a good password', 'operator');

    expect(await store.verifyLogin('  OPERATOR ', 'a good password')).toBe(
      true,
    );
    expect(await store.verifyLogin('operator', ' a good password')).toBe(false);
  });

  it('refuses a name too malformed to normalise, without throwing', async () => {
    const { store } = build();
    await store.setPassword('a good password', 'operator');

    // The route would have rejected these at the schema, but the store is also
    // reachable from a test, a channel and anything added later. A throw here
    // would be a 500 where a 401 belongs.
    expect(await store.verifyLogin('', 'a good password')).toBe(false);
    expect(await store.verifyLogin('has spaces', 'a good password')).toBe(
      false,
    );
  });

  /**
   * The property that stops the form being a username oracle.
   *
   * A wrong name must cost the same as a wrong password, which means the KDF has
   * to run either way. The fake hasher counts its calls; a `verifyLogin` that
   * returned early on the name would show up here as a call that never happened.
   */
  it('runs the hasher even when the username is wrong', async () => {
    let verifications = 0;
    const counting: PasswordHasher = {
      hash: async (password) => `fake:${password}`,
      verify: async (digest, password) => {
        verifications += 1;
        return digest === `fake:${password}`;
      },
    };
    const { store } = build({ hasher: counting });
    await store.setPassword('a good password', 'operator');

    verifications = 0;
    expect(await store.verifyLogin('nobody', 'a good password')).toBe(false);
    expect(verifications).toBe(1);
  });

  it('runs the hasher even when no password is set at all', async () => {
    let verifications = 0;
    const counting: PasswordHasher = {
      hash: async (password) => `fake:${password}`,
      verify: async (digest, password) => {
        verifications += 1;
        return digest === `fake:${password}`;
      },
    };
    const { store } = build({ hasher: counting });

    // An unclaimed install must not answer faster than a claimed one, or the
    // difference tells an attacker which servers are worth coming back to.
    expect(await store.verifyLogin('ghost', 'anything')).toBe(false);
    expect(verifications).toBe(1);
  });
});

describe('argon2id', () => {
  // The one place the real hasher runs: everything else injects a cheap one,
  // and a suite that never exercises argon2 would not notice it being wrong.
  it('produces an argon2id digest that verifies', async () => {
    const digest = await argon2Hasher.hash('a real password');

    expect(digest.startsWith('$argon2id$')).toBe(true);
    expect(await argon2Hasher.verify(digest, 'a real password')).toBe(true);
    expect(await argon2Hasher.verify(digest, 'a real passwore')).toBe(false);
  });

  it('salts, so the same password twice is two digests', async () => {
    const [first, second] = await Promise.all([
      argon2Hasher.hash('same'),
      argon2Hasher.hash('same'),
    ]);
    expect(first).not.toBe(second);
  });

  it('treats a corrupt stored value as a failed verification, not a throw', async () => {
    expect(
      await argon2Hasher.verify('not an argon2 encoding', 'password'),
    ).toBe(false);
  });
});

describe('tokens', () => {
  it('verifies a token it issued', () => {
    const { store, clock } = build({ ttlMs: 60_000 });
    const issued = store.issue('web');

    const session = store.verify(issued.token);
    expect(session?.id).toBe(issued.id);
    expect(session?.label).toBe('web');
    expect(session?.expiresAtMs).toBe(clock.now() + 60_000);
  });

  it('issues distinct tokens', () => {
    const { store } = build();
    expect(store.issue().token).not.toBe(store.issue().token);
  });

  it.each([
    ['empty', ''],
    ['no separator', 'abcdef'],
    ['no id', '.secret'],
    ['no secret', 'id.'],
    ['unknown id', 'nosuchid.secret'],
  ])('rejects a %s token', (name, token) => {
    expect(build().store.verify(token)).toBeUndefined();
  });

  // The digest comparison is the check that matters: an id is a row address,
  // and knowing one must not be enough to pass.
  it('rejects a real id with the wrong secret', () => {
    const { store } = build();
    const issued = store.issue();

    expect(store.verify(`${issued.id}.wrong`)).toBeUndefined();
    expect(store.verify(`${issued.id}.`)).toBeUndefined();
  });

  it('rejects a token past its expiry and drops the row', () => {
    const { store, clock, database } = build({ ttlMs: 1000 });
    const issued = store.issue();

    clock.advance(1000);
    expect(store.verify(issued.token)).toBeUndefined();
    expect(
      database.prepare('SELECT COUNT(*) AS n FROM auth_sessions').get()?.n,
    ).toBe(0);
  });

  // `timingSafeEqual` throws on a length mismatch rather than returning false,
  // so a truncated digest must not turn a bad credential into a 500.
  it('rejects a digest of the wrong length', () => {
    const { store, database } = build();
    const issued = store.issue();
    database
      .prepare('UPDATE auth_sessions SET token_sha256 = ?')
      .run(Buffer.alloc(8));

    expect(store.verify(issued.token)).toBeUndefined();
  });

  it('revokes one session without touching the others', () => {
    const { store } = build();
    const first = store.issue();
    const second = store.issue();

    expect(store.revokeById(first.id)).toBe(true);
    expect(store.revokeById(first.id)).toBe(false);
    expect(store.verify(first.token)).toBeUndefined();
    expect(store.verify(second.token)).toBeDefined();
  });

  it('revokes everything at once', () => {
    const { store } = build();
    store.issue();
    store.issue();

    expect(store.revokeAll()).toBe(2);
    expect(store.revokeAll()).toBe(0);
  });

  it('purges only what has expired', () => {
    const { store, clock } = build({ ttlMs: 1000 });
    const early = store.issue();
    clock.advance(600);
    const late = store.issue();

    clock.advance(500); // 1100ms: `early` is dead, `late` has 500ms left
    expect(store.purgeExpired()).toBe(1);
    expect(store.verify(early.token)).toBeUndefined();
    expect(store.verify(late.token)).toBeDefined();
  });
});

describe('last seen', () => {
  function lastSeen(database: DatabaseSync): number {
    return Number(
      database.prepare('SELECT last_seen_at_ms AS t FROM auth_sessions').get()
        ?.t,
    );
  }

  // A read that writes on every request would put every authenticated GET in
  // the same WAL a turn is streaming into.
  it('does not write on a verification moments after the last one', () => {
    const { store, clock, database } = build({ ttlMs: 600_000 });
    const issued = store.issue();
    const before = lastSeen(database);

    clock.advance(30_000);
    store.verify(issued.token);
    expect(lastSeen(database)).toBe(before);
  });

  it('writes once the record is stale', () => {
    const { store, clock, database } = build({ ttlMs: 600_000 });
    const issued = store.issue();

    clock.advance(61_000);
    store.verify(issued.token);
    expect(lastSeen(database)).toBe(clock.now());
  });
});

describe('the shared connection', () => {
  it('creates its tables on a connection something else already opened', () => {
    const database = new DatabaseSync(':memory:');
    open.push(database);
    database.exec('CREATE TABLE unrelated (id TEXT PRIMARY KEY) STRICT');

    const store = new AuthStore({
      database,
      sessionTtlMs: 1000,
      hasher: fakeHasher,
    });
    const token = store.issue().token;

    expect(store.verify(token)).toBeDefined();
    expect(
      database
        .prepare("SELECT name FROM sqlite_master WHERE name = 'unrelated'")
        .get(),
    ).toBeDefined();
  });

  it('is idempotent, so a second store on the same connection is fine', () => {
    const { store, database, clock } = build();
    const issued = store.issue();
    const second = new AuthStore({
      database,
      sessionTtlMs: 1000,
      clock,
      hasher: fakeHasher,
    });

    expect(second.verify(issued.token)).toBeDefined();
  });
});

describe('setup codes', () => {
  it('mints a grouped, transcribable code and reports one is outstanding', () => {
    const { store } = build();
    expect(store.hasSetupCode()).toBe(false);

    const code = store.issueSetupCode();

    // Grouped for someone reading it off a terminal and typing it into a
    // browser, which is the entire use case.
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){2}$/);
    expect(store.hasSetupCode()).toBe(true);
  });

  it('accepts the code however it was transcribed', () => {
    const { store } = build();
    const code = store.issueSetupCode();

    // The dashes and the case are presentation. Someone who pasted it without
    // the grouping has entered the right code.
    expect(store.consumeSetupCode(code.replaceAll('-', '').toLowerCase())).toBe(
      true,
    );
  });

  it('is single use', () => {
    const { store } = build();
    const code = store.issueSetupCode();

    expect(store.consumeSetupCode(code)).toBe(true);
    expect(store.consumeSetupCode(code)).toBe(false);
    expect(store.hasSetupCode()).toBe(false);
  });

  it('leaves the real code alone when a wrong one is tried', () => {
    // A typo must not lock the operator out of their own install.
    const { store } = build();
    const code = store.issueSetupCode();

    expect(store.consumeSetupCode('ZZZZ-ZZZZ-ZZZZ')).toBe(false);
    expect(store.consumeSetupCode(code)).toBe(true);
  });

  it('replaces an outstanding code rather than keeping both', () => {
    const { store } = build();
    const first = store.issueSetupCode();
    const second = store.issueSetupCode();

    expect(store.consumeSetupCode(first)).toBe(false);
    expect(store.consumeSetupCode(second)).toBe(true);
  });

  it('is invalidated by setting a password', async () => {
    // Once a password exists the code is a second way in that nobody is
    // watching — and it was printed to a terminal whose scrollback outlives it.
    const { store } = build();
    const code = store.issueSetupCode();

    await store.setPassword('chosen-in-the-wizard');

    expect(store.hasSetupCode()).toBe(false);
    expect(store.consumeSetupCode(code)).toBe(false);
  });

  it('refuses to mint one for an install that already has a password', async () => {
    const { store } = build();
    await store.setPassword('already-claimed');

    expect(() => store.issueSetupCode()).toThrow(/already set/);
  });

  it('reports no code on an install that never had one', () => {
    const { store } = build();
    expect(store.consumeSetupCode('ANYT-HING-HERE')).toBe(false);
  });

  it('is not readable back through ensureSecret', () => {
    const { store } = build();
    store.issueSetupCode();
    expect(() => store.ensureSecret('setup_code')).toThrow(
      /not a readable secret/,
    );
  });
});
