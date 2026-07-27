import { createCipheriv } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { isGhostError } from '@ghostai/core';

import {
  type CommandResult,
  type CommandRunner,
  CredentialVault,
  type KeyStore,
  VAULT_KEY_BYTES,
  keyFileStore,
  keychainStore,
  resolveVaultKey,
  systemCommandRunner,
} from './vault.js';

let base: string;
let file: string;

const KEY = Buffer.alloc(VAULT_KEY_BYTES, 7);
const OTHER_KEY = Buffer.alloc(VAULT_KEY_BYTES, 9);

const kindOf = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    return isGhostError(error) ? error.kind : 'not-a-ghost-error';
  }
  return 'did-not-throw';
};

const ok = (stdout = ''): CommandResult => ({ status: 0, stdout, stderr: '' });
const fail = (): CommandResult => ({ status: 1, stdout: '', stderr: 'nope' });
const unavailable = (): CommandResult => ({ status: null, stdout: '', stderr: '' });

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'ghostai-vault-')));
  file = join(base, 'credentials.enc');
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('keyFileStore', () => {
  it('round-trips a key', () => {
    const store = keyFileStore({ file: join(base, 'vault.key') });
    expect(store.load()).toBeNull();
    expect(store.save(KEY)).toBe(true);
    expect(store.load()?.equals(KEY)).toBe(true);
  });

  it('writes the key 0600', () => {
    const keyPath = join(base, 'nested', 'vault.key');
    keyFileStore({ file: keyPath }).save(KEY);
    expect(statSync(keyPath).mode & 0o777).toBe(0o600);
  });

  it('refuses a key file other users can read', () => {
    const keyPath = join(base, 'vault.key');
    const store = keyFileStore({ file: keyPath });
    store.save(KEY);
    chmodSync(keyPath, 0o644);
    // A key anyone on the host can read is not a key.
    expect(kindOf(() => store.load())).toBe('config');
    expect(() => store.load()).toThrow(/chmod 600/);
  });

  it('skips the permission check on win32, where the mode means nothing', () => {
    const keyPath = join(base, 'vault.key');
    const store = keyFileStore({ file: keyPath, platform: 'win32' });
    store.save(KEY);
    chmodSync(keyPath, 0o644);
    expect(store.load()?.equals(KEY)).toBe(true);
  });

  it('refuses a file that is not a key of the right length', () => {
    const keyPath = join(base, 'vault.key');
    writeFileSync(keyPath, Buffer.alloc(8).toString('base64'), { mode: 0o600 });
    expect(kindOf(() => keyFileStore({ file: keyPath }).load())).toBe('config');
  });

  it('tolerates trailing whitespace, which an editor adds', () => {
    const keyPath = join(base, 'vault.key');
    writeFileSync(keyPath, `${KEY.toString('base64')}\n`, { mode: 0o600 });
    expect(keyFileStore({ file: keyPath }).load()?.equals(KEY)).toBe(true);
  });
});

describe('keychainStore', () => {
  it('reads a key from the macOS keychain', () => {
    const run = vi.fn<CommandRunner>().mockReturnValue(ok(`${KEY.toString('base64')}\n`));
    const store = keychainStore({ platform: 'darwin', run });
    expect(store.name).toBe('keychain:darwin');
    expect(store.load()?.equals(KEY)).toBe(true);
    expect(run).toHaveBeenCalledWith('security', [
      'find-generic-password',
      '-s',
      'ghostai-vault',
      '-a',
      'master-key',
      '-w',
    ]);
  });

  it('writes to the macOS keychain with the secret on stdin, never in argv', () => {
    const run = vi.fn<CommandRunner>().mockReturnValue(ok());
    expect(keychainStore({ platform: 'darwin', run }).save(KEY)).toBe(true);
    const [, args, input] = run.mock.calls[0] ?? [];
    // argv is readable via `ps` for the life of the process.
    expect(args).not.toContain(KEY.toString('base64'));
    expect(args).toContain('-U');
    expect(input).toBe(KEY.toString('base64'));
  });

  it('reads and writes the Linux secret service', () => {
    const run = vi.fn<CommandRunner>().mockReturnValue(ok(KEY.toString('base64')));
    const store = keychainStore({ platform: 'linux', run });
    expect(store.name).toBe('keychain:linux');
    expect(store.load()?.equals(KEY)).toBe(true);
    expect(run.mock.calls[0]?.[0]).toBe('secret-tool');

    expect(store.save(KEY)).toBe(true);
    const [, args, input] = run.mock.calls[1] ?? [];
    expect(args).not.toContain(KEY.toString('base64'));
    expect(input).toBe(KEY.toString('base64'));
  });

  it.each(['darwin', 'linux'] as const)('reports no key when %s lookup fails', (platform) => {
    const store = keychainStore({ platform, run: () => fail() });
    expect(store.load()).toBeNull();
    expect(store.save(KEY)).toBe(false);
  });

  it.each(['darwin', 'linux'] as const)(
    'reports no key when the %s tool is missing',
    (platform) => {
      expect(keychainStore({ platform, run: () => unavailable() }).load()).toBeNull();
    },
  );

  it('treats a truncated keychain entry as absent rather than fatal', () => {
    // Regenerating a key is recoverable; refusing to start is not.
    const store = keychainStore({ platform: 'darwin', run: () => ok('dHJ1bmNhdGVk') });
    expect(store.load()).toBeNull();
  });

  it('reports unavailable on platforms with no usable tool', () => {
    const store = keychainStore({ platform: 'win32' });
    expect(store.name).toContain('unavailable');
    expect(store.load()).toBeNull();
    expect(store.save(KEY)).toBe(false);
  });

  it('defaults to this platform and the real command runner', () => {
    // Constructed only — calling load() here would prompt the developer's own
    // keychain, and on CI it would either fail or leave a key behind.
    expect(keychainStore().name).toMatch(/^keychain:/);
  });

  it('honours a custom service and account', () => {
    const run = vi.fn<CommandRunner>().mockReturnValue(ok());
    keychainStore({ platform: 'linux', run, service: 'svc', account: 'acct' }).load();
    expect(run.mock.calls[0]?.[1]).toEqual(['lookup', 'service', 'svc', 'account', 'acct']);
  });
});

