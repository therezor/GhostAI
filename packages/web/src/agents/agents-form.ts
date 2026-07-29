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
 * **Every agent holds its own settings. Nothing on this screen inherits.** The
 * config format still allows an absent field to fall through to
 * `agents.defaults` — that is what makes a hand-written `config.json` short,
 * and `@ghostai/runtime` still resolves it that way — but the editor no longer
 * *expresses* inheritance, because an empty box that silently means "whatever
 * the other screen says" is a setting you cannot read off the screen it is on.
 * So a form opened on an agent that stored nothing is filled from the defaults,
 * and saving writes those values down. A new agent is created the same way:
 * prepopulated from the default agent, then its own from that moment.
 *
 * There are still two form types, because the two subtrees differ in what they
 * are allowed to say:
 *
 *  - `AgentForm` edits `agents.defaults` — what a fresh agent is seeded from,
 *    and what an install with no named agents runs as.
 *  - `AgentEntryForm` edits `agents.list.<id>`.
 *
 * The patch this builds *is* the agent: `agents.list.*` is in the merge's
 * `REPLACE_WHOLESALE` list, so a field left out of it is a field cleared. That
 * is why `toAgentEntryPatch` takes the stored entry as well as the form — the
 * settings this screen does not render (the sandbox, the memory scope, the exec
 * allow-list) have to be carried through by hand, or saving the prompt would
 * quietly delete them.
 *
 * One asymmetry is a property of the patch format rather than of this file.
 * `reasoningEffort` and `temperature` are optional in the config, and the two
 * are genuinely unset rather than defaulted: unset means the request carries no
 * such parameter, which is the only thing that works for a model that rejects
 * it. Wholesale replacement is what lets the form express that — omitting the
 * key *is* clearing it.
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
 * The value the "leave this unset" option carries.
 *
 * Not the empty string, which is what the form holds: an empty `value` means
 * *no* value to a Radix select, so the option would select nothing and the
 * trigger would render blank — a control that looks broken while working.
 */
export const UNSET_VALUE = '__unset__';

/**
 * Why a model is required rather than merely encouraged.
 *
 * The screen used to offer "Resolved automatically" for it, on the reading of
 * `AgentDefaultsSchema`'s "empty means resolve from whichever provider has
 * credentials". That sentence is about the **provider**: `resolveInstance` uses
 * the model as a hint when picking an endpoint. The model itself is never
 * invented — `GhostRuntime` turns an empty one into `noModelError`, hands the
 * loop a `null` provider, and the agent cannot run a turn at all.
 *
 * So the option was offering an unconfigured install as though it were a
 * setting. Blank is now a state the form refuses rather than one it saves.
 */
export const MODEL_REQUIRED = 'Choose a model — an agent with none cannot run a turn.';

/** `agents.defaults` — what an install runs as, and what a new agent is seeded from. */
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
  // An empty model is not "resolve one for me" — see `MODEL_REQUIRED`.
  if (form.model.trim() === '') errors.model = MODEL_REQUIRED;

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
          // `null` when blank rather than omitted, and that is the whole of
          // being able to clear these two. `agents.defaults` merges per field,
          // so an omitted key preserves what is stored — emptying the
          // temperature box used to send a patch that never mentioned it, and
          // the old value came straight back on the next load. `null` is the
          // token `DELETE_BY_NULL` reads as "remove this key".
          temperature: temperature?.ok === true ? temperature.value : null,
          reasoningEffort: isReasoningEffort(form.reasoningEffort) ? form.reasoningEffort : null,
        },
      },
    },
  };
}

export interface AgentEntryForm {
  readonly label: string;
  readonly systemPrompt: string;
  readonly enabled: boolean;
  readonly provider: string;
  /** Empty asks the registry to resolve one — a value, not an absence. */
  readonly model: string;
  readonly maxTokens: string;
  readonly contextWindowTokens: string;
  /** Empty sends no temperature at all, so the provider applies its own. */
  readonly temperature: string;
  readonly reasoningEffort: string;
  readonly toolTimeoutSeconds: string;
  /** Comma-separated tool names. Empty means "everything not denied". */
  readonly allowTools: string;
  readonly denyTools: string;
  /** Risk band → policy, empty leaving the band to the global `tools.approvals`. */
  readonly approveExec: string;
  readonly approveNetwork: string;
  readonly approveWrite: string;
}

export const APPROVAL_POLICIES: readonly string[] = ['allow', 'ask', 'deny'];

/**
 * One agent's stored settings, with the defaults filled in where it stored none.
 *
 * The fallback is the whole of "nothing inherits on this screen": an agent that
 * predates the change — or one written by hand — has most of these fields
 * absent, and rendering them as empty boxes would show an operator nothing
 * about what the agent actually runs on. They arrive as the values a turn would
 * use, and the first save writes them down.
 */
