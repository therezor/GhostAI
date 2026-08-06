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
import {
  DEFAULT_USERNAME,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  UsernameSchema,
} from '@ghostai/protocol';
import { systemRandom, type RandomSource } from '@ghostai/security';
import type { Algorithm as Argon2Algorithm } from '@node-rs/argon2';

/** Bytes of entropy in the secret half of a token. */
export const TOKEN_SECRET_BYTES = 32;
/** Bytes in the lookup half. Not a secret — only a row address. */
export const TOKEN_ID_BYTES = 12;

/** Bytes in a named server secret — an HMAC key, not a password. */
export const SECRET_BYTES = 32;

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
 * The login name, stored beside the digest it goes with.
 *
 * Absent until someone changes it, and `DEFAULT_USERNAME` stands in — which is
 * what makes a fresh install signable-into with a name nobody had to choose.
 * Storing the default eagerly would work equally well right up until the
 * default changed, at which point every install that never touched it would be
 * pinned to the old one for no reason it could explain.
 *
 * Unlike the password this is stored in the clear, because it is not a secret:
 * it is half of a credential whose other half is the thing under argon2id. What
 * it buys is that guessing the password is not enough — an attacker who reads
 * the database has both anyway, and one who does not has neither.
 */
const USERNAME_SECRET = 'username';

/**
 * The one-time code that claims an install with no password.
 *
 * Stored in the same table as the password and hashed the same way a session
 * token is — SHA-256, not argon2id. It is 20 characters of `randomBytes`
 * entropy, so there is nothing to guess and a KDF would buy nothing; what
 * matters is that a copy of the database does not yield a usable code.
 */
const SETUP_CODE_SECRET = 'setup_code';

/** Bytes behind a setup code. 12 bytes → 20 base32 characters. */
const SETUP_CODE_BYTES = 12;

/**
 * Crockford base32 without `I`, `L`, `O` and `U`: the characters a person
 * mistypes when copying a code out of a terminal, and the one that forms words.
 */
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * What is hashed, on both sides.
 *
 * The dashes and the case are presentation. Someone who pastes the code
 * without its grouping, or types it in lower case, has entered the right code,
 * and a comparison that said otherwise would be rejecting a correct answer.
 */
function normaliseCode(code: string): string {
  return code.replace(/[^0-9a-zA-Z]/g, '').toUpperCase();
}

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
  /** Shared with `SessionStore` and the scheduler. */
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
  throw new GhostError(
    'storage',
    'Expected an integer column in auth_sessions',
  );
}

function readText(value: unknown): string {
  if (typeof value === 'string') return value;
  throw new GhostError('storage', 'Expected a text column in auth_sessions');
}

/**
 * String equality that does not stop at the first differing byte.
 *
 * The length is compared first and answers early, which is unavoidable —
 * `timingSafeEqual` throws on a length mismatch rather than returning false.
 * That leaks the length of the username, which is not the secret; its content
 * is, and that is what stays constant-time.
 */
function equalsConstantTime(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  if (a.byteLength !== b.byteLength) return false;
  return timingSafeEqual(a, b);
}

/**
 * The bounds a new password must clear, in the one place both callers reach.
 *
 * The HTTP body is parsed with `NewPasswordSchema`, which says the same thing —
 * but `--password` and `GHOSTAI_PASSWORD` come in through `createServer` and
 * never touch a Zod schema, and a policy that the CLI can walk around is a
 * policy that describes the UI rather than the install.
 */
function assertPasswordPolicy(password: string): void {
  if (password.length < PASSWORD_MIN_LENGTH) {
    throw new GhostError(
      'invalid_input',
      `Password must be at least ${String(PASSWORD_MIN_LENGTH)} characters. ` +
        'What is behind it is an agent that can read files and run commands on this host.',
    );
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    throw new GhostError(
      'invalid_input',
      `Password must be at most ${String(PASSWORD_MAX_LENGTH)} characters`,
    );
  }
}

