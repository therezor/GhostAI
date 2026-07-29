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

import type { SessionStore, WorkspaceStore } from '@ghostai/core';
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
  /** Which agent this view describes. `default` unless one was asked for. */
  readonly id: string;
  /** Never empty: falls back to the id. */
  readonly label: string;
  /** The provider *instance* id, or empty when nothing is configured. */
  readonly provider: string;
  /** Empty when no model is configured. */
  readonly model: string;
  /** Whether a turn can run. False on a fresh install; every other route works. */
  readonly configured: boolean;
  /** The default workspace's tree — the one a request that names none gets. */
  readonly jail: WorkspaceJail;
  /**
   * The tree one workspace owns.
   *
   * Resolves any legal slug, registry row or not: a *detached* workspace's
   * sessions must keep reaching their own files. Deciding whether a workspace
   * is one the caller may still name is the route's job, not this one's.
   */
  jailFor(workspaceId: string): WorkspaceJail;
  /**
   * Sorted by name, as the model is offered them.
   *
   * This agent's, not the registry's: an agent with a tool subset must not be
   * described by a context inspector that lists tools it cannot call.
   */
  readonly tools: readonly ToolDefinition[];
  /** This agent's budget, which is what the context meter is measured against. */
  readonly contextWindowTokens: number;
  /**
   * The system prompt a turn on this session would carry.
   *
   * Comes from the loop itself rather than being reassembled here — see
   * `AgentLoop.previewPrompt`, and the reason it exists.
   */
  systemPrompt(input: PromptPreviewInput): Promise<string>;
}

/**
 * One agent, as a picker and the settings screen need it.
 *
 * Deliberately not the whole resolved agent: the full settings tree already
 * reaches the client through `GET /api/settings`, and a second, subtly
 * different copy of it is how the two drift.
 */
export interface AgentSummary {
  readonly id: string;
  readonly label: string;
  /** After inheritance, so a picker shows what a turn would actually use. */
  readonly model: string;
  readonly provider: string;
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
   * Re-reads `config.json` from disk and rebuilds what depends on it.
   *
   * The other direction from `applySettings`, which takes a patch from a client
   * and writes it out. This one takes what the *file* says and leaves it alone,
   * so it is the answer to every edit a running server cannot see: a config
   * changed in an editor, a plugin dropped in beside it, an endpoint that came
   * back on a different port.
   *
   * Throws without applying anything when the file cannot be built, leaving the
   * server on the settings it was already serving.
   */
  reload(): Config;

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

  /**
   * The workspace registry.
   *
   * Concrete, like `store`: this port is narrow about *behaviour* — the things
   * a settings save can move are read through a function — not about types.
   */
  readonly workspaces: WorkspaceStore;

  /**
   * One agent's view. `undefined` is the default agent.
   *
   * Takes an id because `tools`, `systemPrompt` and `contextWindowTokens` all
   * differ per agent — a status panel describing the default while a session
   * runs on another would be describing something that is not happening.
   *
   * Throws for an id that names nothing runnable, which is a 404 at the route.
   */
  agent(agentId?: string): AgentView;

  /** Every agent that can run a turn, the default one first. */
  agents(): readonly AgentSummary[];

  /**
   * The models to offer, fetched from the endpoints that can list them.
   *
   * Still optional, because a route test has no business opening a socket and
   * an adapter-free runtime has nothing to ask. When it is absent the routes
   * fall back to what the settings tree names, which is honest — a model an
   * operator typed into `providers.<id>.models` is a model they intend to use.
   *
   * `refresh` discards whatever the implementation cached. A page load must not
   * reach every configured endpoint on every render, and an operator who has
   * just pulled a new model must not have to wait out a TTL to see it.
   */
  models?(options?: { readonly refresh?: boolean }): Promise<ModelsResponse>;

  /** Zero for both until `@ghostai/mcp` and `@ghostai/plugin-host` exist. */
  extensions?(): ExtensionCounts;
}
