/**
 * Workspaces, as rows.
 *
 * **No session count.** A workspace is where a conversation *starts*, and one
 * can be moved to another afterwards — so a count beside the name answers a
 * question nobody asked and implies an ownership that does not hold. The id is
 * what goes there instead, because it is what `/workspace <id>` takes.
 */

import type { WorkspaceRecord } from '@ghostai/core';
import type { SelectItem } from '@ghostai/tui';

import type { CliT } from '../i18n.js';
import type { Menu } from '../menu.js';

interface WorkspacePickerDeps {
  readonly menu: Menu;
  readonly workspaces: readonly WorkspaceRecord[];
  readonly current: string | undefined;
  readonly t: CliT;
}

export function workspaceItems(
  workspaces: readonly WorkspaceRecord[],
  current: string | undefined,
  t: CliT,
): Array<SelectItem<string>> {
  return workspaces.map((workspace) => ({
    value: workspace.id,
    label: workspace.name,
    hint:
      workspace.id === current
        ? `${workspace.id} · ${t('menu.current')}`
        : workspace.id,
  }));
}

export async function pickWorkspace(
  deps: WorkspacePickerDeps,
): Promise<string | undefined> {
  const items = workspaceItems(deps.workspaces, deps.current, deps.t);
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
