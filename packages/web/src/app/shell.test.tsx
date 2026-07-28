/**
 * The shell, mounted over the real router and the real Query client.
 *
 * A shell test that stubbed the router would assert that a layout renders,
 * which is not where shells go wrong. What goes wrong is the wiring: a
 * navigation that remounts the sidebar, a drawer that traps a phone user, a
 * connection badge that never announces, a route that renders nothing when its
 * query is a 401. So this drives the real thing through `fetch`.
 */

import { RouterProvider, createMemoryHistory } from '@tanstack/react-router';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { Providers } from './providers.js';
import { createAppRouter } from './router.js';
import { useTurnStore } from '@/state/turn.js';
import { stubFetch, testQueryClient } from '@/test/render.js';

const STATUS = {
  version: '0.0.0',
  protocolVersion: 1,
  uptimeMs: 1,
  model: 'test-model',
  provider: 'ollama',
  configured: true,
  workspaceId: 'default',
  workspaceCount: 1,
  authEnabled: false,
  toolCount: 3,
  mcpServersConnected: 0,
  pluginsLoaded: 0,
};

const SESSIONS = {
  sessions: [
    {
      key: 'web:1',
      title: 'First conversation',
      messageCount: 2,
      createdAtMs: 1,
      updatedAtMs: 2,
      origin: 'web',
    },
  ],
};

const MESSAGES = {
  sessionKey: 'web:7',
  messages: [
    {
      id: 'm1',
      sessionKey: 'web:7',
      createdAtMs: 1,
      turnId: 't1',
      message: { role: 'user', content: [{ type: 'text', text: 'a stored question' }] },
    },
  ],
};

function renderApp(initial = '/'): { readonly user: ReturnType<typeof userEvent.setup> } {
  stubFetch({
    '/api/auth/me': [200, { authenticated: true, authEnabled: false }],
    // Claimed: the setup overlay mounts above the login one and would
    // otherwise be deciding whether to open on an unstubbed request.
    '/api/setup': [200, { required: false }],
    '/api/status': [200, STATUS],
    '/api/sessions': [200, SESSIONS],
    '/api/notifications': [200, { notifications: [], unreadCount: 3 }],
    '/api/sessions/web%3A7/messages': [200, MESSAGES],
  });

  const router = createAppRouter();
  router.update({ history: createMemoryHistory({ initialEntries: [initial] }) });

  render(
    <Providers client={testQueryClient()}>
      <RouterProvider router={router} />
    </Providers>,
  );

  return { user: userEvent.setup() };
}

describe('the shell', () => {
  it('renders the sidebar, the route and what the agent is running', async () => {
    renderApp();

    // The chat route on an empty session is the welcome screen.
    expect(await screen.findByRole('heading', { name: 'Ready when you are.' })).toBeInTheDocument();
    expect(await screen.findByText('ollama · test-model')).toBeInTheDocument();

    const sidebar = screen.getByRole('complementary', { name: 'Sidebar' });
    expect(within(sidebar).getByRole('link', { name: /Chat/ })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('lists sessions and unread notifications from the server', async () => {
    renderApp();

    expect(await screen.findByText('First conversation')).toBeInTheDocument();
    const sidebar = screen.getByRole('complementary', { name: 'Sidebar' });
    expect(within(sidebar).getByText('3')).toBeInTheDocument();
  });

  it('navigates without unmounting the shell around it', async () => {
    const { user } = renderApp();

    const sidebar = await screen.findByRole('complementary', { name: 'Sidebar' });
    const header = screen.getByRole('banner');

    await user.click(within(sidebar).getByRole('link', { name: /Settings/ }));

    expect(await screen.findByRole('heading', { name: 'Settings' })).toBeInTheDocument();
    // The same nodes, not replacements: a remount here would drop the socket
    // that Step 17 hangs off the shell.
    expect(screen.getByRole('banner')).toBe(header);
    expect(screen.getByRole('complementary', { name: 'Sidebar' })).toBe(sidebar);
  });

  it('reports the socket state in a live region', async () => {
    renderApp();

    // The shell opens the socket on mount, so the badge starts at Connecting
    // rather than Offline — `test/setup.ts` supplies a socket that never opens.
    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent('Connecting');

    useTurnStore.getState().setConnection('open');
    await waitFor(() => {
      expect(status).toHaveTextContent('Connected');
    });
  });

  it('opens the sidebar in a dialog on a narrow screen, and closes it on navigation', async () => {
    const { user } = renderApp();

    await user.click(await screen.findByRole('button', { name: 'Open menu' }));

    const drawer = await screen.findByRole('dialog');
    await user.click(within(drawer).getByRole('link', { name: /Files/ }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(await screen.findByRole('heading', { name: 'Files' })).toBeInTheDocument();
  });

  it('answers an unknown address with a way back', async () => {
    const { user } = renderApp('/does-not-exist');

    expect(await screen.findByRole('heading', { name: 'Not found' })).toBeInTheDocument();

    await user.click(screen.getByRole('link', { name: 'Back to chat' }));
    expect(await screen.findByRole('heading', { name: 'Ready when you are.' })).toBeInTheDocument();
  });

  it('validates ?session= rather than handing a component whatever was in the URL', async () => {
    renderApp('/?session=web%3A7');

    // The decoded key reached the history fetch, which is the only thing that
    // proves the router parsed it rather than passing the raw parameter along.
    expect(await screen.findByText('a stored question')).toBeInTheDocument();
  });
});
