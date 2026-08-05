/**
 * What Settings is made of, as data.
 *
 * Six panels are built and one names a phase instead. Keeping both in one list
 * is deliberate: the unbuilt ones are part of the shape of the product, and a
 * settings screen that simply omits them reads as a product that does not have
 * them rather than one whose knowledge base arrives in Phase 5. The roadmap says
 * this explicitly — a panel whose backing system lands later renders a
 * placeholder naming the phase, not a stub implementation, because a stub is
 * indistinguishable from a broken feature and gets reported as one.
 *
 * **A built panel may still list planned systems**, and Extensions is the first
 * to do it. MCP servers ship; skills, OAuth and plugins do not, and they are
 * most of what that screen will eventually hold. Dropping them the moment one
 * sibling landed would make the screen read as finished. What must not survive
 * is a system listed here that *has* shipped — that is a panel telling an
 * operator to wait for something already on the screen beside it, and
 * `panels.test.ts` is what catches it. Channels left this list the way MCP
 * servers did: by becoming a panel.
 *
 * It is data rather than a `<Tabs>` written out by hand so the list can be
 * asserted about: `panels.test.ts` is what stops a panel from claiming a phase
 * the plan does not have, or from being built and still advertising one.
 */

import type { WebKey } from '@/i18n/keys.js';

export interface SettingsPanel {
  /** Also the tab value and the `?panel=` search parameter. */
  readonly id: string;
  /**
   * Resource keys rather than words, because this table is read as data — the
   * tab strip, the heading and `panels.test.ts` all index into it. A `string`
   * here would widen the literal on the way in and hand `t()` something it
   * cannot check, which is precisely the mistake this layer exists to catch.
   */
  readonly label: WebKey;
  /** One line under the heading, saying what the panel governs. */
  readonly summary: WebKey;
  /** The phase that builds it. Absent means it is built now. */
  readonly phase?: number;
}

const PROVIDERS_PANEL: SettingsPanel = {
  id: 'providers',
  label: 'settings.panels.providers.label',
  summary: 'settings.panels.providers.summary',
};

export const SETTINGS_PANELS: readonly SettingsPanel[] = [
  PROVIDERS_PANEL,
  {
    id: 'tools',
    label: 'settings.panels.tools.label',
    summary: 'settings.panels.tools.summary',
  },
  {
    id: 'account',
    label: 'settings.panels.account.label',
    summary: 'settings.panels.account.summary',
  },
  {
    id: 'appearance',
    label: 'settings.panels.appearance.label',
    summary: 'settings.panels.appearance.summary',
  },
  {
    id: 'automation',
    label: 'settings.panels.automation.label',
    summary: 'settings.panels.automation.summary',
  },
  {
    id: 'extensions',
    label: 'settings.panels.extensions.label',
    summary: 'settings.panels.extensions.summary',
  },
  {
    id: 'channels',
    label: 'settings.panels.channels.label',
    summary: 'settings.panels.channels.summary',
  },
  {
    id: 'knowledge',
    label: 'settings.panels.knowledge.label',
    summary: 'settings.panels.knowledge.summary',
    phase: 5,
  },
];

export const DEFAULT_PANEL_ID: string = PROVIDERS_PANEL.id;

/** One unbuilt system, listed inside the panel that will hold it. */
export interface PlannedSystem {
  readonly name: WebKey;
  readonly detail: WebKey;
  readonly phase: number;
}

/**
 * Keyed by panel id — for a panel that names a phase, and for a built one that
 * still has systems to come.
 *
 * The entries are more specific than the panel itself because the phases differ
 * within one screen: skills arrive in Phase 3 and the plugin host in Phase 4,
 * and a single "coming in Phase 3" over both would be wrong about one of them.
 * That is also why MCP servers left this list rather than the panel doing so —
 * the panel is built and the systems still under it are not. Channels left the
 * same way, and by a different door: it grew a panel of its own.
 */
export const PLANNED_SYSTEMS: Readonly<
  Record<string, readonly PlannedSystem[]>
> = {
  extensions: [
    {
      name: 'settings.planned.skills.name',
      detail: 'settings.planned.skills.detail',
      phase: 3,
    },
    {
      name: 'settings.planned.oauth.name',
      detail: 'settings.planned.oauth.detail',
      phase: 3,
    },
    {
      name: 'settings.planned.plugins.name',
      detail: 'settings.planned.plugins.detail',
      phase: 4,
    },
  ],
  knowledge: [
    {
      name: 'settings.planned.knowledgeBase.name',
      detail: 'settings.planned.knowledgeBase.detail',
      phase: 5,
    },
  ],
};

/** Whether this panel is a placeholder rather than a form. */
export function isPlanned(panel: SettingsPanel): boolean {
  return panel.phase !== undefined;
}

/** The panel a `?panel=` value names, falling back rather than 404ing. */
export function panelById(id: string | undefined): SettingsPanel {
  const found = SETTINGS_PANELS.find((panel) => panel.id === id);
  // A stale bookmark to a panel that was renamed lands on Agent, which is a
  // settings screen. The alternative is an empty tab panel, which is not.
  return found ?? PROVIDERS_PANEL;
}
