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

import { Badge } from '@/components/ui/badge.js';
import { Section } from './controls.js';
import { PLANNED_SYSTEMS, type SettingsPanel } from './panels.js';

export function PlannedPanel({ panel }: { readonly panel: SettingsPanel }): JSX.Element {
  const systems = PLANNED_SYSTEMS[panel.id] ?? [];

  return (
    <Section title={panel.label} description={panel.summary}>
      <ul className="flex flex-col divide-y divide-line">
        {systems.map((system) => (
          <li key={system.name} className="flex items-start gap-3 py-3">
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="text-sm font-medium text-fg-1">{system.name}</span>
              <span className="text-xs text-fg-3">{system.detail}</span>
            </div>
            <Badge tone="info">Phase {system.phase}</Badge>
          </li>
        ))}
      </ul>
    </Section>
  );
}
