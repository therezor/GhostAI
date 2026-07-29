/**
 * The agent editor's form, as pure functions.
 *
 * Validation is the part of a settings screen worth testing, and a component
 * test can only reach it through seven keystrokes and a button press — so it
 * lives here, in functions that take strings and return a `ConfigPatch` or the
 * errors that stopped one.
 *
 * **Both halves of an agent are in this one module**, and they used to be in
 * two — this half in `agents/`, the `agents.defaults` half in `settings/`, back
 * when there was a separate Agent panel in Settings. That split outlived the
 * panel, and it cost something concrete: `workspace` sat in the settings half
 * and was still being written into every patch after the field it came from had
 * been reasoned about, because the two halves were never read side by side.
 *
 * What genuinely differs between them is inheritance, and that is why there are
 * still two form types rather than one:
 *
 *  - `AgentForm` edits `agents.defaults`, where every field has a value. Two
 *    states: set, or set to something else.
 *  - `AgentEntryForm` edits `agents.list.<id>`, where nearly every field is an
 *    *override*. An empty box means "inherit", not "set to empty", so it has
 *    three states where the other has two: set, cleared, and never touched.
 *
 * The three-state case works because the merge replaces an agent wholesale
 * rather than field by field — see `REPLACE_WHOLESALE` in `@ghostai/runtime`.
 * The patch this builds *is* the agent, so a field left out of it is a field
 * cleared, and an empty box means "inherit" all the way through to the stored
 * config. Under a per-field merge, emptying a box would silently keep the value
 * that was just deleted.
 *
 * One asymmetry is deliberate and is a property of the patch format rather than
 * of this file. `reasoningEffort` and `temperature` are optional in the config
 * and a patch has no way to say "remove this key" — an absent field means "not
 * mentioned", never "delete". So the form can set either and cannot unset it,
 * and the screen says so rather than offering a control that silently does
 * nothing.
 */

import {
  DEFAULT_AGENT_ID,
  type AgentDefaults,
  type AgentEntry,
  type ConfigPatch,
  type ReasoningEffort,
} from '@ghostai/protocol';

import { msToSeconds, parseNumber, secondsToMs, type PatchResult } from '@/settings/fields.js';

export type { PatchResult };

/**
 * The value an "inherit" option carries.
 *
 * Not the empty string, which is what the form holds: an empty `value` means
 * *no* value to a Radix select, so the option would select nothing and the
 * trigger would render blank — a control that looks broken while working.
 */
export const INHERIT_VALUE = '__inherit__';

/** `agents.defaults` — the values every agent inherits. */
export interface AgentForm {
  readonly provider: string;
  readonly model: string;
  readonly maxTokens: string;
  readonly contextWindowTokens: string;
  readonly temperature: string;
  readonly maxToolIterations: string;
  /** `''` means the provider's own default — see the note above. */
  readonly reasoningEffort: string;
  readonly toolTimeoutSeconds: string;
  readonly loopWallTimeoutSeconds: string;
  readonly learningEnabled: boolean;
  readonly learningInterval: string;
}

export const REASONING_EFFORTS: readonly ReasoningEffort[] = ['minimal', 'low', 'medium', 'high'];

export function toAgentForm(defaults: AgentDefaults): AgentForm {
  return {
    provider: defaults.provider,
    model: defaults.model,
    maxTokens: String(defaults.maxTokens),
    contextWindowTokens: String(defaults.contextWindowTokens),
    temperature: defaults.temperature === undefined ? '' : String(defaults.temperature),
    maxToolIterations: String(defaults.maxToolIterations),
    reasoningEffort: defaults.reasoningEffort ?? '',
    toolTimeoutSeconds: msToSeconds(defaults.toolTimeoutMs),
    loopWallTimeoutSeconds: msToSeconds(defaults.loopWallTimeoutMs),
    learningEnabled: defaults.learningEnabled,
    learningInterval: String(defaults.learningInterval),
  };
}

/**
 * Every numeric field is checked, and *all* failures are returned rather than
 * the first: a form that reports one error per press makes the operator find
 * them one press at a time.
 *
 * The bounds mirror `AgentDefaultsSchema`. They are a courtesy — the server
 * refuses an out-of-range patch either way — so being one off here shows a
 * message a moment early, not a wrong setting.
 */