describe('systemCommandRunner', () => {
  it('captures stdout and the exit status', () => {
    const result = systemCommandRunner(process.execPath, ['-e', 'process.stdout.write("hi")']);
    expect(result).toMatchObject({ status: 0, stdout: 'hi' });
  });

  it('passes stdin through', () => {
    const result = systemCommandRunner(
      process.execPath,
      ['-e', 'process.stdin.pipe(process.stdout)'],
      'echoed',
    );
    expect(result.stdout).toBe('echoed');
  });

  it('reports a missing binary as unavailable rather than throwing', () => {
    expect(systemCommandRunner('ghostai-no-such-binary', [])).toEqual({
      status: null,
      stdout: '',
      stderr: '',
    });
  });

  it('reports a non-zero exit', () => {
    expect(systemCommandRunner(process.execPath, ['-e', 'process.exit(3)']).status).toBe(3);
  });
});

describe('resolveVaultKey', () => {
  const store = (name: string, key: Buffer | null, accepts = true): KeyStore => ({
    name,
    load: () => key,
    save: () => accepts,
  });

  it('takes the first store that has a key', () => {
    expect(
      resolveVaultKey({ stores: [store('first', KEY), store('second', OTHER_KEY)] }),
    ).toMatchObject({ source: 'first', created: false });
  });

  it('falls through to a store that does have one', () => {
    const resolved = resolveVaultKey({ stores: [store('empty', null), store('keyfile', KEY)] });
    expect(resolved.source).toBe('keyfile');
    expect(resolved.key.equals(KEY)).toBe(true);
  });

  it('generates and persists a key on first run', () => {
    const saves: Buffer[] = [];
    const resolved = resolveVaultKey({
      stores: [
        { name: 'keychain', load: () => null, save: () => false },
        {
          name: 'keyfile',
          load: () => null,
          save: (key) => {
            saves.push(key);
            return true;
          },
        },
      ],
      random: (size) => Buffer.alloc(size, 3),
    });
    expect(resolved).toMatchObject({ source: 'keyfile', created: true });
    expect(resolved.key.byteLength).toBe(VAULT_KEY_BYTES);
    expect(saves[0]?.equals(resolved.key)).toBe(true);
  });

  it('fails rather than running with a key nothing stored', () => {
    // A vault under a key that was never written is a vault lost at restart.
    expect(kindOf(() => resolveVaultKey({ stores: [store('nope', null, false)] }))).toBe('config');
  });

  it('uses real randomness by default', () => {
    const saved: Buffer[] = [];
    const collect: KeyStore = {
      name: 'x',
      load: () => null,
      save: (key) => {
        saved.push(key);
        return true;
      },
    };
    resolveVaultKey({ stores: [collect] });
    resolveVaultKey({ stores: [collect] });
    expect(saved[0]?.equals(saved[1] ?? Buffer.alloc(0))).toBe(false);
  });

  it('works end to end against a real key file', () => {
    const keyPath = join(base, 'vault.key');
    const first = resolveVaultKey({ stores: [keyFileStore({ file: keyPath })] });
    expect(first.created).toBe(true);
    const second = resolveVaultKey({ stores: [keyFileStore({ file: keyPath })] });
    expect(second.created).toBe(false);
    expect(second.key.equals(first.key)).toBe(true);
  });
});

