/**
 * Every tool that exists, for the screen that decides who may call them.
 *
 * Read from the live registry rather than derived from the settings tree, and
 * the difference is the point: `tools.exec.enable: false` removes a tool, an MCP
 * server connecting adds several, and a plugin can add its own.
 *
 * The registry, and deliberately not one agent's subset. This used to answer
 * with `runtime.agent().tools` — the *default* agent's advertised list — and the
 * only caller is the agent editor, which draws one permission row per entry. A
 * tool the default agent did not hold therefore had no row on any agent, so it
 * could never be granted to any agent: `automation`, which is absent from
 * `DEFAULT_AGENT_TOOLS` on purpose, was invisible everywhere. The same bug ran
 * the other way too — the default agent's toolbox programs and subagent
 * delegation tools appeared as grantable rows on agents that have neither.
 *
 * What one agent is actually offered is `AgentView.tools`, which the context
 * inspector reads per session and this route has no business restating.
 */

import { ToolListResponseSchema, type ToolListResponse } from '@ghostai/protocol';

import type { RouteDeps, RouteGroup } from './types.js';

export function toolRoutes(deps: RouteDeps): RouteGroup<'tools.list'> {
  return {
    'tools.list': {
      summary: 'Every tool the registry holds, whoever may call it',
      schema: { response: { 200: ToolListResponseSchema } },
      // Already sorted by name: the registry keeps that order so a reconnecting
      // MCP server cannot rewrite the cached prompt prefix.
      handler: (): ToolListResponse => ({ tools: [...deps.runtime.registeredTools()] }),
    },
  };
}