export function toAgentPatch(form: AgentForm): PatchResult {
  const errors: Record<string, string> = {};

  const maxTokens = parseNumber(form.maxTokens, { integer: true, min: 1 });
  const contextWindowTokens = parseNumber(form.contextWindowTokens, { integer: true, min: 1 });
  // Blank is a value here, not a mistake: it means "send no temperature and
  // let the provider apply its own", which is the only thing that works for a
  // model that rejects the parameter.
  const temperature =
    form.temperature.trim() === '' ? undefined : parseNumber(form.temperature, { min: 0, max: 2 });
  const maxToolIterations = parseNumber(form.maxToolIterations, { integer: true, min: 1 });
  const toolTimeout = parseNumber(form.toolTimeoutSeconds, { min: 0 });
  const loopWallTimeout = parseNumber(form.loopWallTimeoutSeconds, { min: 0 });
  const learningInterval = parseNumber(form.learningInterval, { integer: true, min: 1 });

  const collect = (field: string, result: ReturnType<typeof parseNumber>): void => {
    if (!result.ok) errors[field] = result.error;
  };
  collect('maxTokens', maxTokens);
  collect('contextWindowTokens', contextWindowTokens);
  if (temperature !== undefined) collect('temperature', temperature);
  collect('maxToolIterations', maxToolIterations);
  collect('toolTimeoutSeconds', toolTimeout);
  collect('loopWallTimeoutSeconds', loopWallTimeout);
  collect('learningInterval', learningInterval);

  if (form.provider.trim() === '') errors.provider = 'Required';

  if (
    !maxTokens.ok ||
    !contextWindowTokens.ok ||
    !maxToolIterations.ok ||
    !toolTimeout.ok ||
    !loopWallTimeout.ok ||
    !learningInterval.ok ||
    Object.keys(errors).length > 0
  ) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    patch: {
      agents: {
        defaults: {
          provider: form.provider.trim(),
          // Trimmed, and empty is meaningful: an empty model asks the registry
          // to resolve one.
          model: form.model.trim(),
          // `workspace` is deliberately absent, and its absence is load-bearing.
          // The browser no longer offers a control for the agent's filesystem
          // root — repointing the sandbox is not something a settings form
          // should be able to do — so this patch must not mention it either.
          // `agents.defaults` merges per field (only `agents.list.*` is in
          // `REPLACE_WHOLESALE`), so an omitted key preserves whatever the file,
          // the environment or `--workspace` set. Sending `''` here would look
          // identical in a diff and would silently reset a configured root on
          // every save of an unrelated field.
          maxTokens: maxTokens.value,
          contextWindowTokens: contextWindowTokens.value,
          maxToolIterations: maxToolIterations.value,
          toolTimeoutMs: secondsToMs(toolTimeout.value),
          loopWallTimeoutMs: secondsToMs(loopWallTimeout.value),
          learningEnabled: form.learningEnabled,
          learningInterval: learningInterval.value,
          ...(temperature?.ok === true ? { temperature: temperature.value } : {}),
          ...(isReasoningEffort(form.reasoningEffort)
            ? { reasoningEffort: form.reasoningEffort }
            : {}),
        },
      },
    },
  };
}

export interface AgentEntryForm {
  readonly label: string;
  readonly systemPrompt: string;
  readonly enabled: boolean;
  /** Empty inherits from `agents.defaults`. */
  readonly provider: string;
  readonly model: string;
  readonly maxTokens: string;
  readonly contextWindowTokens: string;
  readonly temperature: string;
  readonly reasoningEffort: string;
  readonly toolTimeoutSeconds: string;
  /** Comma-separated tool names. Empty means "everything not denied". */
  readonly allowTools: string;
  readonly denyTools: string;
  /** Risk band → policy, empty inheriting the global `tools.approvals`. */
  readonly approveExec: string;
  readonly approveNetwork: string;
  readonly approveWrite: string;
}

export const APPROVAL_POLICIES: readonly string[] = ['allow', 'ask', 'deny'];

