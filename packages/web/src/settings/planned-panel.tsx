/**
 * The panel a system that has not been built yet renders.
 *
 * It lists what will live here and which phase builds it, which is a different
 * thing from a disabled form. A greyed-out set of controls says "you cannot use
 * this", and the reader's next question is why — a permission, a licence, a bug.
 * A list saying "MCP servers — Phase 3" answers that question instead of raising
 * it, and it stops the panel from being reported as broken.
 */

import type { JSX } from 'react';
import { useTranslation } from 'react-i18next';

import { Badge } from '@/components/ui/badge.js';
import { Section } from '@/components/form/controls.js';
import { PLANNED_SYSTEMS, type SettingsPanel } from './panels.js';

export function PlannedPanel({ panel }: { readonly panel: SettingsPanel }): JSX.Element {
  const { t } = useTranslation();
  const systems = PLANNED_SYSTEMS[panel.id] ?? [];

  return (
    <Section title={t(panel.label)} description={t(panel.summary)}>
      <ul className="settings-divided-list">
        {systems.map((system) => (
          <li key={system.name}>
            <div className="settings-divided-list__text">
              <span className="settings-divided-list__name">{t(system.name)}</span>
              <span className="settings-divided-list__detail">{t(system.detail)}</span>
            </div>
            <Badge tone="info">Phase {system.phase}</Badge>
          </li>
        ))}
      </ul>
    </Section>
  );
}
