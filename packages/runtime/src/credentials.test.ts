import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveGhostPaths } from '@ghostai/core';
import { findProvider, type ProviderSpec } from '@ghostai/providers';
import { CredentialVault } from '@ghostai/security';
import { afterEach, describe, expect, it } from 'vitest';

import { PROVIDER_CREDENTIAL_NAMESPACE, findCredential } from './credentials.js';

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ghostai-credentials-'));
  dirs.push(dir);
  return dir;
}

function vaultIn(dir: string): CredentialVault {
  return new CredentialVault({ file: join(dir, 'vault.json'), key: Buffer.alloc(32, 7) });
}

function spec(id: string): ProviderSpec {
  const found = findProvider(id);
  if (found === null) throw new Error(`no such provider: ${id}`);
  return found;
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe('findCredential', () => {
  const paths = resolveGhostPaths({ root: '/nowhere', env: {} });

  it('skips the vault entirely for a local server that needs no key', () => {
    // `resolveVaultKey` writes a key to the OS keychain the first time it runs,
    // and `ghost chat` against Ollama must not create one. Passing `undefined`
    // rather than `false` is the point: the real code path is exercised, and it
    // must not reach the keychain at all.
    expect(findCredential(spec('ollama'), paths, {}, undefined)).toBeUndefined();
  });

  it('prefers the vault over an exported environment variable', () => {
    const vault = vaultIn(tempDir());
    vault.set(PROVIDER_CREDENTIAL_NAMESPACE, 'openai', 'from-vault');

    expect(findCredential(spec('openai'), paths, { OPENAI_API_KEY: 'from-env' }, vault)).toBe(
      'from-vault',
    );
  });

  it('falls back to the environment when the vault holds nothing', () => {
    const vault = vaultIn(tempDir());
    expect(findCredential(spec('openai'), paths, { OPENAI_API_KEY: 'from-env' }, vault)).toBe(
      'from-env',
    );
  });

  it('treats an empty variable as absent rather than as an empty key', () => {
    expect(findCredential(spec('openai'), paths, { OPENAI_API_KEY: '' }, false)).toBeUndefined();
  });

  it('reads an env key for a local provider that declares one', () => {
    // `isLocal` alone does not mean "no credential": a LAN gateway is local and
    // still authenticates.
    const openrouter = spec('openrouter');
    expect(openrouter.envKey).toBeDefined();
    const env = { [openrouter.envKey ?? '']: 'from-env' };
    expect(findCredential(openrouter, paths, env, false)).toBe('from-env');
  });
});
