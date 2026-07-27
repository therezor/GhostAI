/**
 * Passwords and session tokens, on the connection everything else shares.
 *
 * Two storage decisions worth stating, because they look inconsistent until the
 * reason is visible:
 *
 *  - **The password lives here, not in the `CredentialVault`.** The vault
 *    exists for secrets that have to be *recovered* — an API key is useless
 *    unless it can be read back and put in a header. A password is never read
 *    back; only a one-way argon2id digest is stored, and encrypting a digest
 *    adds a key-management dependency to something that is already unreadable.
 *
 *  - **A session token is hashed with SHA-256, not argon2id.** A KDF's cost
 *    exists to make guessing a *low-entropy* human secret expensive. A token is
 *    32 bytes from `randomBytes`, so there is nothing to guess, and paying
 *    ~50 ms per request to prove it would turn every authenticated request into
 *    a rate limit.
 *
 * The token is `<id>.<secret>`. Splitting it is what makes the comparison
 * timing-safe in a way a single opaque string cannot be: the row is found by
 * `id`, which is not a credential, and the secret is then compared with
 * `timingSafeEqual` against a digest of the same length. Looking a token up by
 * its own value would put the secret in a SQL `=`, which short-circuits on the
 * first differing byte.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import { GhostError, systemClock, type Clock } from '@ghostai/core';
import { systemRandom, type RandomSource } from '@ghostai/security';
import type { Algorithm as Argon2Algorithm } from '@node-rs/argon2';

/** Bytes of entropy in the secret half of a token. */
export const TOKEN_SECRET_BYTES = 32;
/** Bytes in the lookup half. Not a secret — only a row address. */
export const TOKEN_ID_BYTES = 12;

/**
 * How stale `last_seen_at_ms` may get before a read writes.
 *
 * Touching the row on every request would turn an authenticated `GET` into a
 * write and put every request in the same WAL the turn is streaming into.
 */
