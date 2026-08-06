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
 * settings this screen does not render (the toolbox, the memory scope, the exec
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

import type { TFunction } from 'i18next';

import {
  DEFAULT_AGENT_ID,
  type AgentDefaults,
  type AgentEntry,
  type ConfigPatch,
  type PromptMode,
  type ReasoningEffort,
  type SubagentRef,
  type ToolPermission,
  type ToolPromptOverride,
} from '@ghostai/protocol';

import {
  msToSeconds,
  parseNumber,
  secondsToMs,
  type PatchResult,
} from '@/components/form/fields.js';

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
export const MODEL_REQUIRED =
  'Choose a model — an agent with none cannot run a turn.';

/** `agents.defaults` — what an install runs as, and what a new agent is seeded from. */
export interface AgentForm {
  readonly provider: string;
  readonly model: string;
  readonly maxTokens: string;
  readonly contextWindowTokens: string;
  readonly temperature: string;
  readonly maxToolIterations: string;
  /**
   * `''` means the provider's own default — see the note above.
   *
   * Which is not `'off'`. Blank sends no reasoning parameter at all; `off`
   * sends one that asks for none. The select shows both, because on a model
   * that thinks unless told otherwise they are different turns.
   */
  readonly reasoningEffort: string;
  readonly toolTimeoutSeconds: string;
  readonly loopWallTimeoutSeconds: string;
  readonly visionEnabled: boolean;
  readonly toolsEnabled: boolean;
}

export const REASONING_EFFORTS: readonly ReasoningEffort[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
];

export function toAgentForm(defaults: AgentDefaults): AgentForm {
  return {
    provider: defaults.provider,
    model: defaults.model,
    maxTokens: String(defaults.maxTokens),
    contextWindowTokens: String(defaults.contextWindowTokens),
    temperature:
      defaults.temperature === undefined ? '' : String(defaults.temperature),
    maxToolIterations: String(defaults.maxToolIterations),
    reasoningEffort: defaults.reasoningEffort ?? '',
    toolTimeoutSeconds: msToSeconds(defaults.toolTimeoutMs),
    loopWallTimeoutSeconds: msToSeconds(defaults.loopWallTimeoutMs),
    visionEnabled: defaults.visionEnabled,
    toolsEnabled: defaults.toolsEnabled,
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
export function toAgentPatch(form: AgentForm, t: TFunction): PatchResult {
  const errors: Record<string, string> = {};

  const maxTokens = parseNumber(form.maxTokens, t, { integer: true, min: 1 });
  const contextWindowTokens = parseNumber(form.contextWindowTokens, t, {
    integer: true,
    min: 1,
  });
  // Blank is a value here, not a mistake: it means "send no temperature and
  // let the provider apply its own", which is the only thing that works for a
  // model that rejects the parameter.
  const temperature =
    form.temperature.trim() === ''
      ? undefined
      : parseNumber(form.temperature, t, { min: 0, max: 2 });
  const maxToolIterations = parseNumber(form.maxToolIterations, t, {
    integer: true,
    min: 1,
  });
  const toolTimeout = parseNumber(form.toolTimeoutSeconds, t, { min: 0 });
  const loopWallTimeout = parseNumber(form.loopWallTimeoutSeconds, t, {
    min: 0,
  });

  const collect = (
    field: string,
    result: ReturnType<typeof parseNumber>,
  ): void => {
    if (!result.ok) errors[field] = result.error;
  };
  collect('maxTokens', maxTokens);
  collect('contextWindowTokens', contextWindowTokens);
  if (temperature !== undefined) collect('temperature', temperature);
  collect('maxToolIterations', maxToolIterations);
  collect('toolTimeoutSeconds', toolTimeout);
  collect('loopWallTimeoutSeconds', loopWallTimeout);

  if (form.provider.trim() === '') errors.provider = 'Required';
  // An empty model is not "resolve one for me" — see `MODEL_REQUIRED`.
  if (form.model.trim() === '') errors.model = MODEL_REQUIRED;

  if (
    !maxTokens.ok ||
    !contextWindowTokens.ok ||
    !maxToolIterations.ok ||
    !toolTimeout.ok ||
    !loopWallTimeout.ok ||
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
          visionEnabled: form.visionEnabled,
          toolsEnabled: form.toolsEnabled,
          // `null` when blank rather than omitted, and that is the whole of
          // being able to clear these two. `agents.defaults` merges per field,
          // so an omitted key preserves what is stored — emptying the
          // temperature box used to send a patch that never mentioned it, and
          // the old value came straight back on the next load. `null` is the
          // token `DELETE_BY_NULL` reads as "remove this key".
          temperature: temperature?.ok === true ? temperature.value : null,
          reasoningEffort: isReasoningEffort(form.reasoningEffort)
            ? form.reasoningEffort
            : null,
        },
      },
    },
  };
}

