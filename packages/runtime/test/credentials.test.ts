import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveGhostPaths } from '@ghostai/core';
import { findProvider, type ProviderInstance } from '@ghostai/providers';
import { CredentialVault } from '@ghostai/security';
import { afterEach, describe, expect, it } from 'vitest';

import { PROVIDER_CREDENTIAL_NAMESPACE, findCredential } from '#src/credentials.js';

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ghostai-credentials-'));
  dirs.push(dir);
  return dir;
}

function vaultIn(dir: string): CredentialVault {
  return new CredentialVault({ file: join(dir, 'vault.json'), key: Buffer.alloc(32, 7) });
}

/** An instance of `type`, named `id` — which defaults to the type, as a migrated config would. */
function instance(type: string, id = type): ProviderInstance {
  const spec = findProvider(type);
  if (spec === null) throw new Error(`no such provider: ${type}`);
  return {
    id,
    spec,
    config: { type, label: '', extraHeaders: {}, models: [], enabled: true },
  };
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe('findCredential', () => {
  const paths = resolveGhostPaths({ root: '/nowhere', env: {} });

  it('does not open a vault that does not exist yet', () => {
    // `resolveVaultKey` writes a key to the OS keychain the first time it runs,
    // and `ghost chat` against Ollama must not create one. Passing `undefined`
    // rather than `false` is the point: the real code path is exercised, and it
    // must not reach the keychain at all. `/nowhere` has no vault file.
    expect(findCredential(instance('ollama'), paths, {}, undefined)).toBeUndefined();
  });

  it('reads a token stored for a local instance', () => {
    // The regression this guards: the lookup used to short-circuit before the
    // vault for a local provider with no `envKey`, so a token typed for a LAN
    // Ollama behind an auth proxy was accepted by the UI and never sent.
    const vault = vaultIn(tempDir());
    vault.set(PROVIDER_CREDENTIAL_NAMESPACE, 'ollama-gpu', 'proxy-token');

    expect(findCredential(instance('ollama', 'ollama-gpu'), paths, {}, vault)).toBe('proxy-token');
  });

  it('keys the vault by instance, so two instances of one type differ', () => {
    const vault = vaultIn(tempDir());
    vault.set(PROVIDER_CREDENTIAL_NAMESPACE, 'ollama', 'laptop-token');
    vault.set(PROVIDER_CREDENTIAL_NAMESPACE, 'ollama-gpu', 'gpu-token');

    expect(findCredential(instance('ollama'), paths, {}, vault)).toBe('laptop-token');
    expect(findCredential(instance('ollama', 'ollama-gpu'), paths, {}, vault)).toBe('gpu-token');
  });

  it('finds a key stored before instances existed, under the provider id', () => {
    // The config migration gives a pre-instance entry an id equal to its
    // provider id, which is the string the vault already holds — so nothing
    // has to be re-entered.
    const vault = vaultIn(tempDir());
    vault.set(PROVIDER_CREDENTIAL_NAMESPACE, 'openai', 'stored-before');

    expect(findCredential(instance('openai'), paths, {}, vault)).toBe('stored-before');
  });

  it('prefers the vault over an exported environment variable', () => {
    const vault = vaultIn(tempDir());
    vault.set(PROVIDER_CREDENTIAL_NAMESPACE, 'openai', 'from-vault');

    expect(findCredential(instance('openai'), paths, { OPENAI_API_KEY: 'from-env' }, vault)).toBe(
      'from-vault',
    );
  });

  it('falls back to the environment when the vault holds nothing', () => {
    const vault = vaultIn(tempDir());
    expect(findCredential(instance('openai'), paths, { OPENAI_API_KEY: 'from-env' }, vault)).toBe(
      'from-env',
    );
  });

  it('treats an empty variable as absent rather than as an empty key', () => {
    expect(
      findCredential(instance('openai'), paths, { OPENAI_API_KEY: '' }, false),
    ).toBeUndefined();
  });

  it('reads an env key for a local provider that declares one', () => {
    // `isLocal` alone does not mean "no credential": a LAN gateway is local and
    // still authenticates.
    const openrouter = instance('openrouter');
    expect(openrouter.spec.envKey).toBeDefined();
    const env = { [openrouter.spec.envKey ?? '']: 'from-env' };
    expect(findCredential(openrouter, paths, env, false)).toBe('from-env');
  });
});
