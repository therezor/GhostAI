/**
 * The CLI's view of `@ghostwire/runtime`.
 *
 * There is nothing CLI-shaped left here. The composition root moved to its own
 * package the moment a second consumer needed it — the server shares one
 * `DatabaseSync` with its auth store and reconfigures without dropping the
 * session store, neither of which a terminal ever asks for — and duplicating
 * the wiring is how the Python original ended up with three implementations of
 * the same startup.
 *
 * What remains is the naming — `createChatRuntime` is what `ghostai chat` calls
 * — plus `saveSettings`, which is the one thing a terminal does to the settings
 * tree that the server's own port does differently. See its own note.
 */

import { GhostError, saveConfig } from '@ghostwire/core';
import { DEFAULT_AGENT_ID } from '@ghostwire/core';
import {
  AgentEntrySchema,
  type AgentSettings,
  type Config,
  type ConfigPatch,
} from '@ghostwire/protocol';
import {
  createRuntime,
  type GhostRuntime,
  type RuntimeOptions,
} from '@ghostwire/runtime';

export {
  PROVIDER_CREDENTIAL_NAMESPACE,
  findCredential,
  type RuntimeOptions,
} from '@ghostwire/runtime';

export type ChatRuntime = GhostRuntime;

export function createChatRuntime(options: RuntimeOptions = {}): ChatRuntime {
  return createRuntime(options);
}

/**
 * Applies a settings patch and writes it to `config.json`.
 *
 * `ServerRuntime.applySettings` (`server-runtime.ts`) is the same two steps
 * plus a credential sweep, and this is deliberately not a call into that: the
 * REPL never builds a `ServerRuntime` — it is a Fastify-shaped port with
 * toolbox approvals and credential writes on it — and the sweep only has
 * anything to do when a patch *removes a provider instance*, which the patches
 * a chat prompt sends never do.
 *
 * A failure here is the operator's file, not the operator's typing: a
 * `config.json` that is read-only, or a home directory that is not writable.
 * `GhostError` is what `runSlashCommand` already catches and renders as a
 * warning, so the prompt says why and stays open rather than unwinding with a
 * stack trace over a half-applied change. The reconfigure has already landed at
 * that point, which is the honest outcome to report: this run moved, the file
 * did not.
 */
export function saveSettings(
  runtime: GhostRuntime,
  patch: ConfigPatch,
): Config {
  const merged = runtime.reconfigure(patch);
  try {
    return saveConfig(runtime.file, merged);
  } catch (error) {
    throw new GhostError(
      'storage',
      `The change is live for this run, but ${runtime.file} could not be written`,
      {
        cause: error,
        details: { file: runtime.file },
      },
    );
  }
}

/**
 * One agent's settings, resolved.
 *
 * A thin read, and it exists so the callers that want a budget rather than a
 * loop do not each write the fallback. Nothing is inherited: an id naming no
 * agent gets the schema's answer, which is the same thing an entry that names
 * none of these fields would have got.
 */
export function settingsOf(
  runtime: GhostRuntime,
  agentId: string | undefined,
): AgentSettings {
  const id =
    agentId === undefined || agentId === '' ? DEFAULT_AGENT_ID : agentId;
  return runtime.config.agents.list[id] ?? AgentEntrySchema.parse({});
}
