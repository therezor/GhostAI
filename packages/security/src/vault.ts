/**
 * The credential vault.
 *
 * Provider API keys, OAuth refresh tokens and channel bot tokens are the most
 * valuable things GhostAI holds, and the config file is the wrong place for them:
 * it gets pasted into issues, copied between machines, and read back and
 * rewritten by the settings UI. They live here instead — AES-256-GCM, one file,
 * `0600`.
 *
 * GCM rather than CBC because the vault has to detect *tampering*, not just keep
 * secrets: an attacker who can write the file but not read it could otherwise
 * flip bits in a stored base URL and redirect every request that uses the key
 * next to it. A failed authentication tag is a hard error, never a fallback to
 * "treat the file as empty", which would silently discard every credential the
 * moment something went wrong.
 *
 * The key comes from the OS keychain when one is reachable and from a `0600`
 * keyfile when it is not. The fallback is not a lesser mode grudgingly
 * tolerated — it is what makes the vault work in a container, over SSH, and on a
 * headless host, which is where a self-hosted agent usually runs. Both paths are
 * tried in order and the first that answers wins, so a machine that gains a
 * keychain later keeps working without migration.
 */

import { spawnSync } from 'node:child_process';
import { createCipheriv, createDecipheriv, timingSafeEqual } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

import { GhostError } from '@ghostai/core';

import { type RandomSource, systemRandom } from './random.js';

/** AES-256. */
export const VAULT_KEY_BYTES = 32;
/** 96 bits, the size GCM is specified for. Longer IVs are hashed and gain nothing. */
const IV_BYTES = 12;
const VAULT_VERSION = 1;
const VAULT_ALGORITHM = 'aes-256-gcm';

/**
 * Bound into the authentication tag, so a file from an older format or another
 * application cannot be replayed into this one even with the right key.
 */
const VAULT_AAD = Buffer.from(
  `ghostai-vault-v${String(VAULT_VERSION)}`,
  'utf8',
);

const KEYCHAIN_SERVICE = 'ghostai-vault';
const KEYCHAIN_ACCOUNT = 'master-key';

// ---------------------------------------------------------------------------
// Key stores
// ---------------------------------------------------------------------------

export interface KeyStore {
  /** Identifies the store in logs and in `resolveVaultKey`'s result. */
  readonly name: string;
  /** `null` when this store has no key — including when it is unavailable. */
  load(): Buffer | null;
  /** `false` when the store could not accept the key, so the next one is tried. */
  save(key: Buffer): boolean;
}

export interface CommandResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Injected so keychain handling is testable.
 *
 * A test must never reach the developer's real keychain: it would prompt, and on
 * CI it would either fail or — worse — succeed and leave a key behind.
 */
export type CommandRunner = (
  file: string,
  args: readonly string[],
  input?: string,
) => CommandResult;

/**
 * `spawnSync`'s types promise strings for the captured streams, but a process
 * that could not be spawned at all returns `null` for both. Taking `unknown`
 * keeps the guard from being read as dead code and removed.
 */
function asText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export const systemCommandRunner: CommandRunner = (file, args, input) => {
  const result = spawnSync(file, [...args], {
    encoding: 'utf8',
    windowsHide: true,
    ...(input === undefined ? {} : { input }),
  });
  return {
    // A missing binary yields `status: null`, which reads as "unavailable".
    status: result.error === undefined ? result.status : null,
    stdout: asText(result.stdout),
    stderr: asText(result.stderr),
  };
};

export interface KeyFileStoreOptions {
  readonly file: string;
  /** Defaults to `process.platform`. Only win32 changes behaviour. */
  readonly platform?: NodeJS.Platform;
}

/**
 * The fallback: the key as base64 in a `0600` file.
 *
 * A key file that anyone else on the host can read is not a key file, so one
 * with group or other permissions is refused rather than used. POSIX only —
 * Windows reports a mode that has nothing to do with its ACLs, and the file
 * inherits the user profile's protection there.
 */
export function keyFileStore(options: KeyFileStoreOptions): KeyStore {
  const platform = options.platform ?? process.platform;
  const file = options.file;

  return {
    name: 'keyfile',
    load(): Buffer | null {
      let raw: string;
      try {
        raw = readFileSync(file, 'utf8');
      } catch {
        return null;
      }
      if (platform !== 'win32') {
        const mode = statSync(file).mode & 0o777;
        if ((mode & 0o077) !== 0) {
          throw new GhostError(
            'config',
            `Vault key file is readable by other users (mode ${mode.toString(8)}): ${file}. ` +
              'Run chmod 600 on it, or delete it to generate a new key — every stored credential is lost with the old one.',
            { details: { file, mode } },
          );
        }
      }
      const key = Buffer.from(raw.trim(), 'base64');
      if (key.byteLength !== VAULT_KEY_BYTES) {
        throw new GhostError(
          'config',
          `Vault key file is not a ${String(VAULT_KEY_BYTES)}-byte key: ${file}`,
          { details: { file } },
        );
      }
      return key;
    },
    save(key): boolean {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      writeFileSync(file, key.toString('base64'), {
        encoding: 'utf8',
        mode: 0o600,
      });
      if (platform !== 'win32') chmodSync(file, 0o600);
      return true;
    },
  };
}