export class AuthStore {
  private readonly db: DatabaseSync;
  private readonly clock: Clock;
  private readonly random: RandomSource;
  private readonly hasher: PasswordHasher;
  private readonly ttlMs: number;
  /** The in-flight or settled promise, so the decoy is hashed at most once. */
  private decoyDigest: Promise<string> | undefined;

  constructor(options: AuthStoreOptions) {
    this.db = options.database;
    this.clock = options.clock ?? systemClock;
    this.random = options.random ?? systemRandom;
    this.hasher = options.hasher ?? argon2Hasher;
    this.ttlMs = options.sessionTtlMs;
    this.db.exec(SCHEMA);
  }

  hasPassword(): boolean {
    return this.readSecret(PASSWORD_SECRET) !== undefined;
  }

  /** The login name in force, which is `DEFAULT_USERNAME` until one is set. */
  username(): string {
    return this.readSecret(USERNAME_SECRET) ?? DEFAULT_USERNAME;
  }

  /**
   * Sets or rotates the password, and optionally the login name with it.
   *
   * One method for both because they share the consequence below, and because a
   * separate `setUsername` would be a way to change half a credential without
   * proving knowledge of the other half — which is exactly the thing the route
   * above it asks for a current password to prevent.
   *
   * Every existing session is revoked, because the reason to change a password
   * is that the old one may be known — and a token minted under it outliving
   * the rotation makes the rotation cosmetic.
   */
  async setPassword(password: string, username?: string): Promise<void> {
    assertPasswordPolicy(password);
    const now = this.clock.now();

    // Validated before anything is written. The schema is the same one the
    // route body is parsed with, so a name the HTTP layer would have refused
    // cannot arrive through `--username` instead.
    let normalisedName: string | undefined;
    if (username !== undefined) {
      const parsed = UsernameSchema.safeParse(username);
      if (!parsed.success) {
        throw new GhostError(
          'invalid_input',
          `Invalid username: ${parsed.error.issues[0]?.message ?? 'does not meet the rules'}`,
        );
      }
      normalisedName = parsed.data;
      if (normalisedName === password.trim().toLowerCase()) {
        // Not a strength heuristic — those belong in a password manager, not
        // here. This is the one case where a "password" is a value the operator
        // has already typed into a field that is not masked and may be in a log.
        throw new GhostError(
          'invalid_input',
          'The password must not be the username',
        );
      }
    }

    const digest = await this.hasher.hash(password);
    const write = this.db.prepare(
      `INSERT INTO auth_secrets (name, value, updated_at_ms) VALUES (?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at_ms = excluded.updated_at_ms`,
    );
    write.run(PASSWORD_SECRET, digest, now);
    if (normalisedName !== undefined) {
      write.run(USERNAME_SECRET, normalisedName, now);
    }

    // The setup code is a stand-in for a password that does not exist yet. The
    // moment one does, an outstanding code is a second way in that nobody is
    // watching — and it was printed to a terminal whose scrollback outlives it.
    this.db
      .prepare('DELETE FROM auth_secrets WHERE name = ?')
      .run(SETUP_CODE_SECRET);
    this.revokeAll();
  }

  /**
   * Mints the one-time code that claims an unclaimed install, replacing any
   * outstanding one.
   *
   * Replacing rather than reusing: a restarted server prints a fresh code, and
   * the one in the previous run's scrollback stops working. That is the weaker
   * of the two properties — the stronger one is that the code exists at all,
   * which is what lets `ghost serve` come up on a bare machine instead of
   * refusing to start and leaving the UI that would set a password unreachable.
   *
   * Refuses once a password exists, because there is nothing left to claim and
   * an alternative credential would only widen the ways in.
   */
  issueSetupCode(): string {
    if (this.hasPassword()) {
      throw new GhostError(
        'invalid_input',
        'A password is already set; there is nothing to claim',
      );
    }

    const bytes = this.random(SETUP_CODE_BYTES);
    let code = '';
    for (const [index, byte] of bytes.entries()) {
      // Grouped for transcription, not for entropy: a person reading this off a
      // terminal and typing it into a browser is the whole use case.
      if (index > 0 && index % 4 === 0) code += '-';
      code += CODE_ALPHABET[byte % CODE_ALPHABET.length] ?? '0';
    }

    this.db
      .prepare(
        `INSERT INTO auth_secrets (name, value, updated_at_ms) VALUES (?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at_ms = excluded.updated_at_ms`,
      )
      .run(
        SETUP_CODE_SECRET,
        sha256(normaliseCode(code)).toString('base64'),
        this.clock.now(),
      );
    return code;
  }

