import type { EffectiveAgent } from '@ghostbot/runtime';
import { describe, expect, it } from 'vitest';

import { translations } from '#src/i18n.js';
import { agentItems, agentListing, pickAgent } from '#src/pickers/agents.js';
import { NO_MENU, type Menu, type MenuRequest } from '#src/menu.js';

const { t } = translations('en');

/**
 * Only the fields the picker reads.
 *
 * An `EffectiveAgent` carries a dozen more — prompts, tool permissions, a
 * toolbox, subagent bindings — and a fixture that filled them in would be
 * asserting that the picker ignores them, at length.
 */
function agent(
  id: string,
  label: string,
  model = 'claude-opus-5',
): EffectiveAgent {
  return { id, label, defaults: { model } } as unknown as EffectiveAgent;
}

const AGENTS = [
  agent('default', 'Default'),
  agent('reviewer', 'Reviewer', 'claude-sonnet-5'),
  agent('scout', 'Scout', ''),
];

describe('agentItems', () => {
  it('makes one row per agent, in the order it was given them', () => {
    // The runtime hands them over default-first and then in the operator's own
    // order, and documents that as the order a picker should show.
    expect(agentItems(AGENTS, undefined, t).map((item) => item.value)).toEqual([
      'default',
      'reviewer',
      'scout',
    ]);
  });

  it('shows the label, and the model beside it', () => {
    const [first, second] = agentItems(AGENTS, undefined, t);
    expect(first?.label).toBe('Default');
    expect(first?.hint).toBe('claude-opus-5');
    expect(second?.hint).toBe('claude-sonnet-5');
  });

  it('says so rather than showing an empty column when an agent has no model', () => {
    const [, , scout] = agentItems(AGENTS, undefined, t);
    expect(scout?.hint).toBe('no model set');
  });

  it('marks the one this conversation already runs on', () => {
    const [, reviewer] = agentItems(AGENTS, 'reviewer', t);
    expect(reviewer?.hint).toContain('current');
  });

  it('keeps the id searchable even when the label shares none of its letters', () => {
    const [, reviewer] = agentItems(AGENTS, undefined, t);
    expect(reviewer?.keywords).toBe('reviewer');
  });

  it('makes no rows at all for no agents', () => {
    expect(agentItems([], undefined, t)).toEqual([]);
  });
});

describe('agentListing', () => {
  it('is what a pipe gets instead of a menu, and marks the current one', () => {
    const listing = agentListing(AGENTS, 'reviewer', t);
    expect(listing).toContain('* reviewer');
    expect(listing).toContain('  default');
    expect(listing).toContain('claude-sonnet-5');
    expect(listing.split('\n')).toHaveLength(3);
  });
});

describe('pickAgent', () => {
  /** Records the request and answers with whatever it was told to. */
  function menuAnswering(value: string | undefined): {
    readonly menu: Menu;
    readonly asked: Array<MenuRequest<string>>;
  } {
    const asked: Array<MenuRequest<string>> = [];
    return {
      asked,
      menu: {
        available: true,
        choose<T>(request: MenuRequest<T>): Promise<T | undefined> {
          asked.push(request as unknown as MenuRequest<string>);
          return Promise.resolve(value as T | undefined);
        },
      },
    };
  }

  it('opens on the agent the conversation already runs on', async () => {
    const { menu, asked } = menuAnswering('scout');
    expect(
      await pickAgent({ menu, agents: AGENTS, current: 'reviewer', t }),
    ).toBe('scout');
    expect(asked[0]?.index).toBe(1);
  });

  it('opens at the top when nothing is current yet', async () => {
    const { menu, asked } = menuAnswering(undefined);
    await pickAgent({ menu, agents: AGENTS, current: 'gone', t });
    expect(asked[0]?.index).toBeUndefined();
  });

  it('answers nothing when the menu was cancelled', async () => {
    const { menu } = menuAnswering(undefined);
    expect(
      await pickAgent({ menu, agents: AGENTS, current: undefined, t }),
    ).toBeUndefined();
  });

  it('answers nothing when there is no menu to open', async () => {
    expect(
      await pickAgent({
        menu: NO_MENU,
        agents: AGENTS,
        current: undefined,
        t,
      }),
    ).toBeUndefined();
  });
});
