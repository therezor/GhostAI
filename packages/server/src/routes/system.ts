/**
 * Liveness, what is running, and the generated document.
 *
 * `GET /api/status` answers "what would a turn do right now" rather than "what
 * does the config file say": the model and provider come from the loop that
 * would run it, so a settings save that failed to take effect is visible here
 * instead of being invisible until the next answer comes back from the wrong
 * model.
 */

import type { DatabaseSync } from 'node:sqlite';

import {
  HealthResponseSchema,
  PROTOCOL_VERSION,
  StatusResponseSchema,
  type HealthResponse,
  type StatusResponse,
} from '@ghostai/protocol';
import { DEFAULT_WORKSPACE_ID, systemClock } from '@ghostai/core';

import { SERVER_VERSION } from '../version.js';
import type { RouteDeps, RouteGroup } from './types.js';

type SystemRouteId = 'system.health' | 'system.status' | 'system.openapi';

/** `SELECT 1` — the cheapest statement that proves the file is still readable. */
function databaseHealthy(database: DatabaseSync): boolean {
  try {
    database.prepare('SELECT 1').get();
    return true;
  } catch {
    return false;
  }
}

export function systemRoutes(deps: RouteDeps): RouteGroup<SystemRouteId> {
  const clock = deps.clock ?? systemClock;

  return {
    'system.health': {
      summary: 'Liveness and the checks behind it',
      schema: { response: { 200: HealthResponseSchema } },
      handler: (): HealthResponse => {
        const storage = databaseHealthy(deps.database);
        return {
          // `fail` rather than `degraded`: with no database there is no session
          // to write a turn into, so nothing the server does still works.
          status: storage ? 'ok' : 'fail',
          checks: [
            {
              name: 'database',
              status: storage ? 'ok' : 'fail',
              detail: storage ? '' : 'the session database is not readable',
            },
          ],
        };
      },
    },

    'system.status': {
      summary: 'Version, uptime, and what a turn would use right now',
      schema: { response: { 200: StatusResponseSchema } },
      handler: (): StatusResponse => {
        const agent = deps.runtime.agent();
        const extensions = deps.runtime.extensions();
        return {
          version: SERVER_VERSION,
          protocolVersion: PROTOCOL_VERSION,
          // Monotonic: an NTP correction must not make a process look like it
          // started in the future.
          uptimeMs: Math.max(0, Math.round(clock.monotonic() - deps.startedAt)),
          model: agent.model,
          provider: agent.provider,
          configured: agent.configured,
          // The id, never the path. `agent.jail.root` used to be reported here
          // — an absolute host path handed to every authenticated client,
          // naming the operator's account and directory layout, which is the
          // one string that turns a blind traversal attempt into a targeted
          // one. The banner on the terminal still prints it; a terminal on the
          // host is not a network boundary.
          workspaceId: DEFAULT_WORKSPACE_ID,
          workspaceCount: deps.runtime.workspaces.list().length,
          // From the boot config, not the live one: this reports whether the
          // running listener authenticates, and that is not something a settings
          // save can change under an already-authenticated session.
          authEnabled: deps.config.server.auth.enabled,
          toolCount: agent.tools.length,
          mcpServersConnected: extensions.mcpServersConnected,
          extensionsLoaded: extensions.extensionsLoaded,
        };
      },
    },

    'system.openapi': {
      summary: 'The generated OpenAPI 3.1 document',
      schema: {},
      handler: (): unknown => deps.openapiDocument(),
    },
  };
}