export interface AgentEntryForm {
  readonly label: string;
  readonly systemPrompt: string;
  /**
   * The seven other templates an agent owns, and the mode that decides whether
   * any of them are placed.
   *
   * Held raw, unlike almost everything else on this form: `''` and `' '` mean
   * different things — inherit the built-in, and delete the section — so a
   * trim anywhere on the way through would make deleting one impossible to
   * express. `systemPrompt` above has always been raw for the same reason.
   *
   * `memoryPrompt` and `skillsPrompt` are the odd ones out in *where they are
   * placed* rather than in how they are held: the other five fill sections the
   * prompt builder writes, while those two are contributors'. They are edited
   * beside the rest because an operator editing their prompt does not care which
   * of the two wrote a paragraph.
   */
  readonly livePrompt: string;
  readonly wrapUpPrompt: string;
  readonly platformPrompt: string;
  readonly toolboxPrompt: string;
  readonly toolPolicyPrompt: string;
  readonly memoryPrompt: string;
  readonly skillsPrompt: string;
  readonly promptMode: string;
  /**
   * Tool name → the operator's replacement for what it tells the model.
   *
   * The stored shape, for the reason `tools` below is: every value is free text
   * behind a labelled box, and there is nothing for a parse step to do.
   */
  readonly toolPrompts: Readonly<Record<string, ToolPromptOverride>>;
  readonly enabled: boolean;
  readonly provider: string;
  /** Empty asks the registry to resolve one — a value, not an absence. */
  readonly model: string;
  readonly maxTokens: string;
  readonly contextWindowTokens: string;
  /** Empty sends no temperature at all, so the provider applies its own. */
  readonly temperature: string;
  readonly reasoningEffort: string;
  /**
   * The two capability switches, per agent for the reason `model` above is: an
   * agent that pins its own model needs its own answer about what that model
   * can do.
   *
   * `toolsEnabled` is not `tools` below and does not overlap it. That one is
   * which tools this agent may use; this one is whether the model is told about
   * any of them. Switching it off leaves the permission map exactly as it is,
   * so moving the agent back to a capable model restores its toolset intact.
   */
  readonly visionEnabled: boolean;
  readonly toolsEnabled: boolean;
  readonly toolTimeoutSeconds: string;
  /**
   * What this agent's memory index may cost in the prompt.
   *
   * Per agent for the reason the budget above is: an agent on a small window
   * cannot afford to be told about as many memories as one on a large one.
   * Whether it remembers *at all* is not here — that is the `memory` tool's
   * permission in `tools` below, and a second switch beside it is how the two
   * come to disagree.
   */
  /**
   * Tool name → permission. A name absent from the map is not enabled.
   *
   * Held as the stored shape rather than as text, unlike the CIDR list below:
   * this is a set of choices from a fixed vocabulary, and the editor renders one
   * control per entry. There is nothing to parse and nothing a typo can express.
   */
  readonly tools: Readonly<Record<string, ToolPermission>>;
  /**
   * The agents this one may delegate to, in the operator's order.
   *
   * The stored shape rather than a form-shaped copy of it, for the reason
   * `tools` above is: an id and a permission both come from a fixed vocabulary
   * behind a picker, and the guidance is free text that needs no parsing. A row
   * whose `id` is still empty is one the operator added and has not filled in;
   * `ownFields` drops those rather than sending an id nothing resolves.
   */
  readonly subagents: readonly SubagentRef[];
  /** A toolbox name, or empty to run commands on this machine. */
  readonly toolboxName: string;
  readonly toolboxNetworkMode: string;
  /** Comma-separated CIDR blocks. Only read when the mode is `allowlist`. */
  readonly toolboxAllow: string;
}

/**
 * The three permissions, in the order the select offers them.
 *
 * Widest first, because that is the order the consequences run in and a picker
 * that reads `deny, allow, ask` makes the operator work out the ordering
 * themselves every time they open it.
 */
export const TOOL_PERMISSIONS: readonly ToolPermission[] = [
  'allow',
  'ask',
  'deny',
];

