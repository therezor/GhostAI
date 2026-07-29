/**
 * The `agents.defaults` half of the agent form, without the screen.
 *
 * The round trip is the case worth having: config → form → patch has to leave
 * every value where it was. A settings screen that shifts a value simply by
 * being opened and saved is the worst kind of bug on this surface, because the
 * operator's own action is what caused it and nothing they typed is wrong.
 */

import { AgentDefaultsSchema, ConfigPatchSchema, type AgentDefaults } from '@ghostai/protocol';
import { describe, expect, it } from 'vitest';

import { MODEL_REQUIRED, toAgentForm, toAgentPatch } from './agents-form.js';

/**
 * A model is set unless a case is about not having one.
 *
 * `AgentDefaultsSchema` defaults it to `''`, which is the unconfigured install
 * rather than a setting — the runtime turns an empty model into `noModelError`
 * — and the form now refuses to save one. A fixture without a model would make
 * every case here fail on a field it is not about.
 */
const defaults = (overrides: Partial<AgentDefaults> = {}): AgentDefaults =>
  AgentDefaultsSchema.parse({ model: 'llama3', ...overrides });

describe('toAgentForm', () => {
  it('renders every value as the string an input holds', () => {
    const form = toAgentForm(defaults({ model: 'gpt-5', toolTimeoutMs: 30_000 }));

    expect(form.model).toBe('gpt-5');
    expect(form.maxTokens).toBe('8192');
    expect(form.toolTimeoutSeconds).toBe('30');
    expect(form.learningEnabled).toBe(true);
  });

  it('shows an unset reasoning effort as empty rather than inventing one', () => {
    expect(toAgentForm(defaults()).reasoningEffort).toBe('');
  });
});

describe('toAgentPatch', () => {
  it('round-trips the config it was built from', () => {
    const config = defaults({
      provider: 'ollama',
      model: 'llama3',
      temperature: 0.7,
      toolTimeoutMs: 1500,
      loopWallTimeoutMs: 0,
    });

    const result = toAgentPatch(toAgentForm(config));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.patch.agents?.defaults).toMatchObject({
      provider: 'ollama',
      model: 'llama3',
      temperature: 0.7,
      // The one that would drift if seconds were rounded on the way out.
      toolTimeoutMs: 1500,
      loopWallTimeoutMs: 0,
    });
  });

  it('never mentions the workspace directory, so a save cannot move the sandbox', () => {
    // The browser has no control for the agent's filesystem root, and this is
    // the assertion that keeps it that way. `agents.defaults` merges per field,
    // so an omitted key preserves what the config file or `--workspace` set —
    // but a form that still emitted `workspace: ''` would look correct in a
    // diff and would reset a configured root on every unrelated save.
    const result = toAgentPatch(toAgentForm(defaults({ workspace: '/tmp/w' })));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.patch.agents?.defaults).not.toHaveProperty('workspace');
  });

  it('patches only the agent subtree, so the other panels are untouched', () => {
    const result = toAgentPatch(toAgentForm(defaults()));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(Object.keys(result.patch)).toEqual(['agents']);
  });

  it('reports every bad field at once, not the first one', () => {
    const result = toAgentPatch({
      ...toAgentForm(defaults()),
      maxTokens: '',
      temperature: '9',
      learningInterval: 'x',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.errors).toEqual({
      maxTokens: 'Required',
      temperature: 'Must be at most 2',
      learningInterval: 'Must be a number',
    });
  });

  it('refuses an empty provider, which would resolve to nothing', () => {
    const result = toAgentPatch({ ...toAgentForm(defaults()), provider: '  ' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.provider).toBe('Required');
  });

  it('refuses an empty model, which leaves the whole install unconfigured', () => {
    // The provider half of `agents.defaults` really is resolved from whichever
    // instance has credentials. The model half never is — `runtime.configured`
    // goes false and every turn is refused with `No model configured`.
    const result = toAgentPatch({ ...toAgentForm(defaults()), model: '  ' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.model).toBe(MODEL_REQUIRED);
  });

  it('sends null for an unset reasoning effort, which is what clears it', () => {
    // Omitting it was the bug: `agents.defaults` merges per field, so a patch
    // that never mentions the key preserves whatever is stored. `null` is the
    // token `DELETE_BY_NULL` reads as a removal.
    const result = toAgentPatch({ ...toAgentForm(defaults()), reasoningEffort: '' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.patch.agents?.defaults?.reasoningEffort).toBeNull();
  });

  it('sends null for an emptied temperature, so removing one takes effect', () => {
    // The reported symptom: clearing the box, saving, reloading, and finding
    // 0.1 still there — the save had gone out without mentioning the field.
    const result = toAgentPatch({
      ...toAgentForm(defaults({ temperature: 0.1 })),
      temperature: '',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.patch.agents?.defaults?.temperature).toBeNull();
    expect(ConfigPatchSchema.safeParse(result.patch).success).toBe(true);
  });

  it('still sends a temperature that is set, including zero', () => {
    const result = toAgentPatch({ ...toAgentForm(defaults()), temperature: '0' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.patch.agents?.defaults?.temperature).toBe(0);
  });

  it('sends the reasoning effort when it is one the protocol knows', () => {
    const result = toAgentPatch({ ...toAgentForm(defaults()), reasoningEffort: 'high' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.patch.agents?.defaults?.reasoningEffort).toBe('high');
  });

  it('produces a patch the protocol accepts', () => {
    // Through `ConfigPatchSchema`, which is what the server actually parses,
    // and not through `AgentDefaultsSchema`: the two differ now, because a
    // patch may carry `temperature: null` to clear a field that the config
    // itself can only hold as a number or not at all.
    const result = toAgentPatch(toAgentForm(defaults({ model: 'llama3' })));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(ConfigPatchSchema.safeParse(result.patch).success).toBe(true);
  });
});
