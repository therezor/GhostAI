/**
 * Agents, as rows.
 *
 * Split in two on purpose. `agentItems` is a pure function from the domain
 * records to a list of rows — all the labelling, the marking of the current one
 * and every translated string live in it, and it tests with three objects and no
 * terminal. `pickAgent` is the five lines that hand those rows to a menu.
 *
 * It takes `readonly EffectiveAgent[]`, never the runtime. A picker holding a
 * `ChatRuntime` would be a picker that could run a turn, and the point of this
 * layer is that it cannot do anything except turn data into a choice.
 *
 * `AgentSummary` is deliberately not reused. There are two of them — the wire
 * DTO in `@ghostwire/protocol` and the port in `@ghostwire/server` — and both are
 * shapes the *server* needs. The CLI already holds `runtime.agents`, whose
 * `label` is documented as never empty, so taking on either would be adopting a
 * translation nobody here has to make.
 */

import type { EffectiveAgent } from '@ghostwire/runtime';
import type { SelectItem } from '@ghostwire/tui';

import type { CliT } from '../i18n.js';
import type { Menu } from '../menu.js';

interface AgentPickerDeps {
  readonly menu: Menu;
  readonly agents: readonly EffectiveAgent[];
  /** The agent this conversation runs on now, if it has one. */
  readonly current: string | undefined;
  readonly t: CliT;
}

/** What the row's right-hand column says about an agent. */
function hintFor(agent: EffectiveAgent, t: CliT): string {
  const model = agent.defaults.model;
  return model === '' ? t('menu.noModel') : model;
}

/**
 * One row per agent, in the order the runtime gives them — which is
 * default-first and then the operator's own, and is documented there as the
 * order a picker should show.
 */
export function agentItems(
  agents: readonly EffectiveAgent[],
  current: string | undefined,
  t: CliT,
): Array<SelectItem<string>> {
  return agents.map((agent) => {
    const hint = hintFor(agent, t);
    return {
      value: agent.id,
      label: agent.label,
      hint: agent.id === current ? `${hint} · ${t('menu.current')}` : hint,
      // So typing the id finds the agent even when the operator gave it a
      // label that shares none of its letters.
      keywords: agent.id,
    };
  });
}

/**
 * The listing, for a terminal that cannot draw a menu.
 *
 * Same shape as `/workspaces`, and for the same reason: a pipe still deserves an
 * answer, and the answer it deserves is the one a human would have read off the
 * menu.
 */
export function agentListing(
  agents: readonly EffectiveAgent[],
  current: string | undefined,
  t: CliT,
): string {
  return agents
    .map((agent) => {
      const mark = agent.id === current ? '*' : ' ';
      return `${mark} ${agent.id}  ·  ${agent.label}  ·  ${hintFor(agent, t)}`;
    })
    .join('\n');
}

/** Opens the menu on the current agent. `undefined` if it was cancelled. */
export async function pickAgent(
  deps: AgentPickerDeps,
): Promise<string | undefined> {
  const items = agentItems(deps.agents, deps.current, deps.t);
  const at = items.findIndex((item) => item.value === deps.current);

  return await deps.menu.choose({
    items,
    labels: {
      title: deps.t('menu.titles.agent'),
      empty: deps.t('menu.empty'),
      footer: deps.t('menu.footer'),
    },
    ...(at < 0 ? {} : { index: at }),
  });
}
