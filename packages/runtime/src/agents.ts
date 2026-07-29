/**
 * Config in, one agent's effective settings out.
 *
 * An agent is `agents.defaults` with an `agents.list` entry laid over it. That
 * is the whole model, and keeping it in one pure function is what stops the
 * inheritance rule from being re-derived — slightly differently each time — in
 * the loop cache, the settings route and the UI.
 *
 * Three decisions worth stating, because each is the kind that looks arbitrary
 * later:
 *
 *  - **`default` is an agent, not the absence of one.** An install that has
 *    defined none still resolves to a complete `EffectiveAgent` under that id,
 *    so nothing downstream needs an "or the global settings" branch. It is also
 *    the only agent whose `enabled` flag is ignored: switching it off would
 *    leave an install with no agent at all, which is not a state anything above
 *    here can do anything useful with.
 *  - **Inheritance is per field, not per section.** An entry that names only
 *    `temperature` keeps the default model, and an entry that names only one
 *    approval band keeps the other three. Anything coarser makes an operator
 *    restate settings they did not want to change, which is how the two drift.
 *  - **Resolution is where an unbuildable agent is refused.** `docker` parses
 *    as a sandbox because the field is real and the UI should be able to show
 *    it; it fails here, during `reconfigure`, which is all-or-nothing — so a
 *    settings save naming a backend that does not exist is a 400 that changes
 *    nothing, rather than a turn that dies minutes later.
 */

import { DEFAULT_AGENT_ID, GhostError } from '@ghostai/core';
import {
  AgentDefaultsSchema,
  type AgentDefaults,
  type AgentEntry,
  type AgentMemoryScope,
  type AgentSandbox,
  type AgentToolsSelection,
  type Config,
  type ToolsConfig,
} from '@ghostai/protocol';

/**
 * Which of an entry's fields belong to `AgentDefaults`.
 *
 * From the schema rather than from a parsed default object: `reasoningEffort`
 * and `consolidationModel` are optional with no default, so they are *absent*
 * from a parsed `agents.defaults` — and a key walk over that instance would
 * silently drop exactly the overrides an operator went out of their way to set.
 */
const AGENT_DEFAULT_KEYS: readonly string[] = Object.keys(AgentDefaultsSchema.shape);

/** One agent, with every inherited field already resolved. */
export interface EffectiveAgent {
  readonly id: string;
  /** Never empty: falls back to the id, so a UI never has to. */
  readonly label: string;
  readonly systemPrompt: string;
  /** Model, provider, temperature, effort, caps — the whole of `AgentDefaults`. */
  readonly defaults: AgentDefaults;
  /** Which tools this agent may call. */
  readonly tools: AgentToolsSelection;
  /** `config.tools` with this agent's approval and exec overrides applied. */
  readonly toolsConfig: ToolsConfig;
  readonly sandbox: AgentSandbox;
  readonly memory: AgentMemoryScope;
}

/**
 * Drops the keys a patch left undefined.
 *
 * `{ ...base, ...patch }` would let an explicit `undefined` — which is what a
 * `patchOf` schema produces for a field nobody set — overwrite an inherited
 * value with nothing. The return type says so as well as the runtime does:
 * `Partial<T>` would keep `undefined` in each member and let the same bug back
 * in at the next call site.
 */
type Defined<T> = { [K in keyof T]?: Exclude<T[K], undefined> };

function defined<T extends object>(patch: T | undefined): Defined<T> {
  if (patch === undefined) return {};
  return Object.fromEntries(
    Object.entries(patch).filter(([, value]) => value !== undefined),
  ) as Defined<T>;
}

/**
 * The agent's `AgentDefaults`, field by field.
 *
 * Driven by `AGENT_DEFAULT_KEYS` rather than by the entry's own keys, because
 * the entry also carries fields that belong to the agent rather than to a turn
 * — `label`, `sandbox`, `tools` — and none of those belong in the block handed
 * to the loop. `workspace` is not among them: the schema omits it, so it can
 * only ever come from the defaults.
 */
