/**
 * Workspaces, as rows.
 *
 * The counts arrive as a map rather than being looked up here, because counting
 * is `store.countByWorkspace` and this file is not allowed a store — the same
 * rule that keeps a picker from being able to run a turn.
 */

import type { WorkspaceRecord } from '@ghostai/core';
import type { SelectItem } from '@ghostai/tui';

import type { CliT } from '../i18n.js';
import type { Menu } from '../menu.js';

export interface WorkspacePickerDeps {
  readonly menu: Menu;
  readonly workspaces: readonly WorkspaceRecord[];
  readonly counts: ReadonlyMap<string, number>;
  readonly current: string | undefined;
  readonly t: CliT;
}

export function workspaceItems(
  workspaces: readonly WorkspaceRecord[],
  counts: ReadonlyMap<string, number>,
  current: string | undefined,
  t: CliT,
): Array<SelectItem<string>> {
  return workspaces.map((workspace) => {
    const count = counts.get(workspace.id) ?? 0;
    const hint = t('menu.sessions', { count });
    return {
      value: workspace.id,
      label: workspace.name,
      hint: workspace.id === current ? `${hint} · ${t('menu.current')}` : hint,
      keywords: workspace.id,
    };
  });
}

export async function pickWorkspace(
  deps: WorkspacePickerDeps,
): Promise<string | undefined> {
  const items = workspaceItems(
    deps.workspaces,
    deps.counts,
    deps.current,
    deps.t,
  );
  const at = items.findIndex((item) => item.value === deps.current);

  return await deps.menu.choose({
    items,
    labels: {
      title: deps.t('menu.titles.workspace'),
      empty: deps.t('menu.empty'),
      footer: deps.t('menu.footer'),
    },
    ...(at < 0 ? {} : { index: at }),
  });
}
