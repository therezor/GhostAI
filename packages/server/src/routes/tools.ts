/**
 * The tools the model is currently offered.
 *
 * Read from the live registry rather than derived from the settings tree, and
 * the difference is the point: `tools.exec.enable: false` removes a tool, an MCP
 * server connecting adds several, and a plugin can add its own. What a settings
 * panel needs to show is what the model can actually call.
 */

import { ToolListResponseSchema, type ToolListResponse } from '@ghostai/protocol';

import type { RouteDeps, RouteGroup } from './types.js';

export function toolRoutes(deps: RouteDeps): RouteGroup<'tools.list'> {
  return {
    'tools.list': {
      summary: 'Every tool currently offered to the model',
      schema: { response: { 200: ToolListResponseSchema } },
      // Already sorted by name: the registry keeps that order so a reconnecting
      // MCP server cannot rewrite the cached prompt prefix.
      handler: (): ToolListResponse => ({ tools: [...deps.runtime.agent().tools] }),
    },
  };
}
