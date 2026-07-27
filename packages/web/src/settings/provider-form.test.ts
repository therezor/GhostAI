/**
 * One provider's connection settings.
 *
 * Two properties, and both are about what an *empty* field means. An empty
 * `apiBase` has to be sent, because that is how it is cleared back to the
 * registry's default; and no field here may ever be a credential, because the
 * vault is write-only and this patch goes to a route that answers with the
 * settings tree.
 */

import { ConfigPatchSchema, ProviderConfigSchema } from '@ghostai/protocol';
import { describe, expect, it } from 'vitest';

import { toProviderForm, toProviderPatch } from './provider-form.js';

describe('toProviderForm', () => {
  it('reads a configured provider', () => {
    const form = toProviderForm(
      ProviderConfigSchema.parse({ apiBase: 'http://127.0.0.1:11434/v1', models: ['a', 'b'] }),
    );

    expect(form.apiBase).toBe('http://127.0.0.1:11434/v1');
    expect(form.models).toBe('a\nb');
  });

  it('reads a provider that has never been configured', () => {
    // Every provider in the registry is listed, and most of them have no block
    // in `config.json` at all.
    expect(toProviderForm(undefined)).toEqual({ apiBase: '', models: '' });
  });
});

describe('toProviderPatch', () => {
  it('patches only the one provider it was given', () => {
    const patch = toProviderPatch('ollama', { apiBase: 'http://h/v1', models: 'a, b' });

    expect(patch).toEqual({
      providers: { ollama: { apiBase: 'http://h/v1', models: ['a', 'b'] } },
    });
    expect(() => ConfigPatchSchema.parse(patch)).not.toThrow();
  });

  it('sends an empty base URL rather than omitting it, so the field can be cleared', () => {
    // Omitting it would mean "leave whatever is there", and the operator who
    // just emptied the field would find the old endpoint back on reload.
    const patch = toProviderPatch('openai', { apiBase: '   ', models: '' });
    expect(patch.providers?.openai).toEqual({ apiBase: '', models: [] });
  });

  it('never carries a credential', () => {
    const patch = toProviderPatch('openai', { apiBase: 'http://h/v1', models: 'a' });
    expect(JSON.stringify(patch)).not.toMatch(/key|secret|token/i);
  });
});
