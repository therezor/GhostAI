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
import { FilesRoute } from '@/routes/files.js';
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

const filesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/files',
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
  component: SettingsRoute,
});

const tokensRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/tokens',
  component: TokensRoute,
});

const routeTree = rootRoute.addChildren([
  chatRoute,
  filesRoute,
  notificationsRoute,
  settingsRoute,
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
