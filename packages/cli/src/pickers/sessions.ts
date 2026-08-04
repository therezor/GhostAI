/**
 * Sessions, as rows.
 *
 * Same split as `agents.ts`: a pure builder that carries all the labelling, and
 * a driver that hands the result to a menu.
 *
 * `/sessions` opens this on a terminal and prints its listing on a pipe — the
 * shape `/agent` and `/workspace` already take, so there is one rule for all
 * three rather than a picker verb beside a listing verb for each of them. The
 * numeric argument is the page size in both cases, which is what keeps a script
 * and a person asking the same question of the same rows.
 */

import type { SessionSummaryRecord } from '@ghostai/core';
import type { SelectItem } from '@ghostai/tui';

import type { CliT } from '../i18n.js';
import type { Menu } from '../menu.js';

export interface SessionPickerDeps {
  readonly menu: Menu;
  readonly sessions: readonly SessionSummaryRecord[];
  /** The conversation the prompt is on now. */
  readonly current: string;
  readonly t: CliT;
}

/**
 * One row per session, newest first — the order the store already returns.
 *
 * The key goes in the hint rather than the label: a title is what a person
 * recognises, and `cli-9f2ab1` beside it is what they need only when two
 * conversations share a name.
 */
export function sessionItems(
  sessions: readonly SessionSummaryRecord[],
  current: string,
  t: CliT,
): Array<SelectItem<string>> {
  return sessions.map((session) => {
    // `{{count}}` and a `_one`/`_other` pair, the way `workspaceInUse` already
    // does it: a hint is two words, and a locale-aware separator on a number
    // that is almost always single digits buys nothing.
    const count = t('menu.messages', { count: session.messageCount });
    return {
      value: session.key,
      label: session.title === '' ? session.key : session.title,
      hint: session.key === current ? `${count} · ${t('menu.current')}` : count,
      keywords: session.key,
    };
  });
}

/** Opens the menu on the current conversation. `undefined` if cancelled. */
export async function pickSession(
  deps: SessionPickerDeps,
): Promise<string | undefined> {
  const items = sessionItems(deps.sessions, deps.current, deps.t);
  const at = items.findIndex((item) => item.value === deps.current);

  return await deps.menu.choose({
    items,
    labels: {
      title: deps.t('menu.titles.session'),
      empty: deps.t('menu.empty'),
      footer: deps.t('menu.footer'),
    },
    ...(at < 0 ? {} : { index: at }),
  });
}
