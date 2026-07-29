/**
 * The panel registry.
 *
 * The rules asserted here are the ones that make a placeholder honest: a panel
 * either has a form or names a phase, never both and never neither, and a panel
 * that names a phase actually lists what is coming. The failure this prevents is
 * a built panel still advertising "Phase 5" months after it shipped, which is
 * the sort of thing nobody notices because it looks deliberate.
 */

import { createWebI18n } from '@ghostai/i18n/web';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PANEL_ID,
  isPlanned,
  panelById,
  PLANNED_SYSTEMS,
  SETTINGS_PANELS,
} from './panels.js';

/**
 * The table holds keys now, so every assertion about *wording* has to resolve
 * one. A real English instance rather than a stub: "gives every panel a
 * summary" is worth nothing if it only proves the key string is non-empty —
 * the failure it guards against is a panel whose summary was never written.
 */
const t = createWebI18n('en').getFixedT(null, 'web');

describe('the settings panels', () => {
  it('have unique ids', () => {
    const ids = SETTINGS_PANELS.map((panel) => panel.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('ship the four the phase builds', () => {
    // No `agent` panel: the settings it held *are* the default agent's, so they
    // are edited on that agent rather than in a second room describing the same
    // subtree. Agents are a page of their own, and picking one happens in the
    // composer.
    //
    // `appearance` joined them with the translation layer. It is the natural
    // home for the theme too, which until then lived only in the header — a
    // preference with no page you could point someone at.
    const built = SETTINGS_PANELS.filter((panel) => !isPlanned(panel)).map((panel) => panel.id);
    expect(built).toEqual(['providers', 'tools', 'account', 'appearance']);
  });

  it('no longer advertise profiles as unbuilt, now that agents ship', () => {
    // A built panel still listed as a planned system tells an operator to wait
    // for something that is already on the screen next to it.
    const planned = Object.values(PLANNED_SYSTEMS)
      .flat()
      .map((system) => t(system.name).toLowerCase());
    expect(planned.some((name) => name.includes('profile'))).toBe(false);
  });

  it('give every unbuilt panel a list of what lands in it', () => {
    for (const panel of SETTINGS_PANELS.filter(isPlanned)) {
      const systems = PLANNED_SYSTEMS[panel.id];
      expect(systems, `${panel.id} names a phase but lists nothing`).toBeDefined();
      expect(systems?.length).toBeGreaterThan(0);
    }
  });

  it('never lists a system in a panel that is already built', () => {
    for (const id of Object.keys(PLANNED_SYSTEMS)) {
      expect(SETTINGS_PANELS.find((panel) => panel.id === id)?.phase).toBeDefined();
    }
  });

  it('never promises a system earlier than the panel that holds it', () => {
    for (const panel of SETTINGS_PANELS.filter(isPlanned)) {
      for (const system of PLANNED_SYSTEMS[panel.id] ?? []) {
        expect(system.phase).toBeGreaterThanOrEqual(panel.phase ?? 0);
      }
    }
  });

  it('gives every panel a summary, which is the line under the heading', () => {
    for (const panel of SETTINGS_PANELS) {
      // Resolved, so a key that exists in the table but not in the bundle
      // fails here rather than rendering as `settings.panels.x.summary`.
      expect(t(panel.summary).length).toBeGreaterThan(0);
      expect(t(panel.summary)).not.toBe(panel.summary);
      expect(t(panel.label).length).toBeGreaterThan(0);
      expect(t(panel.label)).not.toBe(panel.label);
    }
  });
});

describe('panelById', () => {
  it('finds a panel by its id', () => {
    expect(t(panelById('tools').label)).toBe('Tools');
  });

  it('falls back rather than 404ing on a stale bookmark', () => {
    expect(panelById('renamed-last-year').id).toBe(DEFAULT_PANEL_ID);
    expect(panelById(undefined).id).toBe(DEFAULT_PANEL_ID);
  });
});