/** A number the agent overrode, or empty when it inherits. */
function optionalNumber(value: number | undefined): string {
  return value === undefined ? '' : String(value);
}

export function toAgentEntryForm(entry: AgentEntry): AgentEntryForm {
  return {
    label: entry.label,
    systemPrompt: entry.systemPrompt,
    enabled: entry.enabled,
    provider: entry.provider ?? '',
    model: entry.model ?? '',
    maxTokens: optionalNumber(entry.maxTokens),
    contextWindowTokens: optionalNumber(entry.contextWindowTokens),
    temperature: optionalNumber(entry.temperature),
    reasoningEffort: entry.reasoningEffort ?? '',
    toolTimeoutSeconds: entry.toolTimeoutMs === undefined ? '' : msToSeconds(entry.toolTimeoutMs),
    allowTools: entry.tools.allow.join(', '),
    denyTools: entry.tools.deny.join(', '),
    approveExec: entry.approvals?.exec ?? '',
    approveNetwork: entry.approvals?.network ?? '',
    approveWrite: entry.approvals?.write ?? '',
  };
}

export type AgentPatchResult =
  | { readonly ok: true; readonly patch: ConfigPatch }
  | { readonly ok: false; readonly errors: Readonly<Record<string, string>> };

/** `a, b , ,c` → `['a','b','c']`. Empty entries dropped, order kept. */
export function parseToolList(value: string): string[] {
  return value
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '');
}

function isReasoningEffort(value: string): value is ReasoningEffort {
  return (REASONING_EFFORTS as readonly string[]).includes(value);
}

function isPolicy(value: string): value is 'allow' | 'ask' | 'deny' {
  return APPROVAL_POLICIES.includes(value);
}

/**
 * One agent's form into a patch under `agents.list.<id>`.
 *
 * Every numeric field is checked and *all* failures are returned rather than
 * the first, matching `toAgentPatch`: a form that reports one error per press
 * makes the operator find them one press at a time.
 *
 * An empty numeric box is not an error — it is the inherit case, and is simply
 * left out of the patch.
 */
export function toAgentEntryPatch(id: string, form: AgentEntryForm): AgentPatchResult {
  const errors: Record<string, string> = {};

  if (id.trim() === '') errors.id = 'Required';

  /** Parses only when the box has something in it. */
  const optional = (
    field: string,
    value: string,
    options: Parameters<typeof parseNumber>[1],
  ): number | undefined => {
    if (value.trim() === '') return undefined;
    const result = parseNumber(value, options);
    if (!result.ok) {
      errors[field] = result.error;
      return undefined;
    }
    return result.value;
  };

  const maxTokens = optional('maxTokens', form.maxTokens, { integer: true, min: 1 });
  const contextWindowTokens = optional('contextWindowTokens', form.contextWindowTokens, {
    integer: true,
    min: 1,
  });
  const temperature = optional('temperature', form.temperature, { min: 0, max: 2 });
  const toolTimeout = optional('toolTimeoutSeconds', form.toolTimeoutSeconds, { min: 0 });

  if (Object.keys(errors).length > 0) return { ok: false, errors };

  const approvals = {
    ...(isPolicy(form.approveExec) ? { exec: form.approveExec } : {}),
    ...(isPolicy(form.approveNetwork) ? { network: form.approveNetwork } : {}),
    ...(isPolicy(form.approveWrite) ? { write: form.approveWrite } : {}),
  };

  return {
    ok: true,
    patch: {
      agents: {
        list: {
          [id]: {
            label: form.label.trim(),
            systemPrompt: form.systemPrompt,
            enabled: form.enabled,
            // Omitted when empty rather than sent as `''`: an absent override
            // is what inheriting looks like in the stored config. `provider`
            // could not be sent empty in any case — the schema requires one
            // character, because `auto` is the value that means "resolve".
            ...(form.provider.trim() === '' ? {} : { provider: form.provider.trim() }),
            ...(form.model.trim() === '' ? {} : { model: form.model.trim() }),
            tools: { allow: parseToolList(form.allowTools), deny: parseToolList(form.denyTools) },
            ...(maxTokens === undefined ? {} : { maxTokens }),
            ...(contextWindowTokens === undefined ? {} : { contextWindowTokens }),
            ...(temperature === undefined ? {} : { temperature }),
            ...(toolTimeout === undefined ? {} : { toolTimeoutMs: secondsToMs(toolTimeout) }),
            ...(isReasoningEffort(form.reasoningEffort)
              ? { reasoningEffort: form.reasoningEffort }
              : {}),
            ...(Object.keys(approvals).length === 0 ? {} : { approvals }),
          },
        },
      },
    },
  };
}

