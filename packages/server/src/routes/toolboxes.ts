/**
 * The toolboxes installed on this machine.
 *
 * Read from disk on every request rather than from a cached list, and that is
 * the point rather than laziness: a manifest edited after approval must stop
 * reporting as approved the moment it changes, and a list built at boot would
 * keep saying it was fine until a restart.
 *
 * Read-only. Installing and approving are operator actions with a terminal
 * behind them (`ghost profiles`), and exposing approval over HTTP would put the
 * one decision that makes a container policy mean something behind whatever
 * session happens to be open in a browser tab.
 */

import {
  ToolboxListResponseSchema,
  type ToolboxListResponse,
  type ToolboxSummary,
} from '@ghostbot/protocol';

import { weakenedIn } from '@ghostbot/security';

import type { RouteDeps, RouteGroup } from './types.js';

export function toolboxRoutes(deps: RouteDeps): RouteGroup<'toolboxes.list'> {
  return {
    'toolboxes.list': {
      summary: 'Toolboxes installed on this machine',
      schema: { response: { 200: ToolboxListResponseSchema } },
      handler: (): ToolboxListResponse => {
        const listed: ToolboxSummary[] = deps.runtime
          .toolboxes()
          .map((entry) => ({
            name: entry.name,
            label: entry.toolbox?.label ?? '',
            tools: (entry.toolbox?.tools ?? []).map((tool) => ({
              name: tool.name,
              use: tool.use,
              permission: tool.permission,
            })),
            // Whether those names are callables the agent editor can permission
            // one by one, or a prompt section reached through `exec`.
            exposesTools: entry.toolbox?.expose === 'tools',
            version: entry.toolbox?.version ?? '',
            image: entry.toolbox?.image ?? '',
            maxNetwork: entry.toolbox?.network.maxMode ?? 'none',
            capsAdded: [...(entry.toolbox?.caps.add ?? [])],
            // The same list the CLI review prints, so a browser and a terminal
            // cannot disagree about what a toolbox is asking for.
            weakened:
              entry.toolbox === undefined ? [] : [...weakenedIn(entry.toolbox)],
            approved: entry.approved,
            ...(entry.problem === undefined ? {} : { problem: entry.problem }),
          }));

        return { toolboxes: listed };
      },
    },
  };
}
