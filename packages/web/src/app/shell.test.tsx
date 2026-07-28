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
import { stubApi, testQueryClient, type RecordedRequest } from '@/test/render.js';

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
      seq: 1,
      createdAtMs: 1,
      turnId: 't1',
      message: { role: 'user', content: [{ type: 'text', text: 'a stored question' }] },
    },
  ],
};

function renderApp(initial = '/'): {
  readonly user: ReturnType<typeof userEvent.setup>;
  readonly calls: RecordedRequest[];
} {
  // `stubApi` rather than `stubFetch` for its request log: "New session writes
  // nothing" is an assertion about what was *not* sent.
  const calls = stubApi({
    '/api/auth/me': [200, { authenticated: true, authEnabled: false }],
    // Claimed: the setup overlay mounts above the login one and would
    // otherwise be deciding whether to open on an unstubbed request.
    '/api/setup': [200, { required: false }],
    '/api/status': [200, STATUS],
    '/api/sessions': [200, SESSIONS],
    '/api/notifications': [
      200,
      {
        notifications: [
          {
            id: 'n1',
            title: 'A turn failed',
            body: 'The provider rate limited the request.',
            level: 'error',
            createdAtMs: Date.now(),
          },
        ],
        unreadCount: 3,
      },
    ],
    '/api/sessions/web%3A7/messages': [200, MESSAGES],
  });

  const router = createAppRouter();
  router.update({ history: createMemoryHistory({ initialEntries: [initial] }) });

  render(
    <Providers client={testQueryClient()}>
      <RouterProvider router={router} />
    </Providers>,
  );

  return { user: userEvent.setup(), calls };
}

describe('the shell', () => {
  it('renders the sidebar, the route and what the agent is running', async () => {
    renderApp();

    // The chat route on an empty session is the welcome screen.
    expect(await screen.findByRole('heading', { name: 'Ready when you are.' })).toBeInTheDocument();
    expect(await screen.findByText('ollama · test-model')).toBeInTheDocument();

    // "New session" replaced the Chat nav link, which navigated nowhere: it
    // dropped `?session=` from a route that reads the store rather than the
    // URL, and the next message put the key straight back.
    const sidebar = screen.getByRole('complementary', { name: 'Sidebar' });
    expect(within(sidebar).getByRole('button', { name: 'New session' })).toBeInTheDocument();
    expect(within(sidebar).queryByRole('link', { name: /^Chat$/ })).not.toBeInTheDocument();
  });

  it('lists sessions in the sidebar and unread notifications in the header', async () => {
    renderApp();

    expect(await screen.findByText('First conversation')).toBeInTheDocument();
    // The count is in the bell's accessible name rather than drawn as a badge:
    // "3" beside an icon is not a sentence a screen reader can use.
    expect(
      await screen.findByRole('button', { name: 'Notifications, 3 unread' }),
    ).toBeInTheDocument();
  });

  it('opens recent notifications from the header, with a way to the full list', async () => {
    const { user } = renderApp();

    await user.click(await screen.findByRole('button', { name: /^Notifications/ }));

    expect(await screen.findByText('A turn failed')).toBeInTheDocument();
    // The glance is not a replacement for the archive.
    expect(screen.getByRole('link', { name: 'See all' })).toHaveAttribute('href', '/notifications');
  });

  it('starts a conversation without saving an empty one', async () => {
    const { user, calls } = renderApp();

    const sidebar = await screen.findByRole('complementary', { name: 'Sidebar' });
    const before = calls.length;
    await user.click(within(sidebar).getByRole('button', { name: 'New session' }));

    // The URL moves to a key minted on the client, so the click can navigate to
    // it — but nothing is written. A row created on the press is a row that
    // survives someone changing their mind, and the sidebar fills with empty
    // conversations. The agent loop creates it when the first message lands.
    await waitFor(() => {
      expect(useTurnStore.getState().sessionKey).toMatch(/^web-/u);
    });
    expect(calls.slice(before).filter((call) => call.method === 'POST')).toEqual([]);
  });

  it('names a conversation rather than showing its key', async () => {
    renderApp();

    expect(await screen.findByText('First conversation')).toBeInTheDocument();
    // The complaint this fixes: a list of uuids is not a list of conversations.
    const sidebar = screen.getByRole('complementary', { name: 'Sidebar' });
    expect(within(sidebar).queryByText('web:1')).not.toBeInTheDocument();
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