/**
 * One agent's stored settings, with the defaults filled in where it stored none.
 *
 * The fallback is the whole of "nothing inherits on this screen": an agent that
 * predates the change — or one written by hand — has most of these fields
 * absent, and rendering them as empty boxes would show an operator nothing
 * about what the agent actually runs on. They arrive as the values a turn would
 * use, and the first save writes them down.
 */
export function toAgentEntryForm(
  entry: AgentEntry,
  defaults: AgentDefaults,
): AgentEntryForm {
  const temperature = entry.temperature ?? defaults.temperature;
  const toolTimeoutMs = entry.toolTimeoutMs ?? defaults.toolTimeoutMs;

  return {
    label: entry.label,
    systemPrompt: entry.systemPrompt,
    // No fallback to a default, unlike the model and budget above: empty is a
    // meaningful stored value here — it is what "follow the built-in and keep
    // receiving improvements to it" is spelled as — so filling it in would
    // freeze every agent on today's wording the first time anything was saved.
    livePrompt: entry.livePrompt,
    wrapUpPrompt: entry.wrapUpPrompt,
    platformPrompt: entry.platformPrompt,
    toolboxPrompt: entry.toolboxPrompt,
    toolPolicyPrompt: entry.toolPolicyPrompt,
    memoryPrompt: entry.memoryPrompt,
    skillsPrompt: entry.skillsPrompt,
    promptMode: entry.promptMode,
    toolPrompts: { ...entry.toolPrompts },
    enabled: entry.enabled,
    provider: entry.provider ?? defaults.provider,
    model: entry.model ?? defaults.model,
    maxTokens: String(entry.maxTokens ?? defaults.maxTokens),
    contextWindowTokens: String(
      entry.contextWindowTokens ?? defaults.contextWindowTokens,
    ),
    // Not `?? ''` on the whole expression: `0` is a temperature, and a falsy
    // check here would render it as "the provider's own".
    temperature: temperature === undefined ? '' : String(temperature),
    reasoningEffort: entry.reasoningEffort ?? defaults.reasoningEffort ?? '',
    visionEnabled: entry.visionEnabled ?? defaults.visionEnabled,
    toolsEnabled: entry.toolsEnabled ?? defaults.toolsEnabled,
    toolTimeoutSeconds: msToSeconds(toolTimeoutMs),
    tools: { ...entry.tools },
    subagents: entry.subagents.map((ref) => ({ ...ref })),
    toolboxName: entry.toolbox.name,
    toolboxNetworkMode: entry.toolbox.network.mode,
    toolboxAllow: entry.toolbox.network.allow.join(', '),
  };
}

type AgentPatchResult =
  | { readonly ok: true; readonly patch: ConfigPatch }
  | { readonly ok: false; readonly errors: Readonly<Record<string, string>> };

/** `a, b , ,c` → `['a','b','c']`. Empty entries dropped, order kept. */
export function parseList(value: string): string[] {
  return value
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '');
}

function isReasoningEffort(value: string): value is ReasoningEffort {
  return (REASONING_EFFORTS as readonly string[]).includes(value);
}

export function isToolPermission(value: string): value is ToolPermission {
  return (TOOL_PERMISSIONS as readonly string[]).includes(value);
}

/** The two prompt modes, in the order the toggle offers them. */
const PROMPT_MODES: readonly PromptMode[] = ['template', 'raw'];

function isPromptMode(value: string): value is PromptMode {
  return (PROMPT_MODES as readonly string[]).includes(value);
}

/**
 * The overrides that actually say something.
 *
 * The editor holds a row for every tool an operator has opened, so most of them
 * are empty most of the time. Storing those would fill `config.json` with blank
 * descriptions that are indistinguishable, on the way back in, from a deliberate
 * one — and `''` is precisely the value that means "inherit the built-in", so a
 * stored blank is not merely noise but a lie about what was chosen.
 */
export function pruneToolPrompts(
  overrides: Readonly<Record<string, ToolPromptOverride>>,
): Record<string, ToolPromptOverride> {
  const kept: Record<string, ToolPromptOverride> = {};
  for (const [name, override] of Object.entries(overrides)) {
    const fields = Object.fromEntries(
      Object.entries(override.fields).filter(([, text]) => text !== ''),
    );
    if (override.description === '' && Object.keys(fields).length === 0) {
      continue;
    }
    kept[name] = { description: override.description, fields };
  }
  return kept;
}

