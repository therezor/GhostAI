/**
 * One provider instance's connection settings.
 *
 * Three properties. An empty `apiBase` has to be *sent*, because that is how it
 * is cleared back to the registry's default; `null` has to reach the wire
 * intact, because it is the only syntax the merge has for a deletion; and no
 * field here may ever be a credential, because the vault is write-only and this
 * patch goes to a route that answers with the settings tree.
 */

import { ConfigPatchSchema, ProviderConfigSchema } from '@ghostai/protocol';
import { describe, expect, it } from 'vitest';

import {
  toCreateProviderPatch,
  toDeleteProviderPatch,
  toProviderForm,
  toProviderPatch,
} from './provider-form.js';

describe('toProviderForm', () => {
  it('reads a configured instance', () => {
    const form = toProviderForm(
      ProviderConfigSchema.parse({
        type: 'ollama',
        label: 'GPU box',
        apiBase: 'http://127.0.0.1:11434/v1',
        models: ['a', 'b'],
      }),
    );

    expect(form.label).toBe('GPU box');
    expect(form.apiBase).toBe('http://127.0.0.1:11434/v1');
    expect(form.models).toBe('a\nb');
    expect(form.enabled).toBe(true);
  });

  it('reads an instance the config has no block for', () => {
    // The panel renders from the providers response, which can list an instance
    // a moment before the settings query catches up.
    expect(toProviderForm(undefined)).toEqual({
      label: '',
      apiBase: '',
      models: '',
      enabled: true,
    });
  });
});

describe('toProviderPatch', () => {
  it('patches only the one instance it was given', () => {
    const patch = toProviderPatch('ollama-gpu', {
      label: 'GPU box',
      apiBase: 'http://h/v1',
      models: 'a, b',
      enabled: true,
    });

    expect(patch).toEqual({
      providers: {
        'ollama-gpu': {
          label: 'GPU box',
          apiBase: 'http://h/v1',
          models: ['a', 'b'],
          enabled: true,
        },
      },
    });
    expect(() => ConfigPatchSchema.parse(patch)).not.toThrow();
  });

  it('never carries the type, so an endpoint cannot change protocol by being edited', () => {
    const patch = toProviderPatch('openai', {
      label: '',
      apiBase: 'http://h/v1',
      models: '',
      enabled: true,
    });
    expect(patch.providers?.openai).not.toHaveProperty('type');
  });

  it('sends an empty base URL rather than omitting it, so the field can be cleared', () => {
    // Omitting it would mean "leave whatever is there", and the operator who
    // just emptied the field would find the old endpoint back on reload.
    const patch = toProviderPatch('openai', {
      label: '',
      apiBase: '   ',
      models: '',
      enabled: true,
    });
    expect(patch.providers?.openai).toMatchObject({ apiBase: '', models: [] });
  });

  it('never carries a credential', () => {
    const patch = toProviderPatch('openai', {
      label: '',
      apiBase: 'http://h/v1',
      models: 'a',
      enabled: true,
    });
    expect(JSON.stringify(patch)).not.toMatch(/key|secret|token/i);
  });
});

describe('toCreateProviderPatch', () => {
  it('names the type, which is the one patch that may', () => {
    const patch = toCreateProviderPatch('ollama-2', 'ollama', '  GPU box  ');

    expect(patch).toEqual({
      providers: { 'ollama-2': { type: 'ollama', label: 'GPU box', enabled: true } },
    });
    expect(() => ConfigPatchSchema.parse(patch)).not.toThrow();
  });
});

describe('toDeleteProviderPatch', () => {
  it('sends null, which is what the merge reads as a removal', () => {
    const patch = toDeleteProviderPatch('ollama-2');

    expect(patch).toEqual({ providers: { 'ollama-2': null } });
    // It has to survive validation to reach the merge that honours it.
    expect(() => ConfigPatchSchema.parse(patch)).not.toThrow();
    expect(ConfigPatchSchema.parse(patch).providers?.['ollama-2']).toBeNull();
  });
});
