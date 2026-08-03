/**
 * Delegation: one agent handing a task to another and waiting for the answer.
 *
 * This file is the pure half — what a binding is, what the model is told about
 * it, when a delegation is refused, and how a finished run becomes a tool
 * result. The impure half is `AgentLoop.#runSubagent`, which is where the child
 * session is created and the child's events are forwarded.
 *
 * **Why the loop and not a tool.** Every other capability a model has is a
 * `defineTool` in `@ghostai/tools`, and this deliberately is not, for two
 * reasons that are both structural rather than stylistic:
 *
 *  - `@ghostai/tools` sits *below* this package in the layer graph, so a tool
 *    that started a turn would invert the dependency the layering rule exists to
 *    hold. A registry that could reach an `AgentLoop` is a registry that has the
 *    whole agent behind it.
 *  - `ToolContext` has no event sink. A tool returns a string when it is done,
 *    which is exactly the wrong shape for something that runs for a minute and
 *    whose whole value to a watching operator is *what it did on the way*. The
 *    loop is already an async generator; delegation is `yield*`.
 *
 * What follows from that is the nice part: a subagent's tool calls stream,
 * approve and abort through the machinery that already exists, because they are
 * a real turn on a real loop and not a special case of one.
 */

import { GhostError } from '@ghostai/core';
import {
  defaultSubagentPrompt,
  type ToolDefinition,
  type ToolPermission,
} from '@ghostai/protocol';
import type { ToolExecution } from '@ghostai/tools';

/**
 * How deep delegation may go.
 *
 * Three, because two is the shape people actually configure — an agent with a
 * researcher, and a researcher with a summariser — and the next number after
 * "enough" is where a cap belongs. It is a backstop rather than a budget: the
 * thing that actually stops runaway delegation is that every level costs a whole
 * turn, and the operator sees each one.
 */
export const MAX_SUBAGENT_DEPTH = 3;

/**
 * One agent this loop may delegate to, resolved.
 *
 * Built by the composition root from `EffectiveAgent.subagents` and handed to
 * the loop as a map keyed by `toolName`. It is deliberately the *only* map: the
 * definitions the model is shown and the permission the gate reads both come
 * from here, so a subagent cannot be advertised and then refused — the same
 * property `#createLoop` holds for tools by building one `ToolPermissions`.
 */
export interface SubagentBinding {
  readonly toolName: string;
  readonly agentId: string;
  /** Never empty — falls back to the id, as `EffectiveAgent.label` does. */
  readonly label: string;
  /** The operator's guidance. Empty means `describeSubagent` writes one. */
  readonly prompt: string;
  readonly permission: ToolPermission;
}

/** The one argument a delegation takes, as JSON Schema. Frozen, built once. */
const TASK_PARAMETERS: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  properties: {
    task: {
      type: 'string',
      description:
        'What the subagent should do, written as if to a colleague who cannot ' +
        'see this conversation. Include everything it needs; it does not share ' +
        'your history.',
    },
  },
  required: ['task'],
  additionalProperties: false,
});

/**
 * What the model reads when deciding whether to delegate.
 *
 * The operator's sentence, if they wrote one, is used *as* the description
 * rather than appended to a generated one. A tool description is the entire
 * basis on which a model chooses to call something, so an operator who writes
 * "use this when you need facts you do not have; ask for a summary, not raw
 * sources" is writing the part of this feature that decides when it fires —
 * and a preamble in front of it would only dilute that.
 *
 * The fallback names the agent and says the one thing a model cannot infer:
 * that the subagent starts from nothing and answers in prose.
 */
export function describeSubagent(binding: SubagentBinding): string {
  const own = binding.prompt.trim();
  if (own !== '') return own;
  // The sentence itself lives in `@ghostai/protocol` because the settings UI
  // shows it as the field's placeholder, and a second copy over there would be
  // a promise about what the model reads that could quietly stop being true.
  return defaultSubagentPrompt(binding.label);
}

/** The tool definition a subagent is advertised as. */
export function subagentDefinition(binding: SubagentBinding): ToolDefinition {
  return {
    name: binding.toolName,
    description: describeSubagent(binding),
    parameters: TASK_PARAMETERS,
    // Not `exec`, and not a new band. `ToolRisk` describes what a call does to
    // the machine, and delegating does nothing to it — the subagent's own calls
    // carry their own bands, and those are the ones an operator is asked about.
    risk: 'safe',
    source: 'builtin',
  };
}

/**
 * Why a delegation could not run.
 *
 * All three are answered with a tool *result* rather than a throw, for the
 * reason `deniedToolResult` exists: a model that is told its delegation was
 * refused can answer without it, and a turn that dies instead leaves the
 * operator with an error where an answer was possible.
 */
export type DelegationRefusal = 'unconfigured' | 'cycle' | 'too-deep';

/** The task string, as the model supplied it — or a refusal to parse it. */
export function parseTask(
  args: unknown,
): { readonly ok: true; readonly task: string } | undefined {
  if (typeof args !== 'object' || args === null) return undefined;
  const task = (args as { task?: unknown }).task;
  if (typeof task !== 'string' || task.trim() === '') return undefined;
  return { ok: true, task };
}