/**
 * The half of an agent that is the same whichever agent it is.
 *
 * Its prompt, its name, its tool permissions — plus every setting this screen
 * does not render, carried straight through from the stored entry. That
 * carry-through is not defensive: `agents.list.*` is replaced wholesale, so an
 * entry rebuilt from the form alone loses its sandbox, its memory scope and its
 * exec allow-list every time the prompt is saved.
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
> &
  StatedFields;

/**
 * The fields an entry must state outright rather than inherit.
 *
 * `Required`, rather than a comment saying so. `AgentEntry` is
 * `patchOf(AgentDefaultsSchema)`, so every field on it is optional and an entry
 * that leaves these out follows `agents.defaults` instead. Both default to
 * `true` there, so an omission does not read as "unset" — it reads as "on".
 * That is how Duplicate turned vision back on for the copy: `ownFields` had a
 * comment insisting they are always written, and nothing said it to the other
 * builder. A type says it to both.
 */
type StatedFields = Required<
  Pick<AgentEntry, 'visionEnabled' | 'toolsEnabled'>
>;

function ownFields(form: AgentEntryForm, entry: AgentEntry): AgentOwnFields {
  // Dropped rather than spread: each is either replaced below or, in the case
  // of the model and budget, written by the caller. Leaving a stale one in
  // would make an unset field impossible to express, since omitting a key is
  // the only way this patch format can clear one.
  const {
    provider,
    model,
    maxTokens,
    contextWindowTokens,
    temperature,
    reasoningEffort,
    toolTimeoutMs,
    toolbox,
    subagents,
    ...carried
  } = entry;

  return {
    ...carried,
    label: form.label.trim(),
    systemPrompt: form.systemPrompt,
    // Untrimmed, all eight. A single space is how an operator deletes a
    // section, and it is the only way to say it — empty already means
    // "inherit".
    livePrompt: form.livePrompt,
    wrapUpPrompt: form.wrapUpPrompt,
    platformPrompt: form.platformPrompt,
    toolboxPrompt: form.toolboxPrompt,
    toolPolicyPrompt: form.toolPolicyPrompt,
    memoryPrompt: form.memoryPrompt,
    skillsPrompt: form.skillsPrompt,
    promptMode: isPromptMode(form.promptMode) ? form.promptMode : 'template',
    // Sent whole for the same reason `tools` is: the merge replaces
    // `agents.list.*` wholesale, so this is also the only way an override can be
    // removed. An entry that says nothing is dropped rather than written as a
    // row of empty strings — the editor holds one for every tool with a box on
    // screen, and storing those would fill the config with blanks that read as
    // deliberate.
    toolPrompts: pruneToolPrompts(form.toolPrompts),
    enabled: form.enabled,
    // Always written, never inherited-by-omission. The form arrived holding the
    // default agent's answer, so leaving these out would make the agent follow
    // a later change to the default it had already been shown disagreeing with.
    visionEnabled: form.visionEnabled,
    toolsEnabled: form.toolsEnabled,
    // Sent whole, every time. The merge replaces `agents.list.*` wholesale, so
    // this is also the only way a tool can be removed from an agent — a patch
    // that mentioned only what changed could never express a deletion.
    tools: { ...form.tools },
    // Same rule, and the same reason a removed row has to be expressible.
    // A row with no agent chosen is dropped: the editor adds an empty one when
    // the operator presses Add, and saving before they pick would otherwise be
    // a `config` error from `assertBuildable` about an agent named "".
    subagents: form.subagents
      .filter((ref) => ref.id !== '')
      .map((ref) => ({ ...ref, prompt: ref.prompt.trim() })),
    toolbox: toToolbox(form),
  };
}

/**
 * The toolbox the form describes.
 *
 * Note what is *not* here: an image, a runtime, a capability set. Those live in
 * the profile manifest an operator installed, so this screen can only ever point
 * an agent at one and narrow its network — it cannot widen what the profile
 * permits, and there is no field through which a saved setting could try.
 *
 * The allow-list is dropped unless the mode actually uses it, so switching to
 * `none` and saving does not leave a stale set of CIDRs in the file waiting to
 * take effect the next time somebody switches back.
 */
function toToolbox(form: AgentEntryForm): AgentEntry['toolbox'] {
  const name = form.toolboxName.trim();
  // An agent on the host cannot scope egress — there is no sandbox to enforce it
  // — and `assertBuildable` refuses the combination, so it is not offered.
  const mode = name === '' ? 'none' : networkMode(form.toolboxNetworkMode);
  return {
    name,
    network: {
      mode,
      allow: mode === 'allowlist' ? parseList(form.toolboxAllow) : [],
    },
  };
}

