/**
 * Settings.
 *
 * The panel lives in the URL as `?panel=`, which is what makes a settings screen
 * linkable — "set your key here" is a link, not a sentence describing four
 * clicks. `panelById` falls back rather than 404ing, so a bookmark to a panel
 * that was renamed lands on a settings screen instead of an empty tab.
 *
 * Everything below the tabs waits for one `GET /api/settings`. Each panel is
 * mounted with the config it initialises its form from, and mounted *only* once
 * that config exists — a form built from defaults and then re-synced is a form
 * that shows the wrong values for a frame, and on a slow connection for rather
 * more than a frame.
 *
 * `loadError` is surfaced at the top rather than swallowed. It means the file on
 * disk failed to parse and the process is running on defaults, which is exactly
 * the state where the settings screen looks fine and is describing something
 * that is not what will load next time.
 */

import { useNavigate, useSearch } from '@tanstack/react-router';
import { AlertTriangle } from 'lucide-react';
import type { JSX } from 'react';

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs.js';
import { AccountPanel } from '@/settings/account-panel.js';
import { AgentPanel } from '@/settings/agent-panel.js';
import { PlannedPanel } from '@/settings/planned-panel.js';
import { ProvidersPanel } from '@/settings/providers-panel.js';
import { ToolsPanel } from '@/settings/tools-panel.js';
import { isPlanned, panelById, SETTINGS_PANELS } from '@/settings/panels.js';
import { useSettings } from '@/settings/use-settings.js';

export function SettingsRoute(): JSX.Element {
  const { panel: requested } = useSearch({ from: '/settings' });
  const navigate = useNavigate();
  const settings = useSettings();
  const panel = panelById(requested);

  return (
    <div className="stack page page--wide">
      <div className="stack page__heading">
        <h1 className="page__title">Settings</h1>
        <p className="page__note">{panel.summary}</p>
      </div>

      {settings.data?.loadError !== undefined && (
        <p role="alert" className="settings-load-error">
          <AlertTriangle />
          <span>
            The settings file could not be read and defaults are in use. Saving here overwrites it.
            ({settings.data.loadError})
          </span>
        </p>
      )}

      <Tabs
        value={panel.id}
        onValueChange={(value) => {
          // `replace`, because switching panels is not a step the Back button
          // should have to walk through to leave Settings.
          void navigate({ to: '/settings', search: { panel: value }, replace: true });
        }}
      >
        {/* Scrolls rather than wraps: a tab strip that reflows to two rows moves
            every tab under the pointer as the window is resized. */}
        <TabsList className="settings-tabs">
          {SETTINGS_PANELS.map((entry) => (
            <TabsTrigger key={entry.id} value={entry.id}>
              {entry.label}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value={panel.id}>
          <PanelBody panelId={panel.id} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

/**
 * Split out so the panel choice is one `switch`-shaped expression rather than a
 * ladder of ternaries nested inside JSX, which is where a missing branch hides.
 */
function PanelBody({ panelId }: { readonly panelId: string }): JSX.Element {
  const settings = useSettings();
  const panel = panelById(panelId);

  if (isPlanned(panel)) return <PlannedPanel panel={panel} />;

  // Before the settings gate, and the only panel that goes before it: a
  // credential is not in `config.json`, so this panel has nothing to wait for —
  // and an install whose settings request is failing is exactly the one whose
  // owner may be trying to fix their password.
  if (panel.id === 'account') return <AccountPanel />;

  if (settings.isPending) return <p className="page__note">Loading settings…</p>;
  if (settings.isError) {
    return (
      <p role="alert" className="page__error">
        Could not load settings: {settings.error.message}
      </p>
    );
  }

  const { config } = settings.data;
  if (panel.id === 'providers') return <ProvidersPanel config={config} />;
  if (panel.id === 'tools') return <ToolsPanel config={config} />;
  return <AgentPanel config={config} />;
}
