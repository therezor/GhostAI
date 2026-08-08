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
 *    `temperature` keeps the default model. Anything coarser makes an operator
 *    restate settings they did not want to change, which is how the two drift.
 *    `tools` is the deliberate exception — it replaces rather than merges,
 *    because a merge could add a tool and change a permission but never remove
 *    one, and switching a tool off has to be expressible.
 *  - **Resolution is where an unbuildable agent is refused.** A toolbox setting
 *    that cannot be honoured fails here, during `reconfigure`, which is
 *    all-or-nothing — so a settings save naming an unapproved toolbox is a 400
 *    that changes nothing, rather than a turn that dies minutes later. Only the
 *    half decidable from config is checked here; see `assertBuildable`.
 */

import {
  DEFAULT_AGENT_ID,
  GhostError,
  RESERVED_AGENT_IDS,
  isAgentId,
} from '@ghostbot/core';
import type { SubagentBinding } from '@ghostbot/agent';
import {
  AgentDefaultsSchema,
  DEFAULT_AGENT_TOOLS,
  DEFAULT_LIVE_STATE_TEMPLATE,
  subagentToolName,
  type AgentDefaults,
  type AgentEntry,
  type AgentTools,
  type AgentToolbox,
  type Config,
  type PromptMode,
  type ToolPromptOverrides,
  type ToolsConfig,
  namesDelimiter,
} from '@ghostbot/protocol';
import { parseCidr } from '@ghostbot/security';

/**
 * Which of an entry's fields belong to `AgentDefaults`.
 *
 * From the schema rather than from a parsed default object: `reasoningEffort` is
 * optional with no default, so it is *absent* from a parsed `agents.defaults` —
 * and a key walk over that instance would silently drop exactly the overrides an
 * operator went out of their way to set.
 */
const AGENT_DEFAULT_KEYS: readonly string[] = Object.keys(
  AgentDefaultsSchema.shape,
);

/** One agent, with every inherited field already resolved. */
export interface EffectiveAgent {
  readonly id: string;
  /** Never empty: falls back to the id, so a UI never has to. */
  readonly label: string;
  readonly systemPrompt: string;
  /**
   * The per-iteration half's templates. Empty means the built-ins.
   *
   * Resolved beside `systemPrompt` rather than read from the config downstream,
   * so every consumer sees one already-inherited answer.
   */
  readonly livePrompt: string;
  readonly wrapUpPrompt: string;
  /**
   * The three sections that used to be composed in code, and the mode that says
   * whether any of them are placed at all.
   *
   * Resolved here beside the other templates so a consumer sees one
   * already-inherited answer, rather than each of the loop, the editor and the
   * context inspector reaching into `agents.list` for its own.
   */
  readonly platformPrompt: string;
  readonly toolboxPrompt: string;
  readonly toolPolicyPrompt: string;
  /** The `## Memory` section. Empty means the built-in; a space removes it. */
  readonly memoryPrompt: string;
  /** The `## Skills` section, on the same contract. */
  readonly skillsPrompt: string;
  readonly promptMode: PromptMode;
  /** This agent's replacements for what its tools say about themselves. */
  readonly toolPrompts: ToolPromptOverrides;
  /** Model, provider, temperature, effort, caps — the whole of `AgentDefaults`. */
  readonly defaults: AgentDefaults;
  /** Which tools this agent may call, and what happens when it does. */
  readonly tools: AgentTools;
  /** `config.tools` with this agent's exec overrides applied. */
  readonly toolsConfig: ToolsConfig;
  readonly toolbox: AgentToolbox;
  /**
   * The agents this one may delegate to, in the operator's order.
   *
   * Resolved to the shape the loop is constructed with rather than left as the
   * stored refs, so the tool name is derived once — here — instead of in the
   * loop, the editor and whatever asks next.
   */
  readonly subagents: readonly SubagentBinding[];
}

