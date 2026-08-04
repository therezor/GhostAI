import type { ModelsResponse } from '@ghostai/protocol';
import { describe, expect, it } from 'vitest';

import { translations } from '#src/i18n.js';
import { modelErrors, modelItems, modelListing } from '#src/pickers/models.js';

const { t } = translations('en');

const CATALOGUE: ModelsResponse = {
  models: [
    { id: 'qwen3', providerId: 'ollama' },
    { id: 'gpt-5', providerId: 'openai', displayName: 'GPT-5' },
  ],
  errors: {},
};

describe('modelItems', () => {
  it('shows the display name when the endpoint published one, and the id otherwise', () => {
    const items = modelItems(CATALOGUE, 'nothing', t);
    expect(items[0]?.label).toBe('qwen3');
    expect(items[1]?.label).toBe('GPT-5');
  });

  it('says which endpoint each model came from', () => {
    expect(modelItems(CATALOGUE, 'nothing', t)[0]?.hint).toBe('ollama');
  });

  it('marks the one a turn would use right now', () => {
    expect(modelItems(CATALOGUE, 'qwen3', t)[0]?.hint).toContain('current');
  });

  it('keeps the id searchable, since it is not always the label', () => {
    expect(modelItems(CATALOGUE, 'nothing', t)[1]?.keywords).toBe('gpt-5');
  });

  it('makes no rows for an empty catalogue', () => {
    expect(modelItems({ models: [], errors: {} }, '', t)).toEqual([]);
  });
});

describe('modelListing', () => {
  it('is what a pipe gets, marking the current model', () => {
    const listing = modelListing(CATALOGUE, 'gpt-5');
    expect(listing).toContain('* gpt-5');
    expect(listing).toContain('  qwen3');
    expect(listing).toContain('ollama');
  });
});

describe('modelErrors', () => {
  it('names every endpoint that did not answer, and what it said', () => {
    const lines = modelErrors(
      { models: [], errors: { openai: 'connect ECONNREFUSED' } },
      t,
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('openai');
    expect(lines[0]).toContain('ECONNREFUSED');
  });

  it('says nothing when everything answered', () => {
    expect(modelErrors(CATALOGUE, t)).toEqual([]);
  });
});
