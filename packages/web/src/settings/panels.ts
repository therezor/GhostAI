/**
 * What Settings is made of, as data.
 *
 * Three panels are built and four name a phase instead. Keeping both in one
 * list is deliberate: the unbuilt ones are part of the shape of the product, and
 * a settings screen that simply omits them reads as a product that does not have
 * them rather than one whose scheduler arrives in Phase 5. The build plan says
 * this explicitly — a panel whose backing system lands later renders a
 * placeholder naming the phase, not a stub implementation, because a stub is
 * indistinguishable from a broken feature and gets reported as one.
 *
 * It is data rather than a `<Tabs>` written out by hand so the list can be
 * asserted about: `panels.test.ts` is what stops a panel from claiming a phase
 * the plan does not have, or from being built and still advertising one.
 */

export interface SettingsPanel {
  /** Also the tab value and the `?panel=` search parameter. */
  readonly id: string;
  readonly label: string;
  /** One line under the heading, saying what the panel governs. */
  readonly summary: string;
  /** The phase that builds it. Absent means it is built now. */
  readonly phase?: number;
}

const AGENT_PANEL: SettingsPanel = {
  id: 'agent',
  label: 'Agent',
  summary: 'The model a turn runs on, and the budget it runs inside.',
};

export const SETTINGS_PANELS: readonly SettingsPanel[] = [
  AGENT_PANEL,
  {
    id: 'providers',
    label: 'Providers',
    summary: 'Endpoints and API keys. Keys are written to the vault and never read back.',
  },
  {
    id: 'tools',
    label: 'Tools',
    summary: 'What the agent may do on its own, and what it has to ask about first.',
  },
  {
    id: 'account',
    label: 'Account',
    summary: 'The username and password this server is signed into with.',
  },
  {
    id: 'extensions',
    label: 'Extensions',
    summary: 'MCP servers, skills, channels and plugins.',
    phase: 3,
  },
  {
    id: 'automation',
    label: 'Automation',
    summary: 'Scheduled jobs and the heartbeat that runs them unattended.',
    phase: 5,
  },
  {
    id: 'knowledge',
    label: 'Knowledge',
    summary: 'The retrieval index behind `@kb:` mentions.',
    phase: 5,
  },
];

export const DEFAULT_PANEL_ID: string = AGENT_PANEL.id;

/** One unbuilt system, listed inside the panel that will hold it. */
export interface PlannedSystem {
  readonly name: string;
  readonly detail: string;
  readonly phase: number;
}

/**
 * Keyed by panel id, and only for panels that name a phase.
 *
 * The entries are more specific than the panel itself because the phases differ
 * within one screen: MCP arrives in Phase 3 and the plugin host in Phase 4, and
 * a single "coming in Phase 3" over both would be wrong about one of them.
 */
export const PLANNED_SYSTEMS: Readonly<Record<string, readonly PlannedSystem[]>> = {
  extensions: [
    { name: 'MCP servers', detail: 'Connect tool servers over stdio, SSE or HTTP.', phase: 3 },
    { name: 'Skills and profiles', detail: 'Reusable instructions, scoped per session.', phase: 3 },
    { name: 'OAuth connections', detail: 'Authorise a provider without pasting a key.', phase: 3 },
    { name: 'Channels', detail: 'Reach the same agent from Telegram.', phase: 3 },
    { name: 'Plugins', detail: 'Install and remove capabilities from the UI.', phase: 4 },
  ],
  automation: [
    { name: 'Scheduled jobs', detail: 'Cron and one-shot runs against a session.', phase: 5 },
    { name: 'Heartbeat', detail: 'A recurring pass over the workspace task file.', phase: 5 },
  ],
  knowledge: [
    { name: 'Knowledge base', detail: 'Ingest documents and search them from a turn.', phase: 5 },
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
  return found ?? AGENT_PANEL;
}
