/**
 * The route tree.
 *
 * Written in TypeScript rather than generated from a file convention: the
 * generated route tree is a build artefact that has to be committed or
 * regenerated, and it buys convenience the five routes here do not need. This
 * file is the whole map of the application.
 *
 * The root route is the shell, so navigation never remounts the sidebar, the
 * header or — once Step 17 lands — the WebSocket that hangs off them.
 */

import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  type Router,
} from '@tanstack/react-router';
import type { JSX } from 'react';
import { z } from 'zod';

import { Shell } from './shell.js';
import { ChatRoute } from '@/routes/chat.js';
import { AgentEditorRoute } from '@/agents/agent-editor.js';
import { AgentsRoute } from '@/agents/agents-page.js';
import { ProviderEditorRoute } from '@/settings/provider-editor.js';
import { FilesRoute } from '@/routes/files.js';
import { WorkspacesRoute } from '@/routes/workspaces.js';
import { NotificationsRoute } from '@/routes/notifications.js';
import { SettingsRoute } from '@/routes/settings.js';
import { TokensRoute } from '@/routes/tokens.js';
import { NotFoundRoute } from '@/routes/not-found.js';

const rootRoute = createRootRoute({
  component: (): JSX.Element => (
    <Shell>
      <Outlet />
    </Shell>
  ),
  notFoundComponent: NotFoundRoute,
});

/**
 * `?session=` is validated, not read raw. The value ends up in a request path
 * and in a socket frame, and a router that hands components an unchecked
 * `string | string[] | undefined` is how one of those ends up with an array.
 */
const chatSearchSchema = z.object({ session: z.string().min(1).optional() });

const chatRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  validateSearch: chatSearchSchema,
  component: ChatRoute,
});

/**
 * The directory the file browser is showing, and the settings panel that is
 * open. Both are in the URL for the same reason `?session=` is: they are the
 * whole state of the screen, so a reload, a link and the Back button all work
 * without a store to keep in step with them.
 */
const filesSearchSchema = z.object({
  path: z.string().optional(),
  /**
   * Which workspace the path is in.
   *
   * In the URL rather than only in the workspace context, so a link to a file
   * is complete: half an address in someone else's `localStorage` is not a
   * shareable link. Absent means "whatever the switcher is on".
   */
  workspace: z.string().optional(),
});
const settingsSearchSchema = z.object({ panel: z.string().optional() });

const filesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/files',
  validateSearch: filesSearchSchema,
  component: FilesRoute,
});

const notificationsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/notifications',
  component: NotificationsRoute,
});

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings',
  validateSearch: settingsSearchSchema,
  component: SettingsRoute,
});

const agentsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/agents',
  component: AgentsRoute,
});

/**
 * No search schema: unlike Files, nothing about this page's location varies.
 * The filter and the sort are how the list is being read rather than where the
 * reader is, and there is no directory to be in.
 */
const workspacesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/workspaces',
  component: WorkspacesRoute,
});

const agentEditorRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/agents/$agentId',
  component: AgentEditorRoute,
});

/**
 * Under `/settings` rather than at the top level, because that is where the
 * list it belongs to lives — the back link returns to `?panel=providers`. A
 * sibling of `/settings` rather than a child route, exactly as the agent editor
 * is a sibling of `/agents`: the panel has a search schema this page does not
 * share, and nesting would make an endpoint's URL carry the list's tab.
 */
const providerEditorRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings/providers/$instanceId',
  component: ProviderEditorRoute,
});

const tokensRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/tokens',
  component: TokensRoute,
});

const routeTree = rootRoute.addChildren([
  chatRoute,
  agentsRoute,
  agentEditorRoute,
  workspacesRoute,
  filesRoute,
  notificationsRoute,
  settingsRoute,
  providerEditorRoute,
  tokensRoute,
]);

export function createAppRouter(): Router<typeof routeTree, 'never', true> {
  return createRouter({ routeTree, defaultPreload: 'intent' });
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
