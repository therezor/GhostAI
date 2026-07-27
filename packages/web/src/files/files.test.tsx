/**
 * The file browser, over the real router.
 *
 * What is worth driving here is the wiring between a path in the URL, a path in
 * a query string and a path in a signed URL — three places the same string has
 * to survive, and the browser is the only thing that proves it did. The
 * irreversible action gets its own case: delete asks first, and a cancelled
 * dialog sends nothing.
 */

import { RouterProvider, createMemoryHistory } from '@tanstack/react-router';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { Providers } from '@/app/providers.js';
import { createAppRouter } from '@/app/router.js';
import { stubApi, testQueryClient, type RecordedRequest, type StubRoute } from '@/test/render.js';

const ROOT_LISTING = {
  path: '',
  entries: [
    {
      path: 'notes',
      name: 'notes',
      isDirectory: true,
      sizeBytes: 0,
      modifiedAtMs: 1_700_000_000_000,
    },
    {
      path: 'shot.png',
      name: 'shot.png',
      isDirectory: false,
      sizeBytes: 2048,
      modifiedAtMs: 1_700_000_000_000,
      mimeType: 'image/png',
    },
    {
      path: 'notes.md',
      name: 'notes.md',
      isDirectory: false,
      sizeBytes: 12,
      modifiedAtMs: 1_700_000_000_000,
      mimeType: 'text/markdown; charset=utf-8',
    },
  ],
};

const NOTES_LISTING = {
  path: 'notes',
  entries: [
    {
      path: 'notes/a.txt',
      name: 'a.txt',
      isDirectory: false,
      sizeBytes: 3,
      modifiedAtMs: 1_700_000_000_000,
      mimeType: 'text/plain; charset=utf-8',
    },
  ],
};

const SHELL_ROUTES: Record<string, StubRoute> = {
  '/api/auth/me': [200, { authenticated: true, authEnabled: false }],
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
  '/api/notifications': [200, { notifications: [], unreadCount: 0 }],
};

function mount(
  path = '/files',
  overrides: Record<string, StubRoute> = {},
): {
  readonly user: ReturnType<typeof userEvent.setup>;
  readonly calls: RecordedRequest[];
  readonly router: ReturnType<typeof createAppRouter>;
} {
  const calls = stubApi({
    ...SHELL_ROUTES,
    // The listing answers per directory, which is what the navigation case
    // needs: a stub keyed only on the path could not tell the two apart.
    'GET /api/files': (request) =>
      request.query.get('path') === 'notes' ? [200, NOTES_LISTING] : [200, ROOT_LISTING],
    'DELETE /api/files': [204, null],
    'POST /api/files/upload': [
      201,
      { path: 'report.txt', sizeBytes: 5, mimeType: 'text/plain; charset=utf-8' },
    ],
    'POST /api/files/signed-url': [200, { url: '/api/media/tok', expiresAtMs: 9_999_999_999_999 }],
    '/api/media/tok': [200, 'hello from the workspace'],
    ...overrides,
  });

  const user = userEvent.setup();
  const router = createAppRouter();
  router.update({ history: createMemoryHistory({ initialEntries: [path] }) });
  render(
    <Providers client={testQueryClient()}>
      <RouterProvider router={router} />
    </Providers>,
  );

  return { user, calls, router };
}

