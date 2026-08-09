/**
 * A `ServerRuntime` with no provider, no vault and no config file.
 *
 * The port exists so route tests do not have to stand up the composition root;
 * this is the implementation that takes it up on the offer. It holds a real
 * `SessionStore` and a real `WorkspaceJail` — the two things the routes actually
 * exercise, and the two whose fakes would be reimplementations of behaviour
 * worth testing against — and stubs everything a provider would be needed for.
 *
 * Not exported from `index.ts`: it is test scaffolding, and shipping it would
 * make "a runtime whose settings save goes nowhere" part of the public API.
 */

import {
  DEFAULT_AGENT_ID,
  DEFAULT_WORKSPACE_ID,
  GhostError,
  SessionStore,
  WorkspaceStore,
  resolveGhostPaths,
  workspaceDirFor,
  type Clock,
} from '@ghostwire/core';
import {
  ConfigSchema,
  type Config,
  type ConfigPatch,
  type ExtensionCommand,
  type ExtensionStatus,
  type McpServerStatus,
  type RunCommandRequest,
  type RunCommandResponse,
  type ToolDefinition,
} from '@ghostwire/protocol';
import { WorkspaceJail, type ToolboxListing } from '@ghostwire/security';
import type { DatabaseSync } from 'node:sqlite';

import type { AgentSummary, AgentView, ServerRuntime } from '#src/runtime.js';

export interface FakeRuntimeOptions {
  readonly database: DatabaseSync;
  /** The jail root. A temp directory in every test that touches a file. */
  readonly workspace: string;
  readonly config?: Config;
  readonly provider?: string;
  readonly model?: string;
  /** `false` drives the routes as a fresh install with no provider or model. */
  readonly configured?: boolean;
  /** What the default agent advertises — the context inspector's list. */
  readonly tools?: readonly ToolDefinition[];
  /**
   * What the registry holds, which is a superset in every real install.
   *
   * Defaults to `tools` so a test that only cares that a definition reaches a
   * route says it once. A test about the *difference* — the tool-list route
   * offering something no agent currently holds — sets both.
   */
  readonly registeredTools?: readonly ToolDefinition[];
  readonly toolboxes?: readonly ToolboxListing[];
  /**
   * Omitted entirely leaves the port's optional method absent, which is what a
   * build with no MCP client looks like — the case `GET /api/mcp` has to
   * answer for without a 501.
   */
  readonly mcpServers?: readonly McpServerStatus[];
  /**
   * Omitted entirely leaves the port's methods absent, which is what a build
   * with `extensions: false` looks like — a case the listing answers with `[]`
   * and the two writes answer with a 404.
   */
  readonly extensions?: readonly ExtensionStatus[];
  readonly commands?: readonly ExtensionCommand[];
  /** What `POST /api/commands/:id` answers with, when a test wires one. */
  readonly runCommand?: (
    id: string,
    input: RunCommandRequest,
  ) => RunCommandResponse;
  readonly credentialsPresent?: Readonly<Record<string, boolean>>;
  readonly systemPrompt?: string;
  /** The trailing turn the loop appends after the history. */
  readonly runtimeBlock?: string;
  /** Injected where a test needs two rows to carry different timestamps. */
  readonly clock?: Clock;
  /**
   * Stands in for the config file a reload re-reads.
   *
   * There is no file here, so a test that wants a reload to *change* something
   * — or to fail the way an unbuildable config does — says so with this.
   * Without it a reload returns what is already loaded, which is what reading
   * an unchanged file does.
   */
  readonly onReload?: () => Config;
}

export interface FakeRuntime extends ServerRuntime {
  /** Every patch this runtime was asked to apply, in order. */
  readonly patches: ConfigPatch[];
  /** What each `reload()` produced, in order. Empty until one is asked for. */
  readonly reloads: Config[];
  /** Every credential write, with the value it was handed. */
  readonly credentialWrites: Array<{
    namespace: string;
    key: string;
    value: string | null;
  }>;
  /** Every extension id an approve or revoke route asked for, in order. */
  readonly approvals: string[];
  readonly revocations: string[];
}

/**
 * A deep merge over plain objects — enough for a patch, and nothing more.
 *
 * `null` removes a key, which is the real merge's rule for the records an
 * operator adds to and removes from — `providers.*`, `agents.list.*`. Without
 * it a patch that deletes an agent would store a literal `null` where an entry
 * belongs and fail the re-parse below, so no route test could ever cover a
 * delete. It is deliberately blanket here where the real rule is a path list:
 * this is a fixture, and the paths it would need are exactly the ones tests use.
 */
function merge(base: unknown, patch: unknown): unknown {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
    return patch;
  }
  if (typeof base !== 'object' || base === null || Array.isArray(base)) {
    return patch;
  }

  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    if (value === undefined) continue;
    if (value === null) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- the key is the operator's
      delete out[key];
      continue;
    }
    out[key] = merge(out[key], value);
  }
  return out;
}