export function toAgentEntryForm(entry: AgentEntry, defaults: AgentDefaults): AgentEntryForm {
  const temperature = entry.temperature ?? defaults.temperature;
  const toolTimeoutMs = entry.toolTimeoutMs ?? defaults.toolTimeoutMs;

  return {
    label: entry.label,
    systemPrompt: entry.systemPrompt,
    enabled: entry.enabled,
    provider: entry.provider ?? defaults.provider,
    model: entry.model ?? defaults.model,
    maxTokens: String(entry.maxTokens ?? defaults.maxTokens),
    contextWindowTokens: String(entry.contextWindowTokens ?? defaults.contextWindowTokens),
    // Not `?? ''` on the whole expression: `0` is a temperature, and a falsy
    // check here would render it as "the provider's own".
    temperature: temperature === undefined ? '' : String(temperature),
    reasoningEffort: entry.reasoningEffort ?? defaults.reasoningEffort ?? '',
    toolTimeoutSeconds: msToSeconds(toolTimeoutMs),
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
 * The half of an agent that is the same whichever agent it is.
 *
 * Its prompt, its name, its tool selection, its approval bands — plus every
 * setting this screen does not render, carried straight through from the stored
 * entry. That carry-through is not defensive: `agents.list.*` is replaced
 * wholesale, so an entry rebuilt from the form alone loses its sandbox, its
 * memory scope and its exec allow-list every time the prompt is saved.
 *
 * The model and the budget are deliberately *not* here. They differ between the
 * default agent — whose are `agents.defaults` — and every other, so they are
 * added by the caller that knows which subtree it is writing.
 */
type AgentOwnFields = Omit<
  AgentEntry,
  | 'provider'
  | 'model'
  | 'maxTokens'
  | 'contextWindowTokens'
  | 'temperature'
  | 'reasoningEffort'
  | 'toolTimeoutMs'
>;

function ownFields(form: AgentEntryForm, entry: AgentEntry): AgentOwnFields {
  // Dropped rather than spread: each is either replaced below or, in the case
  // of the model and budget, written by the caller. Leaving a stale one in
  // would make an unset field impossible to express, since omitting a key is
  // the only way this patch format can clear one.
  const {
    provider: _provider,
    model: _model,
    maxTokens: _maxTokens,
    contextWindowTokens: _contextWindowTokens,
    temperature: _temperature,
    reasoningEffort: _reasoningEffort,
    toolTimeoutMs: _toolTimeoutMs,
    approvals: _approvals,
    ...carried
  } = entry;

  const approvals = {
    ...(isPolicy(form.approveExec) ? { exec: form.approveExec } : {}),
    ...(isPolicy(form.approveNetwork) ? { network: form.approveNetwork } : {}),
    ...(isPolicy(form.approveWrite) ? { write: form.approveWrite } : {}),
  };

  return {
    ...carried,
    label: form.label.trim(),
    systemPrompt: form.systemPrompt,
    enabled: form.enabled,
    tools: { allow: parseToolList(form.allowTools), deny: parseToolList(form.denyTools) },
    ...(Object.keys(approvals).length === 0 ? {} : { approvals }),
  };
}

/**
 * One agent's form into a patch under `agents.list.<id>`.
 *
 * Every numeric field is checked and *all* failures are returned rather than
 * the first, matching `toAgentPatch`: a form that reports one error per press
 * makes the operator find them one press at a time.
 *
 * An empty box is an error for the fields that must have a value, because they
 * no longer have anywhere to fall back to — the form arrives holding the
 * default agent's numbers, so a blank one is something the operator deleted
 * rather than something they never set. The two that *can* be unset,
 * `temperature` and `reasoningEffort`, are left out of the patch when blank,
 * which is what clears them.
 */
export function toAgentEntryPatch(
  id: string,
  form: AgentEntryForm,
  entry: AgentEntry,
): AgentPatchResult {
  const errors: Record<string, string> = {};

  if (id.trim() === '') errors.id = 'Required';
  if (form.provider.trim() === '') errors.provider = 'Required';
  if (form.model.trim() === '') errors.model = MODEL_REQUIRED;

  const required = (
    field: string,
    value: string,
    options: Parameters<typeof parseNumber>[1],
  ): number | undefined => {
    const result = parseNumber(value, options);
    if (!result.ok) {
      errors[field] = result.error;
      return undefined;
    }
    return result.value;
  };

  /** Parses only when the box has something in it — blank is a value here. */
  const optional = (
    field: string,
    value: string,
    options: Parameters<typeof parseNumber>[1],
  ): number | undefined => {
    if (value.trim() === '') return undefined;
    return required(field, value, options);
  };

  const maxTokens = required('maxTokens', form.maxTokens, { integer: true, min: 1 });
  const contextWindowTokens = required('contextWindowTokens', form.contextWindowTokens, {
    integer: true,
    min: 1,
  });
  const toolTimeout = required('toolTimeoutSeconds', form.toolTimeoutSeconds, { min: 0 });
  const temperature = optional('temperature', form.temperature, { min: 0, max: 2 });

  if (
    maxTokens === undefined ||
    contextWindowTokens === undefined ||
    toolTimeout === undefined ||
    Object.keys(errors).length > 0
  ) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    patch: {
      agents: {
        list: {
          [id]: {
            ...ownFields(form, entry),
            provider: form.provider.trim(),
            model: form.model.trim(),
            maxTokens,
            contextWindowTokens,
            toolTimeoutMs: secondsToMs(toolTimeout),
            ...(temperature === undefined ? {} : { temperature }),
            ...(isReasoningEffort(form.reasoningEffort)
              ? { reasoningEffort: form.reasoningEffort }
              : {}),
          },
        },
      },
    },
  };
}

/**
 * The default agent, which is two things at once.
 *
 * Its model and budget are `agents.defaults` — the values a new agent is seeded
 * from, and what an install with no named agents runs as — while its prompt,
 * tools and permissions are its own entry under `agents.list.default`. That
 * split is why editing it produces one patch touching both, and it is the
 * reason there is no separate "Agent" panel in Settings any more: there was
 * never a second thing to configure, only the default agent described in
 * another room.
 *
 * The entry half carries no model or budget, and `ownFields` is what makes that
 * structural rather than a matter of which boxes happened to be blank. Writing
 * one here would pin the default agent against its own defaults, which is a
 * contradiction rather than a setting.
 */
export function toDefaultAgentPatch(
  defaults: AgentForm,
  form: AgentEntryForm,
  entry: AgentEntry,
): AgentPatchResult {
  const base = toAgentPatch(defaults);
  if (!base.ok) return { ok: false, errors: base.errors };

  return {
    ok: true,
    patch: {
      agents: {
        ...base.patch.agents,
        list: { [DEFAULT_AGENT_ID]: ownFields(form, entry) },
      },
    },
  };
}

/**
 * A new agent, prepopulated from the one it was started from.
 *
 * Everything is copied: the prompt, the tool selection, the approvals, the
 * sandbox, the memory scope — *and* the model and the budget, which used to be
 * left out so the new agent would keep inheriting them. It no longer inherits
 * anything, so leaving them out would produce an agent whose model the editor
 * had to describe as somebody else's.
 *
 * The template is an `agents.list` entry, and the default agent's has no model
 * or budget in it — those live in `agents.defaults`. Hence the `??`: whichever
 * agent is being copied, what lands here is what a turn on it would actually
 * have used.
 */
export function toNewAgentPatch(
  id: string,
  label: string,
  template: AgentEntry,
  defaults: AgentDefaults,
): ConfigPatch {
  const temperature = template.temperature ?? defaults.temperature;
  const reasoningEffort = template.reasoningEffort ?? defaults.reasoningEffort;

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
          provider: template.provider ?? defaults.provider,
          model: template.model ?? defaults.model,
          maxTokens: template.maxTokens ?? defaults.maxTokens,
          contextWindowTokens: template.contextWindowTokens ?? defaults.contextWindowTokens,
          toolTimeoutMs: template.toolTimeoutMs ?? defaults.toolTimeoutMs,
          ...(temperature === undefined ? {} : { temperature }),
          ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
          ...(template.approvals === undefined ? {} : { approvals: { ...template.approvals } }),
          ...(template.exec === undefined ? {} : { exec: { ...template.exec } }),
        },
      },
    },
  };
}

/**
 * Switching an agent on or off from the list, without opening it.
 *
 * The whole entry goes back for the same reason a rename sends one: the merge
 * replaces `agents.list.*` wholesale, so `{ enabled: false }` alone would
 * disable the agent by deleting everything else about it.
 *
 * A disabled agent is kept rather than removed — `listAgents` skips it and
 * `resolveAgent` refuses it, but its prompt and permissions are still there
 * when it is switched back on. That is the difference between this and Delete,
 * and it is why both are in the row menu.
 */
export function toAgentEnabledPatch(id: string, entry: AgentEntry, enabled: boolean): ConfigPatch {
  return { agents: { list: { [id]: { ...entry, enabled } } } };
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