  /** Whether an unspent code is outstanding — never the code itself. */
  hasSetupCode(): boolean {
    return this.readSecret(SETUP_CODE_SECRET) !== undefined;
  }

  /**
   * Spends the code, if it is the right one. Single use either way it is read:
   * a correct code is deleted here, and a wrong one leaves the real code alone
   * so a typo does not lock the operator out of their own install.
   */
  consumeSetupCode(code: string): boolean {
    const stored = this.readSecret(SETUP_CODE_SECRET);
    if (stored === undefined) return false;

    const expected = Buffer.from(stored, 'base64');
    const presented = sha256(normaliseCode(code));
    // `timingSafeEqual` throws on a length mismatch rather than returning
    // false, and a corrupt row must not turn a bad code into a 500.
    if (expected.byteLength !== presented.byteLength) return false;
    if (!timingSafeEqual(expected, presented)) return false;

    this.db
      .prepare('DELETE FROM auth_secrets WHERE name = ?')
      .run(SETUP_CODE_SECRET);
    return true;
  }

  /**
   * The password alone, for the one caller that already knows who it is talking
   * to: the rotation route proving that the holder of a session also knows the
   * password they are replacing. A login must use `verifyLogin` instead.
   */
  async verifyPassword(password: string): Promise<boolean> {
    const digest = this.readSecret(PASSWORD_SECRET);
    if (digest === undefined) return false;
    return await this.hasher.verify(digest, password);
  }

  /**
   * Both halves, in time that does not depend on which half was wrong.
   *
   * The obvious implementation returns early when the username does not match,
   * and that early return is a username oracle: a wrong name answers in under a
   * millisecond and a wrong password answers in fifty, so an attacker learns the
   * account name for free and has only the password left to guess. So the KDF
   * runs on every attempt — against the stored digest when there is one and
   * against a decoy when there is not — and the two answers are combined only
   * once both exist.
   *
   * `&&` on the last line rather than `&`, and it does not matter: both operands
   * were computed before it is reached. The comparison itself is
   * `timingSafeEqual`, so the *name* does not leak a matching prefix either.
   */
  async verifyLogin(username: string, password: string): Promise<boolean> {
    const digest = this.readSecret(PASSWORD_SECRET);
    const nameMatches = equalsConstantTime(
      this.username(),
      UsernameSchema.catch('').parse(username),
    );
    // Deliberately not short-circuited on `nameMatches`, and deliberately not
    // skipped when no password is set: an unclaimed install must not answer
    // faster than a claimed one.
    const passwordMatches = await this.hasher.verify(
      digest ?? (await this.decoy()),
      password,
    );
    return digest !== undefined && nameMatches && passwordMatches;
  }

  /**
   * An argon2 encoding of a value nobody knows, hashed once and kept.
   *
   * It exists so that "no password is set" costs the same as "the password is
   * wrong". Computed lazily rather than in the constructor because every server
   * builds an `AuthStore` and almost none of them ever see a login against an
   * unclaimed install — paying 50 ms at every boot to cover that case would be
   * the more expensive mistake.
   */
  private async decoy(): Promise<string> {
    this.decoyDigest ??= this.hasher.hash(
      this.random(TOKEN_SECRET_BYTES).toString('base64url'),
    );
    return await this.decoyDigest;
  }

