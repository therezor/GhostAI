/**
 * Finding one provider's API key.
 *
 * Two sources, one order, and a rule about when not to look at all. Kept in its
 * own module because precedence between two credential stores is the kind of
 * thing worth asserting directly, rather than inferring from a request header
 * three layers away.
 */

import type { GhostPaths } from '@ghostai/core';
import type { ProviderSpec } from '@ghostai/providers';
import { CredentialVault, keyFileStore, keychainStore, resolveVaultKey } from '@ghostai/security';

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
 * The credential for one provider: vault first, environment second.
 *
 * Returns `undefined` rather than throwing when there is none — a local model
 * server needs no key, and `createProvider` is what refuses a remote endpoint
 * that does. Vault failures are not swallowed: a vault that will not open means
 * the wrong key or a modified file, and quietly continuing without it would
 * reach the provider as an unexplained 401.
 *
 * The vault is opened lazily, and often not at all. `resolveVaultKey` writes a
 * key to the OS keychain the first time it runs, so doing it on every
 * `ghost chat` against a local Ollama — which needs no credential — would be a
 * keychain entry created for nothing.
 *
 * The vault wins over the environment: `spec.envKey` is documented as the
 * variable consulted when the vault holds no key, and an exported variable in
 * some shell must not silently override the credential the operator stored.
 */
export function findCredential(
  spec: ProviderSpec,
  paths: GhostPaths,
  env: Readonly<Record<string, string | undefined>>,
  vault: CredentialVault | false | undefined,
): string | undefined {
  const fromEnv = spec.envKey === undefined ? undefined : env[spec.envKey];
  const needsKey = spec.isLocal !== true || spec.envKey !== undefined;
  if (!needsKey || vault === false) return fromEnv === '' ? undefined : fromEnv;

  const opened = vault ?? openVault(paths);
  const stored = opened.get(PROVIDER_CREDENTIAL_NAMESPACE, spec.id);
  if (stored !== undefined && stored !== '') return stored;
  return fromEnv === '' ? undefined : fromEnv;
}
