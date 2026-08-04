/**
 * Where an MCP server's secrets live.
 *
 * `mcp_servers` has been a legal `CredentialVault` namespace since before there
 * was a client — it is in `SetCredentialRequestSchema` beside `providers` — and
 * this is the module that finally uses it. The split it enforces is the one
 * `routes/settings.ts` already documents:
 *
 *  - **`headers` stays in `config.json`, in the clear.** It is operator-typed
 *    configuration, the panel showing it is the panel it was typed into, and
 *    pretending otherwise would be security theatre over a file the operator
 *    can open.
 *  - **Anything OAuth minted goes in the vault.** A refresh token is not
 *    operator-typed; it is a long-lived credential this process obtained, and
 *    `vault.ts` exists precisely so that one is encrypted at rest.
 *
 * The interface is here rather than the vault being taken directly so a test
 * can hold one in memory without a keychain, and so `oauth.ts` cannot reach any
 * namespace but its own.
 */

import type { CredentialVault } from '@ghostai/security';

export const MCP_CREDENTIAL_NAMESPACE = 'mcp_servers';

/** What OAuth persists per server. One key each, under the server's id. */
export type McpSecretSlot = 'tokens' | 'client';

export interface McpSecretStore {
  read(serverId: string, slot: McpSecretSlot): string | undefined;
  write(serverId: string, slot: McpSecretSlot, value: string): void;
  /** Omitting `slot` clears every slot for that server. */
  clear(serverId: string, slot?: McpSecretSlot): void;
}

function keyFor(serverId: string, slot: McpSecretSlot): string {
  return `${serverId}:${slot}`;
}

const SLOTS: readonly McpSecretSlot[] = ['tokens', 'client'];

export function vaultSecretStore(vault: CredentialVault): McpSecretStore {
  return {
    read: (serverId, slot) =>
      vault.get(MCP_CREDENTIAL_NAMESPACE, keyFor(serverId, slot)),
    write: (serverId, slot, value) => {
      vault.set(MCP_CREDENTIAL_NAMESPACE, keyFor(serverId, slot), value);
    },
    clear: (serverId, slot) => {
      for (const candidate of slot === undefined ? SLOTS : [slot]) {
        vault.delete(MCP_CREDENTIAL_NAMESPACE, keyFor(serverId, candidate));
      }
    },
  };
}

/**
 * A store with nowhere to persist.
 *
 * What an install with `vault: false` gets, and what every test uses. Tokens
 * survive the process and no longer, which for a build that switched the vault
 * off is the honest behaviour: the alternative is writing a refresh token to
 * somewhere it was explicitly not asked to go.
 */
export function memorySecretStore(): McpSecretStore {
  const contents = new Map<string, string>();
  return {
    read: (serverId, slot) => contents.get(keyFor(serverId, slot)),
    write: (serverId, slot, value) => {
      contents.set(keyFor(serverId, slot), value);
    },
    clear: (serverId, slot) => {
      for (const candidate of slot === undefined ? SLOTS : [slot]) {
        contents.delete(keyFor(serverId, candidate));
      }
    },
  };
}
