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
  DEFAULT_WORKSPACE_ID,
  SessionStore,
  WorkspaceStore,
  resolveGhostPaths,
  workspaceDirFor,
  type Clock,
} from '@ghostai/core';
import {
  ConfigSchema,
  type Config,
  type ConfigPatch,
  type ToolDefinition,
} from '@ghostai/protocol';
import { WorkspaceJail } from '@ghostai/security';
import type { DatabaseSync } from 'node:sqlite';

import type { AgentView, ServerRuntime } from '../runtime.js';

export interface FakeRuntimeOptions {
  readonly database: DatabaseSync;
  /** The jail root. A temp directory in every test that touches a file. */
  readonly workspace: string;
  readonly config?: Config;
  readonly provider?: string;
  readonly model?: string;
  readonly tools?: readonly ToolDefinition[];
  readonly credentialsPresent?: Readonly<Record<string, boolean>>;
  readonly systemPrompt?: string;
  /** Injected where a test needs two rows to carry different timestamps. */
  readonly clock?: Clock;
}

export interface FakeRuntime extends ServerRuntime {
  /** Every patch this runtime was asked to apply, in order. */
  readonly patches: ConfigPatch[];
  /** Every credential write, with the value it was handed. */
  readonly credentialWrites: { namespace: string; key: string; value: string | null }[];
}

/** A deep merge over plain objects — enough for a patch, and nothing more. */
function merge(base: unknown, patch: unknown): unknown {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) return patch;
  if (typeof base !== 'object' || base === null || Array.isArray(base)) return patch;

  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    if (value === undefined) continue;
    out[key] = merge(out[key], value);
  }
  return out;
}

export function createFakeRuntime(options: FakeRuntimeOptions): FakeRuntime {
  const store = new SessionStore({
    database: options.database,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });
  const paths = resolveGhostPaths({ root: options.workspace, workspace: options.workspace });
  const jails = new Map<string, WorkspaceJail>();
  const jailFor = (workspaceId: string): WorkspaceJail => {
    const cached = jails.get(workspaceId);
    if (cached !== undefined) return cached;
    const made = new WorkspaceJail({ root: workspaceDirFor(paths, workspaceId) });
    jails.set(workspaceId, made);
    return made;
  };
  const jail = jailFor(DEFAULT_WORKSPACE_ID);
  const workspaces = new WorkspaceStore({ database: options.database, paths });
  const patches: ConfigPatch[] = [];
  const credentialWrites: { namespace: string; key: string; value: string | null }[] = [];

  let config = options.config ?? ConfigSchema.parse({});
  const credentials: Record<string, boolean> = { ...options.credentialsPresent };

  const agent: AgentView = {
    provider: options.provider ?? 'openai',
    model: options.model ?? 'gpt-test',
    jail,
    jailFor,
    tools: options.tools ?? [],
    systemPrompt: async ({ sessionKey }) =>
      options.systemPrompt ?? `# GhostAI\n\nSession: ${sessionKey}`,
  };

  return {
    patches,
    credentialWrites,
    workspaces,
    config: () => config,
    applySettings: (patch) => {
      patches.push(patch);
      config = ConfigSchema.parse(merge(config, patch));
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
    agent: () => agent,
  };
}
