/**
 * What the routes need from below the transport, stated as an interface.
 *
 * `@ghostai/runtime` is the composition root: it turns a config file into a
 * provider, a jail, a store, a registry and a loop. This package deliberately
 * does not import it. The dependency would type-check — nothing above the server
 * imports it back — but it would put the whole wiring graph behind every route
 * test, and the server would then be untestable without a provider, a workspace
 * and a vault. So the server states the *narrow* set of things a route actually
 * touches, and `ghost serve` supplies an adapter over `GhostRuntime`.
 *
 * The shape is deliberately made of calls rather than fields. `PATCH /api/settings`
 * rebuilds the provider, the jail and the loop, so a route holding a snapshot
 * taken at boot would keep answering with the model the operator just changed.
 * Everything that a settings save can move is read through a function.
 */

import type { SessionStore } from '@ghostai/core';
import type {
  Config,
  ConfigPatch,
  ModelsResponse,
  SetCredentialRequest,
  ToolDefinition,
} from '@ghostai/protocol';
import type { WorkspaceJail } from '@ghostai/security';
import type { PromptPreviewInput } from '@ghostai/agent';

/**
 * The agent as the status and context routes see it.
 *
 * A snapshot, taken per request: `provider`, `model` and `jail` are all
 * replaced by a reconfigure, and the tool list changes when `exec` is switched
 * off in the settings panel or an MCP server connects.
 */
export interface AgentView {
  readonly provider: string;
  readonly model: string;
  /** The one tree the file routes may reach, and the prompt's workspace root. */
  readonly jail: WorkspaceJail;
  /** Sorted by name, as the model is offered them. */
  readonly tools: readonly ToolDefinition[];
  /**
   * The system prompt a turn on this session would carry.
   *
   * Comes from the loop itself rather than being reassembled here — see
   * `AgentLoop.previewPrompt`, and the reason it exists.
   */
  systemPrompt(input: PromptPreviewInput): Promise<string>;
}

/** Counts `GET /api/status` reports for subsystems that land in later phases. */
export interface ExtensionCounts {
  readonly mcpServersConnected: number;
  readonly pluginsLoaded: number;
}

export interface ServerRuntime {
  /** The live settings tree. Replaced wholesale by `applySettings`. */
  config(): Config;

  /**
   * Applies a settings patch, rebuilds what depends on it, and persists it.
   *
   * Persistence is the adapter's job, not the runtime's: `GhostRuntime.reconfigure`
   * returns the merged config without writing `config.json`, because previewing
   * a patch and saving one are different operations. This method is the saving
   * one, so a UI that changes the model and reloads sees the change.
   *
   * Throws without applying anything when the merged settings cannot be built —
   * an unknown provider, an unusable workspace — leaving the server answering on
   * the settings that worked a moment ago.
   */
  applySettings(patch: ConfigPatch): Config;

  /**
   * Provider id → whether a usable credential exists.
   *
   * Booleans, never values. The vault is write-only over HTTP, and this is the
   * shape that lets a settings panel show "configured" without a key crossing
   * the network.
   */
  credentialsPresent(): Readonly<Record<string, boolean>>;

  /** Writes or clears one credential. A `null` value deletes the entry. */
  setCredential(request: SetCredentialRequest): void;

  /** Set when `config.json` failed to parse and the defaults are in use. */
  loadError?(): string | undefined;

  readonly store: SessionStore;

  agent(): AgentView;

  /**
   * The models to offer, when something can enumerate them.
   *
   * Absent by default: listing a provider's catalogue means a network call per
   * provider, and no adapter in `@ghostai/providers` makes one yet. The routes
   * fall back to what the settings tree names, which is honest — a model an
   * operator typed into `providers.<id>.models` is a model they intend to use.
   */
  models?(): Promise<ModelsResponse>;

  /** Zero for both until `@ghostai/mcp` and `@ghostai/plugin-host` exist. */
  extensions?(): ExtensionCounts;
}