export interface KeychainStoreOptions {
  /** Defaults to `process.platform`. */
  readonly platform?: NodeJS.Platform;
  readonly run?: CommandRunner;
  readonly service?: string;
  readonly account?: string;
}

/**
 * The OS keychain, via the tool each platform ships.
 *
 * Secrets are handed over on stdin, never in argv — argv is world-readable
 * through `ps` for as long as the process lives, and "the key was visible for
 * 40 ms" is still a key that leaked. Windows has no built-in equivalent that can
 * be driven this way, so it reports unavailable and the keyfile takes over.
 */
export function keychainStore(options: KeychainStoreOptions = {}): KeyStore {
  const platform = options.platform ?? process.platform;
  const run = options.run ?? systemCommandRunner;
  const service = options.service ?? KEYCHAIN_SERVICE;
  const account = options.account ?? KEYCHAIN_ACCOUNT;

  const decode = (stdout: string): Buffer | null => {
    const key = Buffer.from(stdout.trim(), 'base64');
    // A truncated or re-encoded entry is treated as absent rather than as a
    // failure: regenerating a key is recoverable, refusing to start is not.
    return key.byteLength === VAULT_KEY_BYTES ? key : null;
  };

  if (platform === 'darwin') {
    const load = (): Buffer | null => {
      const result = run('security', [
        'find-generic-password',
        '-s',
        service,
        '-a',
        account,
        '-w',
      ]);
      return result.status === 0 ? decode(result.stdout) : null;
    };

    return {
      name: 'keychain:darwin',
      load,
      save(key): boolean {
        const encoded = key.toString('base64');
        // **Twice**, and this is the whole subtlety of this store.
        //
        // `security ... -w` with no value in argv prompts for the password and
        // then prompts again to confirm it. Sending the key once satisfies the
        // first prompt and gives EOF to the second, so the two "do not match" —
        // at which point `security` stores an *empty* password and still exits
        // 0. Every vault written on a Mac was then encrypted with a key that
        // could never be loaded back, and the failure surfaced later and
        // somewhere else, as a vault that would not decrypt.
        //
        // The value stays out of argv either way, which is the point of using
        // the prompt at all: argv is readable through `ps` for as long as the
        // process lives, and "the key was visible for 40 ms" is still a leak.
        const result = run(
          'security',
          ['add-generic-password', '-U', '-s', service, '-a', account, '-w'],
          `${encoded}\n${encoded}\n`,
        );
        if (result.status !== 0) return false;
        // An exit code is not evidence here — it was 0 for the failure above.
        // Reading it back is, and a store that reports success it cannot
        // demonstrate is worse than one that declines and lets the keyfile take
        // over.
        return load()?.equals(key) === true;
      },
    };
  }

  if (platform === 'linux') {
    return {
      name: 'keychain:linux',
      load(): Buffer | null {
        const result = run('secret-tool', [
          'lookup',
          'service',
          service,
          'account',
          account,
        ]);
        return result.status === 0 ? decode(result.stdout) : null;
      },
      save(key): boolean {
        const result = run(
          'secret-tool',
          [
            'store',
            '--label=GhostAI vault key',
            'service',
            service,
            'account',
            account,
          ],
          key.toString('base64'),
        );
        return result.status === 0;
      },
    };
  }

  return {
    name: `keychain:unavailable(${platform})`,
    load: () => null,
    save: () => false,
  };
}

export interface ResolveVaultKeyOptions {
  /** Tried in order for both load and save. */
  readonly stores: readonly KeyStore[];
  readonly random?: RandomSource;
}

export interface ResolvedVaultKey {
  readonly key: Buffer;
  /** The `name` of the store the key came from, or was written to. */
  readonly source: string;
  readonly created: boolean;
}

/**
 * Loads the master key, generating and persisting one on first run.
 *
 * If no store accepts the new key it fails rather than proceeding in memory: a
 * vault encrypted under a key that was never written is a vault whose contents
 * are lost at the next restart, and discovering that later is worse than not
 * starting now.
 */