describe('the file browser', () => {
  it('lists the workspace root and asks for it as `.`', async () => {
    const { calls } = mount();

    expect(await screen.findByRole('button', { name: 'notes.md' })).toBeInTheDocument();
    expect(screen.getByText('2.0 kB')).toBeInTheDocument();

    // `''` would reach the jail as an empty path: the query parameter's default
    // only applies when it is absent.
    const listing = calls.find((call) => call.path === '/api/files');
    expect(listing?.query.get('path')).toBe('.');
  });

  it('navigates into a directory, and back out through the breadcrumb', async () => {
    const { user, router } = mount();

    await user.click(await screen.findByRole('button', { name: 'notes' }));
    expect(await screen.findByRole('button', { name: 'a.txt' })).toBeInTheDocument();
    expect(router.state.location.searchStr).toContain('path=notes');

    const trail = screen.getByRole('navigation', { name: 'Breadcrumb' });
    await user.click(within(trail).getByRole('button', { name: 'workspace' }));

    expect(await screen.findByRole('button', { name: 'notes.md' })).toBeInTheDocument();
    expect(router.state.location.searchStr).not.toContain('path=');
  });

  it('shows the trail down to the directory it is in', async () => {
    mount('/files?path=notes');

    const trail = await screen.findByRole('navigation', { name: 'Breadcrumb' });
    expect(within(trail).getByRole('button', { name: 'workspace' })).toBeInTheDocument();
    // The current directory is text, not a link to where it already is.
    expect(within(trail).queryByRole('button', { name: 'notes' })).not.toBeInTheDocument();
    expect(trail).toHaveTextContent('notes');
  });

  it('uploads into the directory being looked at', async () => {
    const { user, calls } = mount('/files?path=notes');
    await screen.findByRole('button', { name: 'a.txt' });

    const file = new File(['hello'], 'report.txt', { type: 'text/plain' });
    await user.upload(screen.getByLabelText('Upload files'), file);

    await waitFor(() => {
      expect(calls.some((call) => call.path === '/api/files/upload')).toBe(true);
    });

    const upload = calls.find((call) => call.path === '/api/files/upload');
    // The full destination, not a name the server would have to place.
    expect(upload?.query.get('path')).toBe('notes/report.txt');
    // The raw bytes: a base64 or multipart envelope would inflate every upload
    // to describe what `Content-Type` already says.
    expect(upload?.body).toBeInstanceOf(File);
  });

  it('asks before deleting, and sends nothing when the answer is no', async () => {
    const { user, calls } = mount();
    await screen.findByRole('button', { name: 'notes.md' });

    await user.click(screen.getByRole('button', { name: 'Delete notes.md' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('There is no undo');

    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(calls.some((call) => call.method === 'DELETE')).toBe(false);
  });

  it('deletes the file the dialog named', async () => {
    const { user, calls } = mount();
    await screen.findByRole('button', { name: 'notes.md' });

    await user.click(screen.getByRole('button', { name: 'Delete notes.md' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));

    await waitFor(() => {
      expect(calls.some((call) => call.method === 'DELETE')).toBe(true);
    });
    expect(calls.find((call) => call.method === 'DELETE')?.query.get('path')).toBe('notes.md');
  });

  it('offers no delete for a directory, which the server refuses anyway', async () => {
    mount();
    await screen.findByRole('button', { name: 'notes.md' });

    expect(screen.queryByRole('button', { name: 'Delete notes' })).not.toBeInTheDocument();
  });

  it('previews an image through a signed URL rather than a public route', async () => {
    const { user, calls } = mount();

    await user.click(await screen.findByRole('button', { name: 'shot.png' }));

    const image = await screen.findByRole('img', { name: 'shot.png' });
    expect(image).toHaveAttribute('src', '/api/media/tok');

    // The path travels in a body, not a query string: a workspace path in a URL
    // is written to every access log between here and the server.
    const signing = calls.find((call) => call.path === '/api/files/signed-url');
    expect(signing?.method).toBe('POST');
    expect(signing?.body).toEqual({ path: 'shot.png' });
  });

  it('reads a text file into the page rather than framing it', async () => {
    const { user } = mount();

    await user.click(await screen.findByRole('button', { name: 'notes.md' }));

    // The workspace holds model-authored files; an iframe would execute one.
    expect(await screen.findByText(/hello from the workspace/)).toBeInTheDocument();
    expect(document.querySelector('iframe')).toBeNull();
  });

  it('says so rather than failing when a directory cannot be listed', async () => {
    mount('/files', {
      'GET /api/files': [404, { error: { code: 'not_found', message: 'No such file: gone' } }],
    });

    expect(await screen.findByRole('alert')).toHaveTextContent('No such file: gone');
  });
});
