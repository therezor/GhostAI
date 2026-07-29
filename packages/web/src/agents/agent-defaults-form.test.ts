/**
 * The `agents.defaults` half of the agent form, without the screen.
 *
 * The round trip is the case worth having: config → form → patch has to leave
 * every value where it was. A settings screen that shifts a value simply by
 * being opened and saved is the worst kind of bug on this surface, because the
 * operator's own action is what caused it and nothing they typed is wrong.
 */

import { AgentDefaultsSchema, type AgentDefaults } from '@ghostai/protocol';
import { describe, expect, it } from 'vitest';

import { toAgentForm, toAgentPatch } from './agents-form.js';

const defaults = (overrides: Partial<AgentDefaults> = {}): AgentDefaults =>
  AgentDefaultsSchema.parse(overrides);

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

  it('omits the reasoning effort when it is unset, rather than sending a blank', () => {
    const result = toAgentPatch({ ...toAgentForm(defaults()), reasoningEffort: '' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.patch.agents?.defaults).not.toHaveProperty('reasoningEffort');
  });

  it('sends the reasoning effort when it is one the protocol knows', () => {
    const result = toAgentPatch({ ...toAgentForm(defaults()), reasoningEffort: 'high' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.patch.agents?.defaults?.reasoningEffort).toBe('high');
  });

  it('produces a patch the protocol accepts', () => {
    // The real guard: the server parses this through `ConfigPatchSchema`, and a
    // field with the wrong name or unit is a 400 rather than a type error.
    const result = toAgentPatch(toAgentForm(defaults({ model: 'llama3' })));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(() => AgentDefaultsSchema.parse(result.patch.agents?.defaults)).not.toThrow();
  });
});