export function createFakeRuntime(options: FakeRuntimeOptions): FakeRuntime {
  const store = new SessionStore({
    database: options.database,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });
  const paths = resolveGhostPaths({
    root: options.workspace,
    workspace: options.workspace,
  });
  const jails = new Map<string, WorkspaceJail>();
  const jailFor = (workspaceId: string): WorkspaceJail => {
    const cached = jails.get(workspaceId);
    if (cached !== undefined) return cached;
    const made = new WorkspaceJail({
      root: workspaceDirFor(paths, workspaceId),
    });
    jails.set(workspaceId, made);
    return made;
  };
  const jail = jailFor(DEFAULT_WORKSPACE_ID);
  const workspaces = new WorkspaceStore({ database: options.database, paths });
  const patches: ConfigPatch[] = [];
  const approvals: string[] = [];
  const revocations: string[] = [];
  const reloads: Config[] = [];
  const credentialWrites: Array<{
    namespace: string;
    key: string;
    value: string | null;
  }> = [];

  let config = options.config ?? ConfigSchema.parse({});
  const credentials: Record<string, boolean> = {
    ...options.credentialsPresent,
  };

  const agent: AgentView = {
    id: DEFAULT_AGENT_ID,
    label: DEFAULT_AGENT_ID,
    provider: options.provider ?? 'openai',
    model: options.model ?? 'gpt-test',
    // A route test is about the route, and a fixture that defaulted to
    // unconfigured would make every one of them assert around a setup banner.
    configured: options.configured ?? true,
    jail,
    jailFor,
    tools: options.tools ?? [],
    contextWindowTokens: config.agents.defaults.contextWindowTokens,
    systemPrompt: async ({ sessionKey }) => ({
      staticPrompt:
        options.systemPrompt ?? `# GhostAI\n\nSession: ${sessionKey}`,
      runtimeBlock:
        options.runtimeBlock ?? '## Live state\n\nCurrent time: whenever',
    }),
  };

  /**
   * The named agents this fake knows about, beyond the default.
   *
   * Driven by `config.agents.list` so a route test that wants a second agent
   * sets one the same way an operator would, rather than through a second
   * fixture knob that could disagree with the settings tree.
   */
  const agentsFor = (): readonly AgentSummary[] => [
    {
      id: DEFAULT_AGENT_ID,
      label: DEFAULT_AGENT_ID,
      model: agent.model,
      provider: agent.provider,
    },
    ...Object.entries(config.agents.list)
      .filter(([id, entry]) => id !== DEFAULT_AGENT_ID && entry.enabled)
      .map(([id, entry]) => ({
        id,
        label: entry.label === '' ? id : entry.label,
        model: entry.model ?? agent.model,
        provider: agent.provider,
      })),
  ];

  return {
    toolboxes: () => options.toolboxes ?? [],
    // A route test standing in for a runtime has no settings file to have
    // failed to read and no extensions to count, so these are the "nothing to
    // report" answers. Stated rather than left off: they were optional on the
    // port precisely so three implementations did not all have to change, and
    // that is how `loadError` and `extensions` came to be declared capabilities
    // that no implementation anywhere provided.
    loadError: () => undefined,
    configWarnings: () => [],
    releaseWorkspace: () => undefined,
    extensions: () => ({
      mcpServersConnected: (options.mcpServers ?? []).filter(
        (server) => server.state === 'ready',
      ).length,
      extensionsLoaded: (options.extensions ?? []).filter(
        (extension) => extension.state === 'ready',
      ).length,
    }),
    // Present only when a test supplies servers, so the absent case — a build
    // with no MCP client at all — is the default rather than something a test
    // has to remember to arrange.
    ...(options.mcpServers === undefined
      ? {}
      : { mcpServers: () => options.mcpServers ?? [] }),
    // The same arrangement, for the same reason: absent is the default, so a
    // test about a build with no extension host arranges nothing.
    ...(options.extensions === undefined
      ? {}
      : {
          extensionStatuses: () => options.extensions ?? [],
          approveExtension: (id: string) => {
            approvals.push(id);
            return Promise.resolve();
          },
          revokeExtension: (id: string) => {
            revocations.push(id);
            return Promise.resolve();
          },
        }),
    ...(options.commands === undefined
      ? {}
      : {
          commands: () => options.commands ?? [],
          runCommand: (id, input) =>
            Promise.resolve(
              options.runCommand?.(id, input) ?? { message: '', ok: true },
            ),
        }),
    approvals,
    revocations,
    patches,
    reloads,
    credentialWrites,
    workspaces,
    config: () => config,
    applySettings: (patch) => {
      patches.push(patch);
      config = ConfigSchema.parse(merge(config, patch));
      return config;
    },
    reload: () => {
      // Assigned before it is recorded: a hook that throws is a file that could
      // not be built, and that leaves the runtime on what it was serving.
      config = options.onReload?.() ?? config;
      reloads.push(config);
      return config;
    },
    credentialsPresent: () => credentials,
    setCredential: (request) => {
      credentialWrites.push({ ...request });
      if (request.namespace === 'providers') {
        // `false`, not a delete: the settings panel distinguishes "no key" from
        // "never asked", and `no-dynamic-delete` is right that removing a key
        // by name is the wrong tool for it.
        credentials[request.key] = request.value !== null;
      }
    },
    store,
    agent: (agentId?: string) => {
      if (agentId === undefined || agentId === DEFAULT_AGENT_ID) return agent;
      const named = agentsFor().find((candidate) => candidate.id === agentId);
      if (named === undefined) {
        throw new GhostError('not_found', `No agent named "${agentId}"`);
      }
      return { ...agent, id: named.id, label: named.label, model: named.model };
    },

    registeredTools: () => options.registeredTools ?? options.tools ?? [],

    agents: agentsFor,
  };
}