describe('CredentialVault', () => {
  const open = (key: Buffer = KEY): CredentialVault => new CredentialVault({ file, key });

  it('refuses a key of the wrong size', () => {
    expect(kindOf(() => new CredentialVault({ file, key: Buffer.alloc(16) }))).toBe(
      'invalid_input',
    );
  });

  it('starts empty when there is no file yet', () => {
    const vault = open();
    expect(vault.namespaces()).toEqual([]);
    expect(vault.get('providers', 'openai')).toBeUndefined();
    expect(existsSync(file)).toBe(false);
  });

  it('stores and reads back a secret', () => {
    const vault = open();
    vault.set('providers', 'openai', 'sk-secret');
    expect(vault.get('providers', 'openai')).toBe('sk-secret');
    expect(vault.has('providers', 'openai')).toBe(true);
    expect(vault.has('providers', 'groq')).toBe(false);
  });

  it('survives a reopen under the same key', () => {
    const first = open();
    first.set('providers', 'openai', 'sk-secret');
    first.set('channels', 'telegram', 'bot-token');
    const second = open();
    expect(second.get('providers', 'openai')).toBe('sk-secret');
    expect(second.get('channels', 'telegram')).toBe('bot-token');
    expect([...second.namespaces()].sort()).toEqual(['channels', 'providers']);
  });

  it('writes the file 0600 and leaves no temporary behind', () => {
    open().set('providers', 'openai', 'sk-secret');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(existsSync(`${file}.tmp`)).toBe(false);
  });

  it('keeps no plaintext in the file', () => {
    open().set('providers', 'openai', 'sk-super-secret-value');
    const raw = readFileSync(file, 'utf8');
    expect(raw).not.toContain('sk-super-secret-value');
    expect(raw).not.toContain('openai');
    expect(JSON.parse(raw)).toMatchObject({ v: 1, alg: 'aes-256-gcm' });
  });

  it('uses a fresh IV per write, so identical contents differ on disk', () => {
    const vault = open();
    vault.set('a', 'b', 'c');
    const first = readFileSync(file, 'utf8');
    vault.set('a', 'b', 'c');
    expect(readFileSync(file, 'utf8')).not.toBe(first);
  });

  it('rejects an empty namespace or key', () => {
    expect(
      kindOf(() => {
        open().set('', 'k', 'v');
      }),
    ).toBe('invalid_input');
    expect(
      kindOf(() => {
        open().set('ns', '', 'v');
      }),
    ).toBe('invalid_input');
  });

  it('deletes a value, and the namespace once it is empty', () => {
    const vault = open();
    vault.set('providers', 'openai', 'a');
    vault.set('providers', 'groq', 'b');
    expect(vault.delete('providers', 'openai')).toBe(true);
    expect(vault.keys('providers')).toEqual(['groq']);
    expect(vault.delete('providers', 'groq')).toBe(true);
    // An empty namespace would otherwise report a provider as still configured.
    expect(vault.namespaces()).toEqual([]);
    expect(open().namespaces()).toEqual([]);
  });

  it('reports a delete that matched nothing', () => {
    const vault = open();
    expect(vault.delete('providers', 'openai')).toBe(false);
    vault.set('providers', 'groq', 'b');
    expect(vault.delete('providers', 'openai')).toBe(false);
  });

  it('lists keys for a namespace, and nothing for an unknown one', () => {
    const vault = open();
    vault.set('providers', 'openai', 'a');
    expect(vault.keys('providers')).toEqual(['openai']);
    expect(vault.keys('nope')).toEqual([]);
  });

  it('clears one namespace', () => {
    const vault = open();
    vault.set('providers', 'openai', 'a');
    vault.set('channels', 'telegram', 'b');
    expect(vault.clear('providers')).toBe(1);
    expect(vault.namespaces()).toEqual(['channels']);
    expect(vault.clear('providers')).toBe(0);
  });

  it('clears everything', () => {
    const vault = open();
    vault.set('providers', 'openai', 'a');
    vault.set('providers', 'groq', 'b');
    vault.set('channels', 'telegram', 'c');
    expect(vault.clear()).toBe(3);
    expect(vault.namespaces()).toEqual([]);
    expect(open().namespaces()).toEqual([]);
  });

  it('describes namespaces and key names without values', () => {
    const vault = open();
    vault.set('providers', 'openai', 'sk-secret');
    vault.set('providers', 'groq', 'gsk-secret');
    const described = vault.describe();
    expect(described).toEqual({ providers: ['openai', 'groq'] });
    expect(JSON.stringify(described)).not.toContain('secret');
  });

  it('stores a key named like a prototype property without polluting anything', () => {
    const vault = open();
    vault.set('__proto__', 'polluted', 'yes');
    vault.set('constructor', 'polluted', 'yes');
    expect(vault.get('__proto__', 'polluted')).toBe('yes');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(open().get('__proto__', 'polluted')).toBe('yes');
  });

  describe('verify', () => {
    it('accepts the stored value and rejects anything else', () => {
      const vault = open();
      vault.set('auth', 'token', 'correct-horse');
      expect(vault.verify('auth', 'token', 'correct-horse')).toBe(true);
      expect(vault.verify('auth', 'token', 'correct-horsf')).toBe(false);
      expect(vault.verify('auth', 'token', 'correct')).toBe(false);
      expect(vault.verify('auth', 'token', '')).toBe(false);
    });

    it('rejects when nothing is stored', () => {
      expect(open().verify('auth', 'token', 'anything')).toBe(false);
    });
  });

  describe('refusing a vault it cannot authenticate', () => {
    it('refuses the wrong key rather than reporting an empty vault', () => {
      // Reporting empty would let the next write replace every credential.
      open().set('providers', 'openai', 'sk-secret');
      expect(kindOf(() => open(OTHER_KEY))).toBe('config');
      expect(() => open(OTHER_KEY)).toThrow(/authentication failed/);
    });

    it('refuses a modified ciphertext', () => {
      open().set('providers', 'openai', 'sk-secret');
      const envelope = JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>;
      const data = Buffer.from(envelope.data ?? '', 'base64');
      data[0] = (data[0] ?? 0) ^ 0xff;
      writeFileSync(file, JSON.stringify({ ...envelope, data: data.toString('base64') }));
      expect(() => open()).toThrow(/authentication failed/);
    });

    it('refuses a modified authentication tag', () => {
      open().set('providers', 'openai', 'sk-secret');
      const envelope = JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>;
      writeFileSync(
        file,
        JSON.stringify({ ...envelope, tag: Buffer.alloc(16).toString('base64') }),
      );
      expect(() => open()).toThrow(/authentication failed/);
    });

    it.each([
      ['a file that is not JSON', 'not json at all'],
      ['an envelope missing fields', '{"v":1}'],
      ['an envelope that is not an object', '"a string"'],
      ['a null envelope', 'null'],
    ])('refuses %s', (_name, contents) => {
      writeFileSync(file, contents);
      expect(kindOf(() => open())).toBe('config');
    });

    it('refuses a future format version', () => {
      open().set('providers', 'openai', 'sk-secret');
      const envelope = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
      writeFileSync(file, JSON.stringify({ ...envelope, v: 99 }));
      expect(() => open()).toThrow(/unsupported format v99/);
    });

    it('refuses a different algorithm', () => {
      open().set('providers', 'openai', 'sk-secret');
      const envelope = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
      writeFileSync(file, JSON.stringify({ ...envelope, alg: 'aes-128-cbc' }));
      expect(() => open()).toThrow(/unsupported format/);
    });

    it('refuses a directory where the vault should be', () => {
      // EISDIR, not ENOENT: this is not a first run, so it must not start empty.
      const asDirectory = join(base, 'vault-as-directory');
      mkdirSync(asDirectory);
      expect(kindOf(() => new CredentialVault({ file: asDirectory, key: KEY }))).toBe('config');
    });

    describe('a payload that decrypts but is not a credential store', () => {
      /** Encrypts arbitrary plaintext under the real key, so only the payload is wrong. */
      const writePayload = (plaintext: string): void => {
        const vault = open();
        vault.set('placeholder', 'x', 'y');
        const envelope = JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>;
        const iv = Buffer.from(envelope.iv ?? '', 'base64');
        const cipher = createCipheriv('aes-256-gcm', KEY, iv);
        cipher.setAAD(Buffer.from('ghostai-vault-v1', 'utf8'));
        const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
        writeFileSync(
          file,
          JSON.stringify({
            ...envelope,
            data: data.toString('base64'),
            tag: cipher.getAuthTag().toString('base64'),
          }),
        );
      };

      it.each([
        ['not JSON', 'plain text'],
        ['an array', '[1,2,3]'],
        ['null', 'null'],
        ['a namespace that is not an object', '{"providers":"oops"}'],
        ['a namespace that is an array', '{"providers":[]}'],
        ['a value that is not a string', '{"providers":{"openai":42}}'],
      ])('refuses %s', (_name, plaintext) => {
        writePayload(plaintext);
        expect(kindOf(() => open())).toBe('config');
      });
    });
  });

  it('reports a failed write as storage rather than losing the error', () => {
    const vault = open();
    vault.set('providers', 'openai', 'sk-secret');
    // Make the directory read-only so the rename cannot land.
    chmodSync(base, 0o500);
    try {
      expect(
        kindOf(() => {
          vault.set('providers', 'groq', 'gsk');
        }),
      ).toBe('storage');
    } finally {
      chmodSync(base, 0o700);
    }
  });
});
