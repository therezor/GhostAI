/**
 * Finding one provider instance's API key.
 *
 * Two sources, one order, and a rule about when not to open the vault at all.
 * Kept in its own module because precedence between two credential stores is
 * the kind of thing worth asserting directly, rather than inferring from a
 * request header three layers away.
 */

import { existsSync } from 'node:fs';

import type { GhostPaths } from '@ghostwire/core';
import type { ProviderInstance } from '@ghostwire/providers';
import {
  CredentialVault,
  keyFileStore,
  keychainStore,
  resolveVaultKey,
} from '@ghostwire/security';

/** The vault namespace provider API keys live under. */
export const PROVIDER_CREDENTIAL_NAMESPACE = 'providers';

/**
 * Opens the vault, creating its key on first use.
 *
 * Exported so a caller that already knows it needs credentials — the settings
 * route writing a key the operator just typed — does not have to reproduce the
 * store order to get the same file.
 */
export function openVault(paths: GhostPaths): CredentialVault {
  const resolved = resolveVaultKey({
    stores: [keychainStore(), keyFileStore({ file: paths.keyFile })],
  });
  return new CredentialVault({ file: paths.vaultFile, key: resolved.key });
}

/**
 * The credential for one instance: vault first, environment second.
 *
 * **Keyed by instance id, not provider id.** Two Ollama servers are two
 * instances and can hold different tokens. Nothing had to be migrated for this:
 * the config migration gives a pre-instance entry an id equal to its provider
 * id, which is the string its key was already stored under.
 *
 * Returns `undefined` rather than throwing when there is none — a local model
 * server usually needs no key, and `createProvider` is what refuses a remote
 * endpoint that does. Vault failures are not swallowed: a vault that will not
 * open means the wrong key or a modified file, and quietly continuing without
 * it would reach the provider as an unexplained 401.
 *
 * The vault is opened only when one already exists on disk, and that condition
 * is doing real work rather than saving a file read. `resolveVaultKey` writes a
 * key to the OS keychain the first time it runs, so opening the vault on every
 * `ghostai chat` against a local Ollama would be a keychain entry created for an
 * install that never stores a credential.
 *
 * That check replaces a narrower one — "skip the vault entirely for a local
 * provider with no `envKey`" — which had the side effect of making a token
 * typed for a local instance unreadable. A LAN model server behind an auth
 * proxy is a real configuration, and `assertUsableApiBase` already permits a
 * key over plain HTTP to a private address, so the lookup was the only thing
 * standing in the way.
 *
 * The vault wins over the environment: `spec.envKey` is documented as the
 * variable consulted when the vault holds no key, and an exported variable in
 * some shell must not silently override the credential the operator stored.
 */
export function findCredential(
  instance: ProviderInstance,
  paths: GhostPaths,
  env: Readonly<Record<string, string | undefined>>,
  vault: CredentialVault | false | undefined,
): string | undefined {
  const envKey = instance.spec.envKey;
  const fromEnv = envKey === undefined ? undefined : env[envKey];
  const fallback = fromEnv === '' ? undefined : fromEnv;

  if (vault === false) return fallback;
  if (vault === undefined && !existsSync(paths.vaultFile)) return fallback;

  const opened = vault ?? openVault(paths);
  const stored = opened.get(PROVIDER_CREDENTIAL_NAMESPACE, instance.id);
  if (stored !== undefined && stored !== '') return stored;
  return fallback;
}