/**
 * The default agent, which is two things at once.
 *
 * Its model and budget are `agents.defaults` — the values every other agent
 * inherits — while its prompt, tools and permissions are its own entry under
 * `agents.list.default`. That split is why editing it produces one patch
 * touching both, and it is the reason there is no separate "Agent" panel in
 * Settings any more: there was never a second thing to configure, only the
 * default agent described in another room.
 *
 * The entry half deliberately carries no model or budget overrides. Its boxes
 * are not rendered for the default agent, so they arrive blank, and blank means
 * absent — which leaves it inheriting the `agents.defaults` this same patch is
 * setting. An override here would pin the default agent against its own
 * defaults, which is a contradiction rather than a setting.
 */
export function toDefaultAgentPatch(defaults: AgentForm, entry: AgentEntryForm): AgentPatchResult {
  const base = toAgentPatch(defaults);
  const own = toAgentEntryPatch(DEFAULT_AGENT_ID, entry);

  if (!base.ok || !own.ok) {
    return {
      ok: false,
      errors: { ...(base.ok ? {} : base.errors), ...(own.ok ? {} : own.errors) },
    };
  }

  return {
    ok: true,
    patch: {
      agents: {
        ...base.patch.agents,
        ...own.patch.agents,
      },
    },
  };
}

/**
 * A new agent, started from the default one.
 *
 * The default agent is the template, and *which* of its settings are copied is
 * the whole decision. Only the fields an agent owns — the prompt, the tool
 * selection, the approval and exec overrides, the sandbox, the memory scope.
 * The `AgentDefaults` half is deliberately left unset, because those fields are
 * already inherited from `agents.defaults`: copying them would pin the new
 * agent to today's model and temperature and silently stop it following a later
 * change to the defaults, which is the opposite of what inheritance is for.
 *
 * So a new agent starts as a copy of how the default *behaves* and keeps
 * following it on what it *runs on*.
 */
export function toNewAgentPatch(id: string, label: string, template: AgentEntry): ConfigPatch {
  return {
    agents: {
      list: {
        [id]: {
          label,
          enabled: true,
          systemPrompt: template.systemPrompt,
          tools: { allow: [...template.tools.allow], deny: [...template.tools.deny] },
          sandbox: { ...template.sandbox },
          memory: { ...template.memory },
          ...(template.approvals === undefined ? {} : { approvals: { ...template.approvals } }),
          ...(template.exec === undefined ? {} : { exec: { ...template.exec } }),
        },
      },
    },
  };
}

/**
 * Changing an agent's display name and nothing else.
 *
 * **The whole entry goes back, not just the label**, and that is not
 * belt-and-braces — `agents.list.*` is in the merge's `REPLACE_WHOLESALE` list,
 * so the patch *is* the agent and every field left out of it is a field
 * deleted. A rename that sent `{ label }` alone would quietly clear the agent's
 * prompt, its tool selection, its approval overrides and any model it had
 * pinned. The id is untouched, so every conversation bound to this agent keeps
 * resolving.
 */
export function toRenameAgentPatch(id: string, label: string, entry: AgentEntry): ConfigPatch {
  return { agents: { list: { [id]: { ...entry, label: label.trim() } } } };
}

/**
 * The patch that removes an agent.
 *
 * `null` is the one token the merge reads as a deletion, and only at the paths
 * in its `DELETE_BY_NULL` list — of which `agents.list.*` is one.
 */
export function toAgentDeletePatch(id: string): ConfigPatch {
  return { agents: { list: { [id]: null } } };
}
