/**
 * The handlers, keyed by the manifest's route ids.
 *
 * Nothing here registers itself. `createRoutes` returns a
 * `Record<RouteId, RouteDefinition>`, the router walks `ROUTE_MANIFEST`, and
 * the two are joined by the id — so the type checker enforces that the set of
 * handlers and the set of served routes are the same set. A group that forgets
 * one of its ids fails here rather than 404ing later, because each group states
 * the ids it owns (`RouteGroup<…>`) instead of returning a string-keyed record.
 *
 * The handlers themselves live in `routes/`, one module per section of the API,
 * because twenty-nine of them in one file is a file nobody reads twice.
 */

import { authRoutes } from './routes/auth.js';
import { automationRoutes } from './routes/automation.js';
import { fileRoutes } from './routes/files.js';
import { mcpRoutes } from './routes/mcp.js';
import { notificationRoutes } from './routes/notifications.js';
import { providerRoutes } from './routes/providers.js';
import { sessionRoutes } from './routes/sessions.js';
import { settingsRoutes } from './routes/settings.js';
import { systemRoutes } from './routes/system.js';
import { agentRoutes } from './routes/agents.js';
import { skillRoutes } from './routes/skills.js';
import { toolboxRoutes } from './routes/toolboxes.js';
import { toolRoutes } from './routes/tools.js';
import type { RouteDefinition, RouteDeps } from './routes/types.js';
import { workspaceRoutes } from './routes/workspaces.js';
import { wsRoutes } from './routes/ws.js';
import type { RouteId } from './manifest.js';

export { LOGIN_ATTEMPTS_PER_MINUTE } from './routes/auth.js';
export { MAX_TEXT_BODY_BYTES, MAX_UPLOAD_BYTES } from './routes/files.js';
export { MAX_BUFFERED_BYTES } from './routes/ws.js';
export type {
  RouteDefinition,
  RouteDeps,
  RouteGroup,
  RouteRateLimit,
} from './routes/types.js';

export function createRoutes(
  deps: RouteDeps,
): Record<RouteId, RouteDefinition> {
  return {
    ...systemRoutes(deps),
    ...wsRoutes(deps),
    ...authRoutes(deps),
    ...settingsRoutes(deps),
    ...providerRoutes(deps),
    ...sessionRoutes(deps),
    ...agentRoutes(deps),
    ...toolRoutes(deps),
    ...skillRoutes(deps),
    ...toolboxRoutes(deps),
    ...mcpRoutes(deps),
    ...fileRoutes(deps),
    ...workspaceRoutes(deps),
    ...notificationRoutes(deps),
    ...automationRoutes(deps),
  };
}
