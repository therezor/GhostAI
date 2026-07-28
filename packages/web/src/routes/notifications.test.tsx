/**
 * The notification centre.
 *
 * The case that matters is the badge: marking one row read has to leave the
 * count telling the truth, and the arithmetic is easy to get subtly wrong —
 * decrementing works until the same row is marked read from two tabs, at which
 * point the badge reads one fewer than there are. It is recounted instead, and
 * this is where that is asserted.
 */

import { RouterProvider, createMemoryHistory } from '@tanstack/react-router';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { Providers } from '@/app/providers.js';
import { createAppRouter } from '@/app/router.js';
import { stubApi, testQueryClient, type RecordedRequest, type StubRoute } from '@/test/render.js';

const UNREAD = {
  id: 'n1',
  title: 'Nightly digest finished',
  body: 'Wrote notes/digest.md',
  level: 'success',
  createdAtMs: Date.now() - 120_000,
  sessionKey: 'web:9',
};

const READ = {
  id: 'n2',
  title: 'Approval expired',
  body: 'exec was denied after 5 minutes',
  level: 'warning',
  createdAtMs: Date.now() - 7_200_000,
  readAtMs: Date.now() - 3_600_000,
};

const LIST = { notifications: [UNREAD, READ], unreadCount: 1 };

const SHELL_ROUTES: Record<string, StubRoute> = {
  '/api/auth/me': [200, { authenticated: true, authEnabled: false }],
  // Claimed: the setup overlay mounts above the login one and would
  // otherwise be deciding whether to open on an unstubbed request.
  '/api/setup': [200, { required: false }],
  '/api/status': [
    200,
    {
      version: '0.0.0',
      protocolVersion: 1,
      uptimeMs: 1,
      model: 'llama3',
      provider: 'ollama',
      workspace: '/tmp/w',
      authEnabled: false,
      toolCount: 0,
      mcpServersConnected: 0,
      pluginsLoaded: 0,
    },
  ],
  '/api/sessions': [200, { sessions: [] }],
};

function mount(overrides: Record<string, StubRoute> = {}): {
  readonly user: ReturnType<typeof userEvent.setup>;
  readonly calls: RecordedRequest[];
} {
  const calls = stubApi({
    ...SHELL_ROUTES,
    '/api/notifications': [200, LIST],
    'POST /api/notifications/n1/read': [200, { ...UNREAD, readAtMs: Date.now() }],
    'POST /api/notifications/read': [204, null],
    'DELETE /api/notifications/n1': [204, null],
    ...overrides,
  });

  const user = userEvent.setup();
  const router = createAppRouter();
  router.update({ history: createMemoryHistory({ initialEntries: ['/notifications'] }) });
  render(
    <Providers client={testQueryClient()}>
      <RouterProvider router={router} />
    </Providers>,
  );

  return { user, calls };
}

describe('the notification centre', () => {
  it('lists what the server reported, newest first, with the unread count', async () => {
    mount();

    const list = await screen.findByRole('article', { name: 'Nightly digest finished' });
    expect(list).toHaveTextContent('Wrote notes/digest.md');
    expect(screen.getByRole('article', { name: 'Approval expired' })).toBeInTheDocument();
    // The header count and the sidebar badge read the same query.
    expect(screen.getAllByText('1 unread').length).toBeGreaterThan(0);
  });

  it('offers to open the conversation a notification came from', async () => {
    mount();

    const row = await screen.findByRole('article', { name: 'Nightly digest finished' });
    const link = within(row).getByRole('link', { name: 'Open the conversation' });
    expect(link).toHaveAttribute('href', expect.stringContaining('session=web%3A9'));
  });

  it('marks one read and recounts the badge rather than decrementing it', async () => {
    const { user, calls } = mount();

    const row = await screen.findByRole('article', { name: 'Nightly digest finished' });
    await user.click(within(row).getByRole('button', { name: 'Mark read' }));

    await waitFor(() => {
      expect(screen.getByText('All caught up')).toBeInTheDocument();
    });

    expect(calls.some((call) => call.path === '/api/notifications/n1/read')).toBe(true);
    // The row that was already read has no button to press, so a second press
    // cannot drive the count below zero.
    expect(screen.queryByRole('button', { name: 'Mark read' })).not.toBeInTheDocument();
  });

  it('marks everything read in one press, and offers it only when there is something to mark', async () => {
    const { user, calls } = mount();

    const markAll = await screen.findByRole('button', { name: 'Mark all read' });
    await user.click(markAll);

    await waitFor(() => {
      expect(calls.some((call) => call.path === '/api/notifications/read')).toBe(true);
    });
  });

  it('disables mark-all when nothing is unread', async () => {
    mount({ '/api/notifications': [200, { notifications: [READ], unreadCount: 0 }] });

    expect(await screen.findByRole('button', { name: 'Mark all read' })).toBeDisabled();
  });

  it('deletes one', async () => {
    const { user, calls } = mount();

    await screen.findByRole('article', { name: 'Nightly digest finished' });
    await user.click(screen.getByRole('button', { name: 'Delete “Nightly digest finished”' }));

    await waitFor(() => {
      expect(calls.some((call) => call.method === 'DELETE')).toBe(true);
    });
    expect(calls.find((call) => call.method === 'DELETE')?.path).toBe('/api/notifications/n1');
  });

  it('explains an empty list rather than showing an empty box', async () => {
    mount({ '/api/notifications': [200, { notifications: [], unreadCount: 0 }] });

    expect(await screen.findByText('Nothing here yet.')).toBeInTheDocument();
  });

  it('says so when the list cannot be loaded', async () => {
    mount({
      '/api/notifications': [500, { error: { code: 'internal', message: 'database is locked' } }],
    });

    expect(await screen.findByRole('alert')).toHaveTextContent('database is locked');
  });
});