const TOUCH_INTERVAL_MS = 60_000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS auth_secrets (
  name          TEXT PRIMARY KEY,
  value         TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS auth_sessions (
  id              TEXT    PRIMARY KEY,
  token_sha256    BLOB    NOT NULL,
  label           TEXT    NOT NULL DEFAULT '',
  created_at_ms   INTEGER NOT NULL,
  expires_at_ms   INTEGER NOT NULL,
  last_seen_at_ms INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS auth_sessions_expiry ON auth_sessions(expires_at_ms);
`;

const PASSWORD_SECRET = 'password';

/**
 * The hashing half, injected.
 *
 * argon2id is deliberately expensive — around 50 ms per call — which is correct
 * in production and ruinous in a test suite that logs in a few hundred times.
 * Tests substitute a cheap implementation; the real one is exercised by the
 * tests that are about hashing.
 */
export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(hash: string, password: string): Promise<boolean>;
}

/**
 * `Algorithm.Argon2id`, spelled as its value.
 *
 * The enum is an ambient `const enum`, which `verbatimModuleSyntax` refuses to
 * read: there is no runtime object to import, only a compile-time substitution
 * this build does not perform. The type is still imported, so a renumbering
 * upstream is a type error here rather than a silently different algorithm.
 */
const ARGON2ID: Argon2Algorithm = 2;

/**
 * OWASP's argon2id baseline, which is `@node-rs/argon2`'s own default:
 * m=19 MiB, t=2, p=1.
 */
export const argon2Hasher: PasswordHasher = {
  async hash(password: string): Promise<string> {
    const { hash } = await import('@node-rs/argon2');
    return await hash(password, { algorithm: ARGON2ID });
  },
  async verify(digest: string, password: string): Promise<boolean> {
    const { verify } = await import('@node-rs/argon2');
    try {
      return await verify(digest, password);
    } catch {
      // A stored value that is not a valid argon2 encoding is a corrupt row,
      // not a correct password. Failing closed is the only safe reading.
      return false;
    }
  },
};

export interface AuthStoreOptions {
  /** Shared with `SessionStore`, the scheduler and the knowledge base. */
  readonly database: DatabaseSync;
  /** How long a newly issued token lives. */
  readonly sessionTtlMs: number;
  readonly clock?: Clock;
  readonly random?: RandomSource;
  readonly hasher?: PasswordHasher;
}

/** A verified session. Never carries the token it was verified from. */
export interface AuthSession {
  readonly id: string;
  readonly label: string;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
}

export interface IssuedToken {
  /** The only time this value exists. Only its digest is stored. */
  readonly token: string;
  readonly id: string;
  readonly expiresAtMs: number;
}

function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

function readNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  throw new GhostError('storage', 'Expected an integer column in auth_sessions');
}

function readText(value: unknown): string {
  if (typeof value === 'string') return value;
  throw new GhostError('storage', 'Expected a text column in auth_sessions');
}

export class AuthStore {
  readonly #db: DatabaseSync;
  readonly #clock: Clock;
  readonly #random: RandomSource;
  readonly #hasher: PasswordHasher;
  readonly #ttlMs: number;

  constructor(options: AuthStoreOptions) {
    this.#db = options.database;
    this.#clock = options.clock ?? systemClock;
    this.#random = options.random ?? systemRandom;
    this.#hasher = options.hasher ?? argon2Hasher;
    this.#ttlMs = options.sessionTtlMs;
    this.#db.exec(SCHEMA);
  }

  hasPassword(): boolean {
    return this.#readSecret(PASSWORD_SECRET) !== undefined;
  }

  /**
   * Sets or rotates the password.
   *
   * Every existing session is revoked, because the reason to change a password
   * is that the old one may be known — and a token minted under it outliving
   * the rotation makes the rotation cosmetic.
   */
  async setPassword(password: string): Promise<void> {
    if (password === '') {
      throw new GhostError('invalid_input', 'Password must not be empty');
    }
    const digest = await this.#hasher.hash(password);
    this.#db
      .prepare(
        `INSERT INTO auth_secrets (name, value, updated_at_ms) VALUES (?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at_ms = excluded.updated_at_ms`,
      )
      .run(PASSWORD_SECRET, digest, this.#clock.now());
    this.revokeAll();
  }

  async verifyPassword(password: string): Promise<boolean> {
    const digest = this.#readSecret(PASSWORD_SECRET);
    if (digest === undefined) return false;
    return await this.#hasher.verify(digest, password);
  }

  /**
   * Mints a token. The returned string is never recoverable afterwards.
   *
   * `label` distinguishes a browser login from a token minted for CI, which is
   * the only thing that makes a session list worth showing.
   */
  issue(label = ''): IssuedToken {
    const now = this.#clock.now();
    const id = this.#random(TOKEN_ID_BYTES).toString('base64url');
    const secret = this.#random(TOKEN_SECRET_BYTES).toString('base64url');
    const expiresAtMs = now + this.#ttlMs;

    this.#db
      .prepare(
        `INSERT INTO auth_sessions (id, token_sha256, label, created_at_ms, expires_at_ms, last_seen_at_ms)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, sha256(secret), label, now, expiresAtMs, now);

    return { token: `${id}.${secret}`, id, expiresAtMs };
  }

  /** `undefined` for anything that is not a live session — never a reason why. */
  verify(token: string): AuthSession | undefined {
    const separator = token.indexOf('.');
    if (separator <= 0 || separator === token.length - 1) return undefined;
    const id = token.slice(0, separator);
    const secret = token.slice(separator + 1);

    const row = this.#db
      .prepare(
        `SELECT id, token_sha256, label, created_at_ms, expires_at_ms, last_seen_at_ms
         FROM auth_sessions WHERE id = ?`,
      )
      .get(id);
    if (row === undefined) return undefined;

    const stored = row.token_sha256;
    const presented = sha256(secret);
    // The column is `BLOB NOT NULL` in a `STRICT` table, so both checks are
    // belt and braces — but `timingSafeEqual` *throws* on a length mismatch
    // rather than returning false, and a row that somehow got there must not
    // turn a bad credential into a 500.
    if (!(stored instanceof Uint8Array) || stored.byteLength !== presented.byteLength) {
      return undefined;
    }
    if (!timingSafeEqual(stored, presented)) return undefined;

    const now = this.#clock.now();
    const expiresAtMs = readNumber(row.expires_at_ms);
    if (expiresAtMs <= now) {
      this.revokeById(id);
      return undefined;
    }

    if (now - readNumber(row.last_seen_at_ms) > TOUCH_INTERVAL_MS) {
      this.#db.prepare('UPDATE auth_sessions SET last_seen_at_ms = ? WHERE id = ?').run(now, id);
    }

    return {
      id,
      label: readText(row.label),
      createdAtMs: readNumber(row.created_at_ms),
      expiresAtMs,
    };
  }

  revokeById(id: string): boolean {
    return Number(this.#db.prepare('DELETE FROM auth_sessions WHERE id = ?').run(id).changes) > 0;
  }

  revokeAll(): number {
    return Number(this.#db.prepare('DELETE FROM auth_sessions').run().changes);
  }

  /** Called at boot so a long-down instance does not accumulate dead rows. */
  purgeExpired(): number {
    const run = this.#db
      .prepare('DELETE FROM auth_sessions WHERE expires_at_ms <= ?')
      .run(this.#clock.now());
    return Number(run.changes);
  }

  #readSecret(name: string): string | undefined {
    const row = this.#db.prepare('SELECT value FROM auth_secrets WHERE name = ?').get(name);
    if (row === undefined) return undefined;
    const value = row.value;
    return typeof value === 'string' ? value : undefined;
  }
}