function mergeDefaults(defaults: AgentDefaults, entry: AgentEntry | undefined): AgentDefaults {
  if (entry === undefined) return defaults;
  const overrides = defined(entry) as Record<string, unknown>;
  const merged: Record<string, unknown> = { ...defaults };
  for (const key of AGENT_DEFAULT_KEYS) {
    const value = overrides[key];
    if (value !== undefined) merged[key] = value;
  }
  return merged as AgentDefaults;
}

/** `config.tools`, narrowed by whatever this agent overrode. */
function mergeToolsConfig(tools: ToolsConfig, entry: AgentEntry | undefined): ToolsConfig {
  if (entry === undefined) return tools;
  return {
    ...tools,
    approvals: { ...tools.approvals, ...defined(entry.approvals) },
    exec: { ...tools.exec, ...defined(entry.exec) },
  };
}

function assertBuildable(agent: EffectiveAgent): void {
  if (agent.sandbox.kind === 'docker') {
    throw new GhostError(
      'config',
      `Agent "${agent.id}" asks for the docker sandbox, which is not implemented yet.\n` +
        '  Set its sandbox to "host" to run tools on this machine, inside the workspace jail.',
      { details: { agentId: agent.id, sandbox: agent.sandbox.kind } },
    );
  }
}

function build(config: Config, id: string, entry: AgentEntry | undefined): EffectiveAgent {
  const agent: EffectiveAgent = {
    id,
    label: entry?.label === undefined || entry.label === '' ? id : entry.label,
    systemPrompt: entry?.systemPrompt ?? '',
    defaults: mergeDefaults(config.agents.defaults, entry),
    tools: entry?.tools ?? { allow: [], deny: [] },
    toolsConfig: mergeToolsConfig(config.tools, entry),
    sandbox: entry?.sandbox ?? { kind: 'host', image: '', workdir: '/workspace', network: false },
    memory: entry?.memory ?? { shared: true },
  };
  assertBuildable(agent);
  return agent;
}

/**
 * Whether an id names an agent this config can run.
 *
 * `default` always does. Anything else has to be in `agents.list` *and*
 * enabled — a disabled agent is invisible to everything except the settings
 * tree that is about to re-enable it.
 */
export function hasAgent(config: Config, id: string): boolean {
  if (id === DEFAULT_AGENT_ID) return true;
  return config.agents.list[id]?.enabled === true;
}

/**
 * One agent's effective settings.
 *
 * `undefined` means the default agent, which is what a turn from a session
 * nobody has bound carries. Throws for an id that names nothing runnable —
 * callers that expect to be handed an arbitrary string from the wire should ask
 * `hasAgent` first and report the miss in their own vocabulary.
 */
export function resolveAgent(config: Config, id: string | undefined): EffectiveAgent {
  const agentId = id === undefined || id === '' ? DEFAULT_AGENT_ID : id;
  const entry = config.agents.list[agentId];

  if (agentId !== DEFAULT_AGENT_ID && entry?.enabled !== true) {
    const known = listAgents(config)
      .map((agent) => agent.id)
      .join(', ');
    throw new GhostError(
      'not_found',
      entry === undefined
        ? `No agent named "${agentId}". Known agents: ${known}`
        : `Agent "${agentId}" is disabled.`,
      { details: { agentId } },
    );
  }

  return build(config, agentId, entry);
}

/**
 * Every agent that can run a turn, the default one first.
 *
 * Insertion order after that, which is the order the operator wrote them in
 * `config.json` and the order the picker shows.
 */
export function listAgents(config: Config): readonly EffectiveAgent[] {
  const agents: EffectiveAgent[] = [
    build(config, DEFAULT_AGENT_ID, config.agents.list[DEFAULT_AGENT_ID]),
  ];
  for (const [id, entry] of Object.entries(config.agents.list)) {
    if (id === DEFAULT_AGENT_ID || !entry.enabled) continue;
    agents.push(build(config, id, entry));
  }
  return agents;
}