  /**
   * Mints a token. The returned string is never recoverable afterwards.
   *
   * `label` distinguishes a browser login from a token minted for CI, which is
   * the only thing that makes a session list worth showing.
   */
  issue(label = ''): IssuedToken {
    const now = this.clock.now();
    const id = this.random(TOKEN_ID_BYTES).toString('base64url');
    const secret = this.random(TOKEN_SECRET_BYTES).toString('base64url');
    const expiresAtMs = now + this.ttlMs;

    this.db
      .prepare(
        `INSERT INTO auth_sessions (id, token_sha256, label, created_at_ms, expires_at_ms, last_seen_at_ms)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, sha256(secret), label, now, expiresAtMs, now);

    return { token: `${id}.${secret}`, id, expiresAtMs };
  }

  /**
   * A named server secret, created on first use.
   *
   * The media URL signer needs a key that survives a restart — a signature
   * minted before a reload has to still verify after it, or every image in an
   * open tab breaks on deploy — and that is the same durable, never-transmitted
   * storage the password already has. Generating it lazily rather than at boot
   * means an install that never serves a file never writes one.
   *
   * The password is refused by name: it is stored as a one-way digest, and a
   * caller that got it back here would be handing an argon2 encoding to
   * whatever asked for a signing key.
   */
  ensureSecret(name: string): string {
    if (
      name === PASSWORD_SECRET ||
      name === SETUP_CODE_SECRET ||
      name === USERNAME_SECRET
    ) {
      // The first two are stored as one-way digests, and a caller that got one
      // back here would be handing a hash to whatever asked for a signing key.
      // The username is refused for the opposite reason: it is *not* a secret,
      // and worse, this method generates what it does not find — asking for it
      // on an install that never changed it would replace the login name with
      // 32 random bytes.
      throw new GhostError('invalid_input', `${name} is not a readable secret`);
    }
    const existing = this.readSecret(name);
    if (existing !== undefined) return existing;

    const secret = this.random(SECRET_BYTES).toString('base64url');
    // `DO NOTHING` rather than `DO UPDATE`: two requests racing to serve the
    // first signed URL must end up with the same key, not the second one's.
    this.db
      .prepare(
        `INSERT INTO auth_secrets (name, value, updated_at_ms) VALUES (?, ?, ?)
         ON CONFLICT(name) DO NOTHING`,
      )
      .run(name, secret, this.clock.now());
    return this.readSecret(name) ?? secret;
  }

  /** `undefined` for anything that is not a live session — never a reason why. */
  verify(token: string): AuthSession | undefined {
    const separator = token.indexOf('.');
    if (separator <= 0 || separator === token.length - 1) return undefined;
    const id = token.slice(0, separator);
    const secret = token.slice(separator + 1);

    const row = this.db
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
    if (
      !(stored instanceof Uint8Array) ||
      stored.byteLength !== presented.byteLength
    ) {
      return undefined;
    }
    if (!timingSafeEqual(stored, presented)) return undefined;

    const now = this.clock.now();
    const expiresAtMs = readNumber(row.expires_at_ms);
    if (expiresAtMs <= now) {
      this.revokeById(id);
      return undefined;
    }

    if (now - readNumber(row.last_seen_at_ms) > TOUCH_INTERVAL_MS) {
      this.db
        .prepare('UPDATE auth_sessions SET last_seen_at_ms = ? WHERE id = ?')
        .run(now, id);
    }

    return {
      id,
      label: readText(row.label),
      createdAtMs: readNumber(row.created_at_ms),
      expiresAtMs,
    };
  }

  revokeById(id: string): boolean {
    return (
      Number(
        this.db.prepare('DELETE FROM auth_sessions WHERE id = ?').run(id)
          .changes,
      ) > 0
    );
  }

  revokeAll(): number {
    return Number(this.db.prepare('DELETE FROM auth_sessions').run().changes);
  }

  /** Called at boot so a long-down instance does not accumulate dead rows. */
  purgeExpired(): number {
    const run = this.db
      .prepare('DELETE FROM auth_sessions WHERE expires_at_ms <= ?')
      .run(this.clock.now());
    return Number(run.changes);
  }

  private readSecret(name: string): string | undefined {
    const row = this.db
      .prepare('SELECT value FROM auth_secrets WHERE name = ?')
      .get(name);
    if (row === undefined) return undefined;
    const value = row.value;
    return typeof value === 'string' ? value : undefined;
  }
}