export function resolveVaultKey(
  options: ResolveVaultKeyOptions,
): ResolvedVaultKey {
  for (const store of options.stores) {
    const key = store.load();
    if (key !== null) return { key, source: store.name, created: false };
  }

  const key = (options.random ?? systemRandom)(VAULT_KEY_BYTES);
  for (const store of options.stores) {
    if (store.save(key)) return { key, source: store.name, created: true };
  }
  throw new GhostError('config', 'No key store accepted the new vault key', {
    details: { stores: options.stores.map((store) => store.name) },
  });
}

// ---------------------------------------------------------------------------
// The vault
// ---------------------------------------------------------------------------

interface VaultEnvelope {
  readonly v: number;
  readonly alg: string;
  readonly iv: string;
  readonly tag: string;
  readonly data: string;
}

/**
 * Namespace → key → value.
 *
 * A `Map` rather than nested plain objects because the namespaces are attacker-
 * adjacent strings — a provider id, an MCP server name — and `contents.__proto__`
 * on a plain object is a prototype-pollution write rather than a stored
 * credential. A `Map` has no such key.
 */
type VaultContents = Map<string, Map<string, string>>;

export interface CredentialVaultOptions {
  readonly file: string;
  /** 32 bytes, from `resolveVaultKey`. */
  readonly key: Buffer;
  readonly random?: RandomSource;
}

function isEnvelope(value: unknown): value is VaultEnvelope {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<Record<keyof VaultEnvelope, unknown>>;
  return (
    typeof candidate.v === 'number' &&
    typeof candidate.alg === 'string' &&
    typeof candidate.iv === 'string' &&
    typeof candidate.tag === 'string' &&
    typeof candidate.data === 'string'
  );
}

function corrupt(file: string, reason: string, cause?: unknown): GhostError {
  return new GhostError(
    'config',
    `Vault at ${file} could not be read (${reason}). This means the wrong key or a modified file; ` +
      'it is never an empty vault. Restore the file, or delete it to start over and lose every stored credential.',
    { ...(cause === undefined ? {} : { cause }), details: { file } },
  );
}

export class CredentialVault {
  private readonly file: string;
  private readonly key: Buffer;
  private readonly random: RandomSource;
  private contents: VaultContents;

  constructor(options: CredentialVaultOptions) {
    if (options.key.byteLength !== VAULT_KEY_BYTES) {
      throw new GhostError(
        'invalid_input',
        `Vault key must be ${String(VAULT_KEY_BYTES)} bytes, got ${String(options.key.byteLength)}`,
      );
    }
    this.file = options.file;
    this.key = options.key;
    this.random = options.random ?? systemRandom;
    this.contents = this.read();
  }

  /** `undefined` when either the namespace or the key is absent. */
  get(namespace: string, key: string): string | undefined {
    return this.contents.get(namespace)?.get(key);
  }

  has(namespace: string, key: string): boolean {
    return this.get(namespace, key) !== undefined;
  }

  /** Writes through to disk. A credential that only reached memory is not stored. */
  set(namespace: string, key: string, value: string): void {
    if (namespace === '' || key === '') {
      throw new GhostError(
        'invalid_input',
        'Vault namespace and key must be non-empty',
      );
    }
    const bucket = this.contents.get(namespace) ?? new Map<string, string>();
    bucket.set(key, value);
    this.contents.set(namespace, bucket);
    this.write();
  }

  delete(namespace: string, key: string): boolean {
    const bucket = this.contents.get(namespace);
    if (bucket?.delete(key) !== true) return false;
    // An empty namespace is removed rather than left behind, so `namespaces()`
    // does not report a provider as configured after its key was deleted.
    if (bucket.size === 0) this.contents.delete(namespace);
    this.write();
    return true;
  }

  keys(namespace: string): readonly string[] {
    return [...(this.contents.get(namespace)?.keys() ?? [])];
  }

  namespaces(): readonly string[] {
    return [...this.contents.keys()];
  }

  /** Removes one namespace, or everything. Returns how many values were dropped. */
  clear(namespace?: string): number {
    let removed = 0;
    if (namespace === undefined) {
      for (const bucket of this.contents.values()) removed += bucket.size;
      this.contents = new Map();
    } else {
      const bucket = this.contents.get(namespace);
      if (bucket === undefined) return 0;
      removed = bucket.size;
      this.contents.delete(namespace);
    }
    this.write();
    return removed;
  }

  /**
   * Namespaces and key *names* only.
   *
   * The settings UI needs to show that a provider has a key configured without
   * the key crossing the network, and this is the shape that answers it. There
   * is deliberately no method that returns every value at once.
   */
  describe(): Readonly<Record<string, readonly string[]>> {
    return Object.fromEntries(
      [...this.contents].map(([namespace, bucket]) => [
        namespace,
        [...bucket.keys()],
      ]),
    );
  }

