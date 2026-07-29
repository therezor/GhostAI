/**
 * The agents a turn can be run by.
 *
 * Read-only, and that is the whole design. Creating, editing and deleting an
 * agent is a settings edit — `PATCH /api/settings` with an `agents.list` patch
 * — because an agent *is* a subtree of the settings tree, and a second CRUD
 * surface over the same state would need its own merge rules, its own
 * validation and its own answer to what a partial write means. `providers` made
 * the same call for the same reason.
 *
 * What this route adds that `GET /api/settings` cannot: the model each agent
 * would actually use, after inheritance from `agents.defaults` and after any
 * process-wide `--model` pin. A picker rendering the raw config would show an
 * empty string for every agent that inherits its model, which is most of them.
 */

import { AgentListResponseSchema, type AgentListResponse } from '@ghostai/protocol';

import type { RouteDeps, RouteGroup } from './types.js';

export function agentRoutes(deps: RouteDeps): RouteGroup<'agents.list'> {
  return {
    'agents.list': {
      summary: 'Every agent that can run a turn',
      schema: { response: { 200: AgentListResponseSchema } },
      // Already ordered — the default first, then the operator's own order —
      // so a picker never has to sort and never renders a different order twice.
      handler: (): AgentListResponse => ({ agents: [...deps.runtime.agents()] }),
    },
  };
}
