/**
 * What a system that has not been built yet looks like.
 *
 * It lists what will live here and which phase builds it, which is a different
 * thing from a disabled form. A greyed-out set of controls says "you cannot use
 * this", and the reader's next question is why — a permission, a licence, a bug.
 * A list saying "Skills — Phase 3" answers that question instead of raising it,
 * and it stops the panel from being reported as broken.
 *
 * Split into a whole *panel* and a bare *list* because Extensions is now both:
 * MCP servers ship and the four systems beside them do not, so that screen
 * renders its own content and then this list under it. A panel with nothing
 * built still renders `PlannedPanel`, which is the list with a heading.
 */

import type { JSX } from 'react';
import { useTranslation } from 'react-i18next';

import { Badge } from '@/components/ui/badge.js';
import { Section } from '@/components/form/controls.js';
import {
  PLANNED_SYSTEMS,
  type PlannedSystem,
  type SettingsPanel,
} from './panels.js';

export function PlannedList({
  title,
  description,
  systems,
}: {
  readonly title: string;
  readonly description: string;
  readonly systems: readonly PlannedSystem[];
}): JSX.Element | null {
  const { t } = useTranslation();
  if (systems.length === 0) return null;

  return (
    <Section title={title} description={description}>
      <ul className="settings-divided-list">
        {systems.map((system) => (
          <li key={system.name}>
            <div className="settings-divided-list__text">
              <span className="settings-divided-list__name">
                {t(system.name)}
              </span>
              <span className="settings-divided-list__detail">
                {t(system.detail)}
              </span>
            </div>
            <Badge tone="info">
              {t('settings.planned.phase', { phase: system.phase })}
            </Badge>
          </li>
        ))}
      </ul>
    </Section>
  );
}

export function PlannedPanel({
  panel,
}: {
  readonly panel: SettingsPanel;
}): JSX.Element | null {
  const { t } = useTranslation();
  return (
    <PlannedList
      title={t(panel.label)}
      description={t(panel.summary)}
      systems={PLANNED_SYSTEMS[panel.id] ?? []}
    />
  );
}
