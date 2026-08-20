import { ReasoningEffortSchema } from '@ghostwire/protocol';
import { describe, expect, it } from 'vitest';

import { translations } from '#src/i18n.js';
import {
  DEFAULT_LEVEL,
  effortItems,
  effortListing,
} from '#src/pickers/effort.js';

const { t } = translations('en');

describe('effortItems', () => {
  it('offers every level the schema has, so a new one needs no second list', () => {
    const values = effortItems(undefined, t).map((item) => item.value);
    expect(values).toEqual([DEFAULT_LEVEL, ...ReasoningEffortSchema.options]);
  });

  it('puts default first, because it is the state an agent starts in', () => {
    expect(effortItems(undefined, t)[0]?.value).toBe(DEFAULT_LEVEL);
  });

  it('marks stating none as the current row, which is a real answer', () => {
    // The distinction the whole setting is built on: `default` means the agent
    // states no effort, and that is a row like any other rather than the
    // absence of a selection.
    const items = effortItems(undefined, t);
    expect(items[0]?.hint).toContain('current');
    expect(items.filter((item) => item.hint?.includes('current'))).toHaveLength(
      1,
    );
  });

  it('marks the level in force when there is one', () => {
    const items = effortItems('high', t);
    expect(items.find((item) => item.value === 'high')?.hint).toContain(
      'current',
    );
    expect(items[0]?.hint).not.toContain('current');
  });

  it('says how off differs from default, and stays quiet about the rest', () => {
    // Which levels *mean* anything is the model's business, not this
    // project's — so the only other row that carries a hint is the one whose
    // mechanism differs, and the rest say only whether they are in force.
    const items = effortItems('medium', t);
    expect(items.find((item) => item.value === 'off')?.hint).toContain(
      'asking for none',
    );
    expect(items.find((item) => item.value === 'high')?.hint).toBe('');
  });
});

describe('effortListing', () => {
  it('is what a pipe gets, marking the level in force', () => {
    const listing = effortListing('low', t);
    expect(listing).toContain('* low');
    expect(listing).toContain('  high');
  });

  it('marks default when the agent states no level', () => {
    expect(effortListing(undefined, t)).toContain(`* ${DEFAULT_LEVEL}`);
  });
});