/**
 * Whether this delegation may proceed, given who is already above it.
 *
 * `chain` is the ancestor agent ids, oldest first, and it is carried on the turn
 * rather than held on the loop for a reason worth stating: loops are one per
 * agent and shared through an LRU cache, so anything depth-shaped stored on the
 * object would be wrong the moment the same agent appeared at two depths.
 *
 * Checking membership catches indirect cycles — A delegates to B, B is
 * configured to delegate to A — which the config-time self-reference check
 * cannot see, because neither entry is wrong on its own.
 */
export function refuseDelegation(
  chain: readonly string[],
  agentId: string,
): DelegationRefusal | undefined {
  if (chain.includes(agentId)) return 'cycle';
  if (chain.length >= MAX_SUBAGENT_DEPTH) return 'too-deep';
  return undefined;
}

/** What the model reads. Phrased to stop a retry, as `deniedToolResult` is. */
export function refusalText(
  refusal: DelegationRefusal,
  binding: SubagentBinding,
  chain: readonly string[],
): string {
  switch (refusal) {
    case 'unconfigured':
      return (
        `Cannot delegate to "${binding.label}": that agent has no provider or model ` +
        `configured, so it cannot run. Do not call it again — do the work yourself, ` +
        `or tell the user their "${binding.agentId}" agent needs setting up.`
      );
    case 'cycle':
      return (
        `Cannot delegate to "${binding.label}": it is already running above this ` +
        `call (${[...chain, binding.agentId].join(' → ')}). Do not call it again — ` +
        `finish the work here.`
      );
    case 'too-deep':
      return (
        `Cannot delegate to "${binding.label}": delegation is ${String(MAX_SUBAGENT_DEPTH)} ` +
        `levels deep already (${chain.join(' → ')}). Do not call it again — do the ` +
        `work yourself, or return what you have.`
      );
  }
}

/** A delegation that never started, as the one `tool` message it still owes. */
export function refusedExecution(
  refusal: DelegationRefusal,
  binding: SubagentBinding,
  chain: readonly string[],
): ToolExecution {
  return {
    name: binding.toolName,
    content: refusalText(refusal, binding, chain),
    isError: true,
    truncated: false,
    durationMs: 0,
    errorKind: refusal === 'unconfigured' ? 'config' : 'permission_denied',
  };
}

/** What a delegation returns when the subagent ran to the end and said nothing. */
export const EMPTY_SUBAGENT_RESULT =
  'The subagent finished without writing an answer. Treat it as having found nothing.';

/**
 * The subagent's turn, as the delegating model's tool result.
 *
 * The child's final text and nothing else. Not its tool calls, not its
 * reasoning, not a transcript — the entire point of delegating is that the
 * detour does not land in the caller's context window, and a result that
 * summarised the run would put a smaller version of it there anyway. What the
 * subagent did is on screen, and in its own session; what the model gets is the
 * answer.
 *
 * A `stopReason` other than `complete` is still an answer, and is reported as
 * one with a line saying it was cut short — a subagent that hit its iteration
 * cap has usually found most of what was asked, and throwing that away to
 * report a failure serves nobody. Only `error` is a failed call.
 *
 * **"Nothing" and "cut off with nothing" are different results**, and the
 * distinction is the whole reason the empty case is spelled out separately:
 * "it finished and found nothing" tells a model to stop looking, and reporting
 * that for a delegation the timeout killed is a lie it acts on.
 */
export function subagentResult(
  binding: SubagentBinding,
  outcome: { readonly text: string; readonly stopReason: string },
  durationMs: number,
): ToolExecution {
  const text = outcome.text.trim();
  const failed = outcome.stopReason === 'error';
  const cut = !failed && outcome.stopReason !== 'complete';

  let content: string;
  if (cut) {
    content =
      text === ''
        ? `The ${binding.label} agent stopped early (${outcome.stopReason}) without writing ` +
          `an answer. It did not finish — this is not a finding.`
        : `${text}\n\n(The ${binding.label} agent stopped early: ${outcome.stopReason}.)`;
  } else {
    content = text === '' ? EMPTY_SUBAGENT_RESULT : text;
  }

  return {
    name: binding.toolName,
    content,
    isError: failed,
    truncated: false,
    durationMs: Math.round(durationMs),
    ...(failed ? { errorKind: 'tool' as const } : {}),
  };
}

/**
 * A session key for one delegated run.
 *
 * A plain id, like every other session key. There was a `sub-` prefix here once
 * and it carried nothing a reader could rely on: `sessions.origin` is what says
 * a session is a delegation, it is what queries filter on, and it is what the UI
 * shows. A second, cosmetic copy of that fact in the key is one that can only
 * disagree with it.
 */
export function subagentSessionKey(newId: () => string): string {
  return newId();
}

/**
 * Builds the binding map a loop is constructed with.
 *
 * Refuses a duplicate tool name rather than letting the later entry win: two
 * subagents resolving to one name is an operator mistake that would otherwise
 * present as one of them silently never being callable.
 */
export function subagentMap(
  bindings: readonly SubagentBinding[],
): ReadonlyMap<string, SubagentBinding> {
  const map = new Map<string, SubagentBinding>();
  for (const binding of bindings) {
    if (map.has(binding.toolName)) {
      throw new GhostError(
        'config',
        `Two subagents resolve to the tool "${binding.toolName}"`,
        {
          details: { toolName: binding.toolName, agentId: binding.agentId },
        },
      );
    }
    map.set(binding.toolName, binding);
  }
  return map;
}