/**
 * Something the settings asked for that had to be ignored to keep going.
 *
 * The counterpart to the `GhostError`s below, and the distinction is *whose
 * fault it is and when*. A malformed entry is the operator's, and it is refused
 * where they wrote it. A reference to an agent that has since been deleted is
 * nobody's — the id it names was legal when it was written — so refusing it
 * would let one delete stop an install that was working a moment ago.
 */
export interface AgentConfigWarning {
  readonly agentId: string;
  readonly code:
    | 'missing_subagent'
    | 'disabled_subagent'
    | 'illegal_agent_id'
    | 'tool_policy_missing_nonce'
    | 'unknown_tool_prompt';
  readonly message: string;
  readonly details: Readonly<Record<string, string>>;
}

/** Where a warning goes. Required, so a call site cannot drop one by omission. */
type WarningSink = (warning: AgentConfigWarning) => void;

/** Discards warnings, for the callers that resolve one agent and have no listener. */
const IGNORE_WARNINGS: WarningSink = () => {
  // Nothing is listening; see the doc above.
};

/** Why an id did not name an agent that could run. */
export type AgentMissReason = 'unknown' | 'disabled';

interface AgentResolution {
  /** What was asked for, verbatim — including an id that names nothing. */
  readonly requestedId: string;
  /** What would actually run. Never null: `default` when the request missed. */
  readonly agent: EffectiveAgent;
  /** `undefined` when `requestedId` resolved to itself. */
  readonly miss: AgentMissReason | undefined;
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
 * — `label`, `toolbox`, `tools` — and none of those belong in the block handed
 * to the loop. `workspace` is not among them: the schema omits it, so it can
 * only ever come from the defaults.
 */
function mergeDefaults(
  defaults: AgentDefaults,
  entry: AgentEntry | undefined,
): AgentDefaults {
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
function mergeToolsConfig(
  tools: ToolsConfig,
  entry: AgentEntry | undefined,
): ToolsConfig {
  if (entry === undefined) return tools;
  return { ...tools, exec: { ...tools.exec, ...defined(entry.exec) } };
}

/**
 * The label an agent id resolves to, without building the whole agent.
 *
 * A subagent's label is read off the *target's* entry, not written on the
 * reference: one place to rename an agent, and a reference that keeps up.
 */
function labelOf(config: Config, id: string): string {
  const label = config.agents.list[id]?.label ?? '';
  return label === '' ? id : label;
}

/**
 * The stored refs as the loop's bindings, dropping what cannot work.
 *
 * Two kinds of bad ref, and they are bad at *different moments*, which is why
 * they get different answers:
 *
 *  - **Malformed** — a ref to itself, or the same target twice. Decidable from
 *    this entry alone, and no edit to any *other* agent can cause it. Refused,
 *    as `invalid_input`, so a settings save reports it as the bad request it is
 *    and changes nothing.
 *  - **Dangling** — the target has been deleted or switched off. Caused by an
 *    edit somewhere else entirely, possibly months ago, possibly by hand while
 *    the server was down. Dropped with a warning.
 *
 * The second used to be refused too, and the argument for it was that a
 * subagent which looks configured in the editor and reports "no such agent" the
 * first time the model reaches for it is a bug report rather than a validation
 * message. That argument is about *save time*, and it still holds — a patch
 * that introduces a ref to nothing is still refused, by `pruneDanglingSubagents`
 * below, which strips it before it can be written. What changed is that a ref
 * *already on disk* no longer takes the install down with it: this function runs
 * inside `listAgents` inside `GhostRuntime#build`, so throwing here meant one
 * hand-edited line stopped the server from starting at all.
 *
 * What is *not* checked here: whether the target agent can actually resolve a
 * provider. That depends on credentials and on a provider being reachable, so
 * it is a runtime state rather than a config error — `#runSubagent` handles a
 * `null` loop by telling the model, which is the right altitude for it.
 */
function resolveSubagents(
  config: Config,
  id: string,
  entry: AgentEntry | undefined,
  warn: WarningSink,
): SubagentBinding[] {
  const refs = entry?.subagents ?? [];
  const bindings: SubagentBinding[] = [];
  const seen = new Set<string>();

  for (const ref of refs) {
    if (ref.id === id) {
      throw new GhostError(
        'invalid_input',
        `Agent "${id}" lists itself as a subagent.`,
        {
          details: { agentId: id },
        },
      );
    }
    if (seen.has(ref.id)) {
      throw new GhostError(
        'invalid_input',
        `Agent "${id}" lists "${ref.id}" as a subagent twice.`,
        {
          details: { agentId: id, subagentId: ref.id },
        },
      );
    }
    // `hasAgent` rather than a lookup, so `default` — which usually has no
    // entry at all — is delegable like any other agent.
    if (!hasAgent(config, ref.id)) {
      const missing = config.agents.list[ref.id] === undefined;
      const known = Object.keys(config.agents.list).join(', ');
      warn({
        agentId: id,
        code: missing ? 'missing_subagent' : 'disabled_subagent',
        message: missing
          ? `Agent "${id}" delegates to "${ref.id}", which does not exist. Known agents: ${known}`
          : `Agent "${id}" delegates to "${ref.id}", which is switched off.`,
        details: { agentId: id, subagentId: ref.id },
      });
      // Dropped rather than bound: a binding whose target cannot run would put a
      // tool in front of the model that fails every time it is called, which
      // reads to the model as its own mistake rather than as a missing agent.
      continue;
    }

    seen.add(ref.id);
    bindings.push({
      toolName: subagentToolName(ref.id),
      agentId: ref.id,
      label: labelOf(config, ref.id),
      prompt: ref.prompt,
      permission: ref.permission,
    });
  }

  return bindings;
}

/**
 * What can be decided from the config alone.
 *
 * Whether the named toolbox *exists and is approved* is not here, deliberately:
 * that needs the toolbox store, which is disk, and this function is the pure
 * inheritance rule. It is checked in `GhostRuntime#build`, which is equally
 * all-or-nothing, so a settings save naming an unapproved toolbox is still a 400
 * that changes nothing rather than a turn that dies later.
 */
/**
 * The live-state template this agent actually renders.
 *
 * Empty inherits the built-in, which names the delimiter; a single space deletes
 * the section, which does not. Same rule the prompt builder applies, asked here
 * so the warning is about the prompt an agent will carry.
 */
function liveTemplate(agent: EffectiveAgent): string {
  return agent.livePrompt === ''
    ? DEFAULT_LIVE_STATE_TEMPLATE
    : agent.livePrompt;
}

function assertBuildable(agent: EffectiveAgent, warn: WarningSink): void {
  const { name, network } = agent.toolbox;

  // A warning rather than a refusal, and the distinction is the whole design of
  // this feature: the envelopes around tool results are emitted by
  // `wrapToolOutput` whatever this text says, so a policy naming neither hole is
  // an agent that is *told* less, not one that is *guarded* less. Refusing the
  // save would make this the one template an operator does not own after all.
  // The delimiter has to be named *somewhere*, not specifically here. The
  // built-in policy deliberately names none — it is prose that never changes, so
  // it lives in the prompt's cached half and the live-state section supplies the
  // turn's tag. What leaves the model unable to identify a fence is neither
  // template naming it, which takes two edits to reach.
  const policy = agent.toolPolicyPrompt;
  if (
    policy.trim() !== '' &&
    !namesDelimiter(policy) &&
    !namesDelimiter(liveTemplate(agent))
  ) {
    warn({
      agentId: agent.id,
      code: 'tool_policy_missing_nonce',
      message:
        `Agent "${agent.id}" names {{tag}} in neither its tool-output policy nor its live-state section.\n` +
        "  Tool results are still wrapped in the turn's delimiter; the model is just not told which one.",
      details: { agentId: agent.id },
    });
  }

  if (name === '' && network.mode !== 'none') {
    throw new GhostError(
      'config',
      `Agent "${agent.id}" asks for toolbox network "${network.mode}" but names no toolbox.\n` +
        '  Egress scoping is enforced by the container, so it means nothing on the host.',
      { details: { agentId: agent.id, mode: network.mode } },
    );
  }

  for (const entry of network.allow) {
    if (parseCidr(entry) === null) {
      throw new GhostError(
        'config',
        `Agent "${agent.id}" has an egress entry that is not a CIDR block: ${entry}\n` +
          '  Hostnames are refused because DNS rebinding defeats them. Use 10.0.0.0/8.',
        { details: { agentId: agent.id, entry } },
      );
    }
  }
}

function build(
  config: Config,
  id: string,
  entry: AgentEntry | undefined,
  warn: WarningSink,
): EffectiveAgent {
  const agent: EffectiveAgent = {
    id,
    label: entry?.label === undefined || entry.label === '' ? id : entry.label,
    systemPrompt: entry?.systemPrompt ?? '',
    livePrompt: entry?.livePrompt ?? '',
    wrapUpPrompt: entry?.wrapUpPrompt ?? '',
    platformPrompt: entry?.platformPrompt ?? '',
    toolboxPrompt: entry?.toolboxPrompt ?? '',
    toolPolicyPrompt: entry?.toolPolicyPrompt ?? '',
    memoryPrompt: entry?.memoryPrompt ?? '',
    skillsPrompt: entry?.skillsPrompt ?? '',
    promptMode: entry?.promptMode ?? 'template',
    toolPrompts: entry?.toolPrompts ?? {},
    defaults: mergeDefaults(config.agents.defaults, entry),
    // The `default` agent usually has no `agents.list` entry at all, and an
    // agent with no tools cannot do anything — so the seed is the fallback
    // here as well as the schema's, not only the schema's.
    tools: entry?.tools ?? { ...DEFAULT_AGENT_TOOLS },
    toolsConfig: mergeToolsConfig(config.tools, entry),
    toolbox: entry?.toolbox ?? {
      name: '',
      network: { mode: 'none', allow: [] },
    },
    subagents: resolveSubagents(config, id, entry, warn),
  };
  assertBuildable(agent, warn);
  return agent;
}

/**
 * Tool prompt overrides naming a tool this agent will not advertise.
 *
 * Separate from `assertBuildable` because it needs something the pure
 * inheritance rule does not have: the toolbox's own programs, which are merged
 * over the agent's map in `#createLoop` and are not decidable from `agents.list`
 * alone. Checking without them would warn about every override on a toolboxed
 * agent, which is worse than not checking.
 *
 * Field names are not checked here for the same reason one step further on —
 * they need the tool's JSON Schema, which lives in the registry. The editor
 * validates those against the live definitions as they are typed, and the loop
 * logs whatever still gets through.
 */
export function toolPromptWarnings(
  agent: EffectiveAgent,
  advertised: ReadonlySet<string>,
): readonly AgentConfigWarning[] {
  const warnings: AgentConfigWarning[] = [];
  for (const name of Object.keys(agent.toolPrompts)) {
    if (advertised.has(name)) continue;
    warnings.push({
      agentId: agent.id,
      code: 'unknown_tool_prompt',
      message: `Agent "${agent.id}" rewrites the description of "${name}", which it does not have.`,
      details: { agentId: agent.id, tool: name },
    });
  }
  return warnings;
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
  // The pattern check as well as the lookup, so an entry stored under a key
  // that is not a legal id is invisible everywhere rather than only to
  // `resolveAgents` — otherwise it could be delegated to and bound to, and then
  // fail later at the one place that turns an id into a path.
  if (!isAgentId(id)) return false;
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
export function resolveAgent(
  config: Config,
  id: string | undefined,
): EffectiveAgent {
  const agentId = id === undefined || id === '' ? DEFAULT_AGENT_ID : id;
  const entry = config.agents.list[agentId];

  if (!hasAgent(config, agentId)) {
    const known = listAgents(config)
      .map((agent) => agent.id)
      .join(', ');
    throw new GhostError(
      'not_found',
      entry === undefined || !isAgentId(agentId)
        ? `No agent named "${agentId}". Known agents: ${known}`
        : `Agent "${agentId}" is disabled.`,
      { details: { agentId } },
    );
  }

  return build(config, agentId, entry, IGNORE_WARNINGS);
}

/**
 * The same answer as `resolveAgent`, degrading to `default` instead of throwing.
 *
 * The door for anything holding an id it did not choose — a session row, a
 * websocket frame, a browser's remembered preference. All three can name an
 * agent an operator deleted between when it was written and now, and none of
 * them is a place where "this install is broken" is a true thing to say.
 *
 * It degrades on **absence**, never on **fault**: an agent that exists but
 * cannot be built — an egress rule that is not a CIDR, a toolbox network with
 * no toolbox — still throws. Those are settings that were never going to work
 * and silently substituting a different agent for them would hide the one thing
 * the operator needs to see.
 *
 * The caller decides what to do about `miss`. Nothing here reports it, because
 * the vocabulary differs by surface: the hub raises a notice on the turn, the
 * context panel labels the figures it is showing, and the picker marks the
 * binding. A message written here would be wrong for two of the three.
 */
export function resolveAgentOrDefault(
  config: Config,
  id: string | undefined,
): AgentResolution {
  const requestedId = id === undefined || id === '' ? DEFAULT_AGENT_ID : id;
  const entry = config.agents.list[requestedId];

  if (hasAgent(config, requestedId)) {
    return {
      requestedId,
      agent: build(config, requestedId, entry, IGNORE_WARNINGS),
      miss: undefined,
    };
  }

  return {
    requestedId,
    agent: build(
      config,
      DEFAULT_AGENT_ID,
      config.agents.list[DEFAULT_AGENT_ID],
      IGNORE_WARNINGS,
    ),
    // An entry under an unusable key reads as `unknown` rather than `disabled`:
    // it is switched on, it just cannot be reached by that name, and telling
    // the operator it is disabled would send them to a toggle that is already
    // in the position they want.
    miss:
      entry === undefined || !isAgentId(requestedId) ? 'unknown' : 'disabled',
  };
}

/**
 * Every agent that can run a turn, plus what had to be ignored to build them.
 *
 * The default one first, then insertion order — the order the operator wrote
 * them in `config.json` and the order the picker shows.
 *
 * Warnings come out beside the agents rather than hanging off each one, because
 * `EffectiveAgent` is held by the loop and the picker and half the settings
 * tree, and none of those wants to carry a diagnostics list it will never read.
 */
export function resolveAgents(config: Config): {
  readonly agents: readonly EffectiveAgent[];
  readonly warnings: readonly AgentConfigWarning[];
} {
  const warnings: AgentConfigWarning[] = [];
  const warn: WarningSink = (warning) => warnings.push(warning);

  const agents: EffectiveAgent[] = [
    build(config, DEFAULT_AGENT_ID, config.agents.list[DEFAULT_AGENT_ID], warn),
  ];
  for (const [id, entry] of Object.entries(config.agents.list)) {
    if (id === DEFAULT_AGENT_ID || !entry.enabled) continue;
    // A key that is not a legal id got in by hand or through an older build:
    // the schema types this record's key as a plain string, deliberately, so
    // that a file carrying one still parses and can still be edited back out.
    // It is excluded rather than refused, because an id that cannot name a
    // directory cannot run a turn either — see `agentDirFor`.
    if (!isAgentId(id)) {
      warnings.push({
        agentId: id,
        code: 'illegal_agent_id',
        message:
          `"${id}" is not a usable agent id, so that agent is being ignored.\n` +
          '  Ids are lower-case letters, digits and hyphens, up to 40 characters.',
        details: { agentId: id },
      });
      continue;
    }
    agents.push(build(config, id, entry, warn));
  }
  return { agents, warnings };
}

/**
 * Every agent that can run a turn, the default one first.
 *
 * The warning-free half of `resolveAgents`, kept because most callers are
 * answering "which agents are there" and have nowhere to put a diagnostic.
 */
export function listAgents(config: Config): readonly EffectiveAgent[] {
  return resolveAgents(config).agents;
}

/**
 * The config with delegations to agents that no longer exist removed.
 *
 * Owned by `reconfigure` rather than by the merge, because "deleting
 * `agents.list.x` also edits `agents.list.y.subagents`" is knowledge about
 * agents and `mergeConfigPatch` is a generic tree merge — putting it there
 * would make a *preview* of a patch change more than the patch said. Owning it
 * at the route was the other option and is worse: there is more than one way
 * into a write, and a second one would silently skip the healing.
 *
 * It is what makes deleting a delegated-to agent work at all. The delete used
 * to leave a ref pointing at nothing, `resolveSubagents` threw a `config` error
 * on the rebuild, and because `applySettings` rebuilds *before* it writes, the
 * operator got a 500 and a file that had not changed — a delete that reported
 * as a server fault and then did nothing.
 *
 * Absent and disabled are treated differently on purpose:
 *
 *  - **Absent → pruned.** The ref can never work again. Only re-creating an
 *    agent under the same id would revive it, and that is a new agent.
 *  - **Disabled → kept.** Switching an agent off is documented as the
 *    reversible half of deleting it, so a delegation has to survive it.
 *    `resolveSubagents` drops the *binding* and warns; the *ref* stays in the
 *    file, and switching the agent back on restores the delegation.
 */
export function pruneDanglingSubagents(config: Config): {
  readonly config: Config;
  readonly removed: ReadonlyArray<{
    readonly agentId: string;
    readonly subagentId: string;
  }>;
} {
  const removed: Array<{
    readonly agentId: string;
    readonly subagentId: string;
  }> = [];
  const list: Record<string, AgentEntry> = {};

  for (const [id, entry] of Object.entries(config.agents.list)) {
    const kept = entry.subagents.filter((ref) => {
      // Present-but-disabled survives, so the test is the entry's existence
      // rather than `hasAgent`, which also answers false for a disabled agent.
      const exists =
        ref.id === DEFAULT_AGENT_ID || config.agents.list[ref.id] !== undefined;
      if (!exists) removed.push({ agentId: id, subagentId: ref.id });
      return exists;
    });
    list[id] =
      kept.length === entry.subagents.length
        ? entry
        : { ...entry, subagents: kept };
  }

  // The same object back when nothing changed, so a healthy config is not
  // rewritten into an equal-but-different one on every single save.
  if (removed.length === 0) return { config, removed };
  return { config: { ...config, agents: { ...config.agents, list } }, removed };
}

/**
 * Refuses a write that introduces an agent id nothing downstream can use.
 *
 * The record's key is typed as a plain string and stays that way: tightening
 * the *schema* would stop an install whose file already holds an odd key from
 * booting at all, which is the exact failure this whole area exists to remove.
 * So the rule lives on the write instead — a file already on disk keeps
 * loading, and nothing new gets in.
 *
 * Before/after rather than a flat check for the same reason. A key that is
 * already stored has to stay *deletable*: an id that cannot be written is
 * otherwise an id that can never be removed, and the operator is stuck with an
 * agent they cannot get rid of through the only interface that edits agents.
 *
 * `invalid_input` rather than `config`, because this is a request body being
 * refused — a 422 rather than a 500 about the operator's own file.
 */
export function assertWritableAgentIds(before: Config, after: Config): void {
  for (const id of Object.keys(after.agents.list)) {
    if (id in before.agents.list) continue;
    if (id === DEFAULT_AGENT_ID) continue;
    if (isAgentId(id) && !RESERVED_AGENT_IDS.has(id)) continue;

    throw new GhostError(
      'invalid_input',
      `"${id}" cannot be used as an agent id.\n` +
        '  Ids are lower-case letters, digits and hyphens, up to 40 characters,\n' +
        '  and cannot be a reserved device name.',
      { details: { agentId: id } },
    );
  }
}
