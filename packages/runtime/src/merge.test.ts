import { ConfigSchema } from '@ghostai/protocol';
import { describe, expect, it } from 'vitest';

import { mergeConfigPatch } from './merge.js';

const base = ConfigSchema.parse({});

describe('mergeConfigPatch', () => {
  it('leaves every field the patch does not mention', () => {
    // The whole point of `patchOf` over `.partial()`: saving one settings panel
    // must not rewrite the siblings back to their defaults.
    const merged = mergeConfigPatch(base, { agents: { defaults: { temperature: 0.7 } } });

    expect(merged.agents.defaults.temperature).toBe(0.7);
    expect(merged.agents.defaults.maxTokens).toBe(base.agents.defaults.maxTokens);
    expect(merged.tools).toEqual(base.tools);
  });

  it('is the identity on an empty patch', () => {
    expect(mergeConfigPatch(base, {})).toEqual(base);
  });

  it('does not mutate the config it was given', () => {
    const before = structuredClone(base);
    mergeConfigPatch(base, { agents: { defaults: { model: 'llama3' } } });
    expect(base).toEqual(before);
  });

  it('replaces an array rather than appending to it', () => {
    const withSkills = mergeConfigPatch(base, {
      agents: { defaults: { pinnedSkills: ['a', 'b'] } },
    });
    const replaced = mergeConfigPatch(withSkills, {
      agents: { defaults: { pinnedSkills: ['c'] } },
    });

    // There is no patch syntax for a removal, so a merging array would make
    // un-pinning a skill impossible.
    expect(replaced.agents.defaults.pinnedSkills).toEqual(['c']);
  });

  it('replaces extraHeaders wholesale, so a header can be deleted', () => {
    const withHeaders = mergeConfigPatch(base, {
      providers: { openai: { extraHeaders: { 'X-One': '1', 'X-Two': '2' } } },
    });
    const replaced = mergeConfigPatch(withHeaders, {
      providers: { openai: { extraHeaders: { 'X-One': '1' } } },
    });

    expect(replaced.providers.openai?.extraHeaders).toEqual({ 'X-One': '1' });
  });

  it('merges the providers record per id', () => {
    const first = mergeConfigPatch(base, { providers: { ollama: { apiBase: 'http://a/v1' } } });
    const second = mergeConfigPatch(first, { providers: { openai: { apiBase: 'http://b/v1' } } });

    expect(second.providers.ollama?.apiBase).toBe('http://a/v1');
    expect(second.providers.openai?.apiBase).toBe('http://b/v1');
  });

  it('treats an explicit undefined as "not mentioned"', () => {
    // JSON cannot carry `undefined`; the only way it arrives is a JS caller
    // spreading an optional field, and reading that as a deletion would drop a
    // setting nobody named.
    const merged = mergeConfigPatch(base, {
      agents: { defaults: { model: undefined, temperature: 0.3 } },
    });

    expect(merged.agents.defaults.model).toBe(base.agents.defaults.model);
    expect(merged.agents.defaults.temperature).toBe(0.3);
  });

  it('keeps a channel plugin block the schema does not name', () => {
    const merged = mergeConfigPatch(base, { channels: { telegram: { token: 'abc' } } });
    expect(merged.channels.telegram).toEqual({ token: 'abc' });
  });

  it('rejects a merge that produces settings the schema refuses, naming the path', () => {
    // The patch schema validates field by field; only the full schema knows the
    // result is a `Config`. This one gets past `ConfigPatchSchema` because the
    // caller bypassed it — which a JS caller can, and a route will not.
    expect(() => mergeConfigPatch(base, { agents: { defaults: { temperature: 9 } } })).toThrow(
      /agents\.defaults\.temperature/,
    );
  });
});