  /**
   * Whether a supplied secret matches the stored one, in constant time.
   *
   * `===` on a token leaks its prefix through timing. Callers comparing a bearer
   * token or a webhook signature use this instead.
   */
  verify(namespace: string, key: string, candidate: string): boolean {
    const stored = this.get(namespace, key);
    if (stored === undefined) return false;
    const a = Buffer.from(stored, 'utf8');
    const b = Buffer.from(candidate, 'utf8');
    // `timingSafeEqual` throws on a length mismatch, which would itself be a
    // side channel — but the length of a token is not the secret, its content
    // is, so answering early here is acceptable and unavoidable.
    if (a.byteLength !== b.byteLength) return false;
    return timingSafeEqual(a, b);
  }

  private read(): VaultContents {
    let raw: string;
    try {
      raw = readFileSync(this.file, 'utf8');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // Only "no vault yet" starts empty. A permission error must not be
      // mistaken for a first run, because the next `set` would overwrite a file
      // full of credentials with one holding a single entry.
      if (code === 'ENOENT') return new Map();
      throw corrupt(
        this.file,
        `cannot be opened: ${code ?? 'unknown error'}`,
        error,
      );
    }

    let envelope: unknown;
    try {
      envelope = JSON.parse(raw);
    } catch (error) {
      throw corrupt(this.file, 'not valid JSON', error);
    }
    if (!isEnvelope(envelope)) {
      throw corrupt(this.file, 'missing envelope fields');
    }
    if (envelope.v !== VAULT_VERSION || envelope.alg !== VAULT_ALGORITHM) {
      throw corrupt(
        this.file,
        `unsupported format v${String(envelope.v)}/${envelope.alg}`,
      );
    }

    let plaintext: string;
    try {
      const decipher = createDecipheriv(
        VAULT_ALGORITHM,
        this.key,
        Buffer.from(envelope.iv, 'base64'),
      );
      decipher.setAAD(VAULT_AAD);
      decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
      plaintext =
        decipher.update(
          Buffer.from(envelope.data, 'base64'),
          undefined,
          'utf8',
        ) + decipher.final('utf8');
    } catch (error) {
      throw corrupt(this.file, 'authentication failed', error);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(plaintext);
    } catch (error) {
      throw corrupt(this.file, 'decrypted payload is not JSON', error);
    }
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw corrupt(this.file, 'decrypted payload is not an object');
    }

    const contents: VaultContents = new Map();
    for (const [namespace, bucket] of Object.entries(
      parsed as Record<string, unknown>,
    )) {
      if (
        typeof bucket !== 'object' ||
        bucket === null ||
        Array.isArray(bucket)
      ) {
        throw corrupt(this.file, `namespace "${namespace}" is not an object`);
      }
      const values = new Map<string, string>();
      for (const [key, value] of Object.entries(bucket)) {
        // A non-string value would come back from `get` typed as `string` and
        // reach an Authorization header as "[object Object]".
        if (typeof value !== 'string') {
          throw corrupt(
            this.file,
            `value at ${namespace}.${key} is not a string`,
          );
        }
        values.set(key, value);
      }
      contents.set(namespace, values);
    }
    return contents;
  }

  /**
   * `Object.fromEntries` at both levels rather than assignment.
   *
   * `plain[namespace] = …` with a namespace of `__proto__` invokes the prototype
   * setter instead of defining a key, so the namespace would vanish on write and
   * come back empty on read. `fromEntries` defines the property.
   */
  private serialise(): string {
    return JSON.stringify(
      Object.fromEntries(
        [...this.contents].map(([namespace, bucket]) => [
          namespace,
          Object.fromEntries(bucket),
        ]),
      ),
    );
  }

  private write(): void {
    const iv = this.random(IV_BYTES);
    const cipher = createCipheriv(VAULT_ALGORITHM, this.key, iv);
    cipher.setAAD(VAULT_AAD);
    const data = Buffer.concat([
      cipher.update(this.serialise(), 'utf8'),
      cipher.final(),
    ]);

    const envelope: VaultEnvelope = {
      v: VAULT_VERSION,
      alg: VAULT_ALGORITHM,
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: data.toString('base64'),
    };

    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    // Write-then-rename, so an interrupted write cannot leave a half-encrypted
    // file where every credential used to be. The temporary file is created with
    // `0600` and rename preserves it.
    const temporary = `${this.file}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(envelope), {
        encoding: 'utf8',
        mode: 0o600,
      });
      renameSync(temporary, this.file);
    } catch (error) {
      try {
        unlinkSync(temporary);
      } catch {
        // Nothing useful to do: the original file is still intact either way.
      }
      throw new GhostError(
        'storage',
        `Cannot write the vault at ${this.file}`,
        {
          cause: error,
          details: { file: this.file },
        },
      );
    }
  }
}
