/**
 * `GhostRuntime` as the server's routes want it.
 *
 * `@ghostai/server` states a narrow `ServerRuntime` port rather than importing
 * the composition root, so that a route test needs neither a provider nor a
 * vault nor a workspace. This is the adapter on the other side of that port,
 * and it lives here because `ghost serve` is where the two halves are wired
 * together in the first place.
 *
 * It is not a pass-through. Three things the port promises are implemented
 * *here* rather than in the runtime:
 *
 *  - **A settings save persists.** `GhostRuntime.reconfigure` deliberately does
 *    not write `config.json` — previewing a patch and saving one are different
 *    operations — so `applySettings` is reconfigure-then-write. The write runs
 *    after the rebuild, so a patch that cannot be built leaves both the running
 *    server and the file on the settings that worked.
 *  - **A credential written over HTTP is usable on the next turn.** The vault
 *    is written and then the runtime is rebuilt with an empty patch, which
 *    re-reads it: the provider adapter is keyed on a digest of the key, so a
 *    new key is a new adapter and the turn after the save uses it.
 *  - **The vault is opened only when there is one, or when one is being
 *    written.** `resolveVaultKey` mints a keychain entry the first time it
 *    runs, and an install that talks to a local model and never stores a
 *    credential should not acquire one because someone opened the settings
 *    panel.
 */

import { existsSync } from 'node:fs';

import { saveConfig } from '@ghostai/core';
import type { Config, ConfigPatch, SetCredentialRequest } from '@ghostai/protocol';
import { PROVIDERS } from '@ghostai/providers';
import { openVault, type GhostRuntime } from '@ghostai/runtime';
import type { AgentView, ServerRuntime } from '@ghostai/server';
import type { CredentialVault } from '@ghostai/security';

export interface ServerRuntimeOptions {
  /** Defaults to `process.env`; the presence flags read provider key variables. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Replaces the on-disk vault. Injected by tests, which have no keychain. */
  readonly vault?: CredentialVault;
}

export function createServerRuntime(
  runtime: GhostRuntime,
  options: ServerRuntimeOptions = {},
): ServerRuntime {
  const env = options.env ?? process.env;
  let vault: CredentialVault | undefined = options.vault;

  /** `create` is what separates reading presence from storing a key. */
  const openIfUseful = (create: boolean): CredentialVault | undefined => {
    if (vault !== undefined) return vault;
    if (!create && !existsSync(runtime.paths.vaultFile)) return undefined;
    vault = openVault(runtime.paths);
    return vault;
  };

  return {
    config: () => runtime.config,

    applySettings: (patch: ConfigPatch): Config => {
      const merged = runtime.reconfigure(patch);
      return saveConfig(runtime.file, merged);
    },

    credentialsPresent: (): Readonly<Record<string, boolean>> => {
      const stored = openIfUseful(false);
      const present: Record<string, boolean> = {};
      for (const spec of PROVIDERS) {
        const fromEnv = spec.envKey === undefined ? undefined : env[spec.envKey];
        present[spec.id] =
          (fromEnv !== undefined && fromEnv !== '') || stored?.has('providers', spec.id) === true;
      }
      return present;
    },

    setCredential: (request: SetCredentialRequest): void => {
      const store = openIfUseful(true);
      if (store === undefined) throw new Error('The credential vault could not be opened');
      if (request.value === null) store.delete(request.namespace, request.key);
      else store.set(request.namespace, request.key, request.value);
      // An empty patch is not a no-op: the rebuild re-reads the credential, and
      // without it the loop keeps the provider it was built with — so a key
      // saved in the UI would not take effect until a restart.
      runtime.reconfigure({});
    },

    store: runtime.store,

    agent: (): AgentView => ({
      provider: runtime.spec.id,
      model: runtime.model,
      jail: runtime.jail,
      tools: runtime.tools.definitions(),
      // The loop's own composition, not a second assembly of it: memory,
      // skills and profiles arrive as contributors attached to that object,
      // and a reimplementation here could not see them.
      systemPrompt: async (input) => await runtime.loop.previewPrompt(input),
    }),
  };
}
