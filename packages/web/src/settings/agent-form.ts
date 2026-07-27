/**
 * The Agent panel's form, as a pure pair of functions.
 *
 * `toAgentForm` turns the config subtree into strings; `toAgentPatch` turns the
 * strings back into a `ConfigPatch` or into the errors that stopped it. Neither
 * touches React, which is the point: validation is the part of a settings panel
 * that is worth testing and the part a component test can only reach through
 * seven keystrokes and a button press.
 *
 * One asymmetry is deliberate and is a property of the patch format rather than
 * of this file. `reasoningEffort` is optional in the config and a patch has no
 * way to say "remove this key" — an absent field means "not mentioned", never
 * "delete". So the form can set it and cannot unset it, and the panel says so
 * rather than offering a control that silently does nothing.
 */

import type { AgentDefaults, ConfigPatch, ReasoningEffort } from '@ghostai/protocol';

import { msToSeconds, parseNumber, secondsToMs } from './fields.js';

export interface AgentForm {
  readonly provider: string;
  readonly model: string;
  readonly workspace: string;
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
    workspace: defaults.workspace,
    maxTokens: String(defaults.maxTokens),
    contextWindowTokens: String(defaults.contextWindowTokens),
    temperature: String(defaults.temperature),
    maxToolIterations: String(defaults.maxToolIterations),
    reasoningEffort: defaults.reasoningEffort ?? '',
    toolTimeoutSeconds: msToSeconds(defaults.toolTimeoutMs),
    loopWallTimeoutSeconds: msToSeconds(defaults.loopWallTimeoutMs),
    learningEnabled: defaults.learningEnabled,
    learningInterval: String(defaults.learningInterval),
  };
}

export type PatchResult =
  | { readonly ok: true; readonly patch: ConfigPatch }
  | { readonly ok: false; readonly errors: Readonly<Record<string, string>> };

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
  const temperature = parseNumber(form.temperature, { min: 0, max: 2 });
  const maxToolIterations = parseNumber(form.maxToolIterations, { integer: true, min: 1 });
  const toolTimeout = parseNumber(form.toolTimeoutSeconds, { min: 0 });
  const loopWallTimeout = parseNumber(form.loopWallTimeoutSeconds, { min: 0 });
  const learningInterval = parseNumber(form.learningInterval, { integer: true, min: 1 });

  const collect = (field: string, result: ReturnType<typeof parseNumber>): void => {
    if (!result.ok) errors[field] = result.error;
  };
  collect('maxTokens', maxTokens);
  collect('contextWindowTokens', contextWindowTokens);
  collect('temperature', temperature);
  collect('maxToolIterations', maxToolIterations);
  collect('toolTimeoutSeconds', toolTimeout);
  collect('loopWallTimeoutSeconds', loopWallTimeout);
  collect('learningInterval', learningInterval);

  if (form.provider.trim() === '') errors.provider = 'Required';

  if (
    !maxTokens.ok ||
    !contextWindowTokens.ok ||
    !temperature.ok ||
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
          // Trimmed, and empty is meaningful for both: an empty model asks the
          // registry to resolve one, and an empty workspace means `<root>/workspace`.
          model: form.model.trim(),
          workspace: form.workspace.trim(),
          maxTokens: maxTokens.value,
          contextWindowTokens: contextWindowTokens.value,
          temperature: temperature.value,
          maxToolIterations: maxToolIterations.value,
          toolTimeoutMs: secondsToMs(toolTimeout.value),
          loopWallTimeoutMs: secondsToMs(loopWallTimeout.value),
          learningEnabled: form.learningEnabled,
          learningInterval: learningInterval.value,
          ...(isReasoningEffort(form.reasoningEffort)
            ? { reasoningEffort: form.reasoningEffort }
            : {}),
        },
      },
    },
  };
}

function isReasoningEffort(value: string): value is ReasoningEffort {
  return (REASONING_EFFORTS as readonly string[]).includes(value);
}
