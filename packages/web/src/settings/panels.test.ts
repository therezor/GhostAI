/**
 * The panel registry.
 *
 * The rules asserted here are the ones that make a placeholder honest: a panel
 * either has a form or names a phase, never both and never neither, and a panel
 * that names a phase actually lists what is coming. The failure this prevents is
 * a built panel still advertising "Phase 5" months after it shipped, which is
 * the sort of thing nobody notices because it looks deliberate.
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PANEL_ID,
  isPlanned,
  panelById,
  PLANNED_SYSTEMS,
  SETTINGS_PANELS,
} from './panels.js';

describe('the settings panels', () => {
  it('have unique ids', () => {
    const ids = SETTINGS_PANELS.map((panel) => panel.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('ship the three the phase builds', () => {
    const built = SETTINGS_PANELS.filter((panel) => !isPlanned(panel)).map((panel) => panel.id);
    expect(built).toEqual(['agent', 'providers', 'tools']);
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
      expect(panel.summary.length).toBeGreaterThan(0);
      expect(panel.label.length).toBeGreaterThan(0);
    }
  });
});

describe('panelById', () => {
  it('finds a panel by its id', () => {
    expect(panelById('tools').label).toBe('Tools');
  });

  it('falls back rather than 404ing on a stale bookmark', () => {
    expect(panelById('renamed-last-year').id).toBe(DEFAULT_PANEL_ID);
    expect(panelById(undefined).id).toBe(DEFAULT_PANEL_ID);
  });
});