const NETWORK_MODES: ReadonlyArray<AgentEntry['toolbox']['network']['mode']> = [
  'none',
  'allowlist',
  'open',
];

function networkMode(value: string): AgentEntry['toolbox']['network']['mode'] {
  return NETWORK_MODES.find((mode) => mode === value) ?? 'none';
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
  t: TFunction,
): AgentPatchResult {
  const errors: Record<string, string> = {};

  if (id.trim() === '') errors.id = 'Required';
  if (form.provider.trim() === '') errors.provider = 'Required';
  if (form.model.trim() === '') errors.model = MODEL_REQUIRED;

  const required = (
    field: string,
    value: string,
    options: Parameters<typeof parseNumber>[2],
  ): number | undefined => {
    const result = parseNumber(value, t, options);
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
    options: Parameters<typeof parseNumber>[2],
  ): number | undefined => {
    if (value.trim() === '') return undefined;
    return required(field, value, options);
  };

  const maxTokens = required('maxTokens', form.maxTokens, {
    integer: true,
    min: 1,
  });
  const contextWindowTokens = required(
    'contextWindowTokens',
    form.contextWindowTokens,
    {
      integer: true,
      min: 1,
    },
  );
  const toolTimeout = required('toolTimeoutSeconds', form.toolTimeoutSeconds, {
    min: 0,
  });
  const temperature = optional('temperature', form.temperature, {
    min: 0,
    max: 2,
  });

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
  t: TFunction,
): AgentPatchResult {
  const base = toAgentPatch(defaults, t);
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
 * Everything is copied: the prompt, the tool permissions, the sandbox, the
 * memory scope — *and* the model and the budget, which used to be
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
          // Every template the source agent had, for the same reason its prompt
          // is copied: a duplicate that reverted to the built-in platform note
          // would not be a copy of the agent it was stamped from.
          livePrompt: template.livePrompt,
          wrapUpPrompt: template.wrapUpPrompt,
          platformPrompt: template.platformPrompt,
          toolboxPrompt: template.toolboxPrompt,
          toolPolicyPrompt: template.toolPolicyPrompt,
          memoryPrompt: template.memoryPrompt,
          skillsPrompt: template.skillsPrompt,
          promptMode: template.promptMode,
          toolPrompts: structuredClone(template.toolPrompts),
          tools: { ...template.tools },
          // Written, not left to inheritance — the same rule `ownFields` states
          // for the editor's save, and for the same reason. Omitting them makes
          // the copy follow `agents.defaults`, so duplicating an agent with
          // vision switched off produced one with vision switched on.
          visionEnabled: template.visionEnabled ?? defaults.visionEnabled,
          toolsEnabled: template.toolsEnabled ?? defaults.toolsEnabled,
          // The one thing deliberately *not* copied. Everything else here is a
          // setting — how the agent thinks, what it may touch, what it costs —
          // and inheriting those is what "a copy of the default agent" means.
          // Delegation is not a setting but a relationship: it says this agent's
          // job is partly somebody else's, which is specific to the job and not
          // to the template it was stamped from.
          //
          // It also compounds. A prompt copied into an agent that did not want
          // it is one wrong sentence; a delegation copied into every agent
          // created afterwards puts a tool in front of each of them, and the
          // model will use it.
          subagents: [],
          toolbox: { ...template.toolbox },
          provider: template.provider ?? defaults.provider,
          model: template.model ?? defaults.model,
          maxTokens: template.maxTokens ?? defaults.maxTokens,
          contextWindowTokens:
            template.contextWindowTokens ?? defaults.contextWindowTokens,
          toolTimeoutMs: template.toolTimeoutMs ?? defaults.toolTimeoutMs,
          ...(temperature === undefined ? {} : { temperature }),
          ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
          ...(template.exec === undefined
            ? {}
            : { exec: { ...template.exec } }),
          // `satisfies`, so leaving out a stated field is a compile error here
          // as well as in `ownFields`. The two builders write the same entry
          // from different sources — a form and a stored template — which is
          // exactly how they came to disagree.
        } satisfies AgentEntry & StatedFields,
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
export function toAgentEnabledPatch(
  id: string,
  entry: AgentEntry,
  enabled: boolean,
): ConfigPatch {
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
