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

/** The `modifiedAtMs` the editor loads, and therefore the one a save must send back. */
const LOADED_AT = 1_700_000_000_000;

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
    'GET /api/files/text': [
      200,
      {
        path: 'notes.md',
        content: 'hello from the workspace',
        sizeBytes: 24,
        modifiedAtMs: LOADED_AT,
        truncated: false,
      },
    ],
    'PUT /api/files/text': [
      200,
      {
        path: 'notes.md',
        name: 'notes.md',
        isDirectory: false,
        sizeBytes: 5,
        modifiedAtMs: LOADED_AT + 1000,
        mimeType: 'text/markdown; charset=utf-8',
      },
    ],
    'POST /api/files/directory': [
      201,
      {
        path: 'drafts',
        name: 'drafts',
        isDirectory: true,
        sizeBytes: 0,
        modifiedAtMs: LOADED_AT,
      },
    ],
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

  it('counts what a folder holds before asking to delete it', async () => {
    const { user, calls } = mount();
    await screen.findByRole('button', { name: 'notes.md' });

    await user.click(screen.getByRole('button', { name: 'Delete notes' }));
    const dialog = await screen.findByRole('dialog');

    // "Delete drafts?" and "Delete drafts and the things in it?" are different
    // questions, and only one of them is the one being asked.
    expect(dialog).toHaveTextContent('Delete this folder?');
    expect(await within(dialog).findByText(/1 item/)).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));

    await waitFor(() => {
      expect(calls.some((call) => call.method === 'DELETE')).toBe(true);
    });
    const request = calls.find((call) => call.method === 'DELETE');
    expect(request?.query.get('path')).toBe('notes');
    // The flag exists to stop a stray request from recursing, not to make the
    // UI ask twice — the dialog already said what goes.
    expect(request?.query.get('recursive')).toBe('true');
  });

  it('does not ask a file to recurse', async () => {
    const { user, calls } = mount();
    await screen.findByRole('button', { name: 'notes.md' });

    await user.click(screen.getByRole('button', { name: 'Delete notes.md' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }));

    await waitFor(() => {
      expect(calls.some((call) => call.method === 'DELETE')).toBe(true);
    });
    expect(calls.find((call) => call.method === 'DELETE')?.query.get('recursive')).toBeNull();
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
    expect(await screen.findByDisplayValue(/hello from the workspace/)).toBeInTheDocument();
    expect(document.querySelector('iframe')).toBeNull();
  });

  it('says so rather than failing when a directory cannot be listed', async () => {
    mount('/files', {
      'GET /api/files': [404, { error: { code: 'not_found', message: 'No such file: gone' } }],
    });

    expect(await screen.findByRole('alert')).toHaveTextContent('No such file: gone');
  });
});

// ---------------------------------------------------------------------------
// The editor
// ---------------------------------------------------------------------------

/** Opens `notes.md` and hands back its textarea. */
async function openEditor(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  await user.click(await screen.findByRole('button', { name: 'notes.md' }));
  return await screen.findByRole('textbox', { name: 'Contents of notes.md' });
}

describe('the file editor', () => {
  it('opens read-only, because opening a file is usually reading one', async () => {
    const { user } = mount();

    const textarea = await openEditor(user);

    // This tree is what an agent has been writing to. A textarea that is
    // already live is one stray keystroke away from editing the evidence.
    expect(textarea).toHaveAttribute('readonly');
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
  });

  it('saves the edited text with the timestamp it loaded', async () => {
    const { user, calls } = mount();
    const textarea = await openEditor(user);

    await user.click(screen.getByRole('button', { name: 'Edit' }));
    await user.clear(textarea);
    await user.type(textarea, 'edits');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(calls.some((call) => call.method === 'PUT')).toBe(true);
    });

    // The timestamp is the whole guard: without it, an editor left open through
    // a turn silently deletes whatever that turn wrote.
    expect(calls.find((call) => call.method === 'PUT')?.body).toEqual({
      path: 'notes.md',
      content: 'edits',
      expectedModifiedAtMs: LOADED_AT,
    });
  });

  it('keeps the edits and explains when the file moved under it', async () => {
    const { user } = mount('/files', {
      'PUT /api/files/text': [
        409,
        { error: { code: 'bad_request', message: 'Changed since it was read: notes.md' } },
      ],
    });
    const textarea = await openEditor(user);

    await user.click(screen.getByRole('button', { name: 'Edit' }));
    await user.clear(textarea);
    await user.type(textarea, 'mine');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('changed on disk');
    // The edits are still there to copy out. Dropping them on a conflict would
    // punish the reader for the agent's write.
    expect(textarea).toHaveValue('mine');
  });

  it('will not edit a truncated file, because saving a prefix deletes the rest', async () => {
    const { user } = mount('/files', {
      'GET /api/files/text': [
        200,
        {
          path: 'notes.md',
          content: 'the first part only',
          sizeBytes: 900_000,
          modifiedAtMs: LOADED_AT,
          truncated: true,
        },
      ],
    });

    const textarea = await openEditor(user);

    expect(textarea).toHaveAttribute('readonly');
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    expect(screen.getByText(/only the first part was read/)).toBeInTheDocument();
  });

  it('asks before closing on unsaved edits, and closing is what Escape does', async () => {
    const { user, calls } = mount();
    const textarea = await openEditor(user);

    await user.click(screen.getByRole('button', { name: 'Edit' }));
    await user.type(textarea, ' and more');
    await user.keyboard('{Escape}');

    expect(await screen.findByText('Discard your edits?')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(calls.some((call) => call.method === 'PUT')).toBe(false);
  });

  /**
   * The reason this route exists rather than a second read through the signed
   * URL: the server's MIME table is small, so `.py` and `.ts` are
   * `application/octet-stream` and would have been declared unpreviewable by a
   * browser-side type check.
   */
  it('offers the editor for a file the MIME table does not know', async () => {
    const { user, calls } = mount('/files', {
      'GET /api/files': [
        200,
        {
          path: '',
          entries: [
            {
              path: 'script.py',
              name: 'script.py',
              isDirectory: false,
              sizeBytes: 12,
              modifiedAtMs: LOADED_AT,
              mimeType: 'application/octet-stream',
            },
          ],
        },
      ],
      'GET /api/files/text': [
        200,
        {
          path: 'script.py',
          content: 'print("hi")',
          sizeBytes: 12,
          modifiedAtMs: LOADED_AT,
          truncated: false,
        },
      ],
    });

    await user.click(await screen.findByRole('button', { name: 'script.py' }));

    expect(await screen.findByDisplayValue('print("hi")')).toBeInTheDocument();
    expect(calls.some((call) => call.path === '/api/files/text')).toBe(true);
  });

  it('offers a download instead when the bytes turn out not to be text', async () => {
    const { user } = mount('/files', {
      'GET /api/files/text': [
        400,
        { error: { code: 'bad_request', message: 'Not a text file: notes.md' } },
      ],
    });

    await user.click(await screen.findByRole('button', { name: 'notes.md' }));

    expect(await screen.findByText(/not text/)).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: /Contents of/ })).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Creating, filtering and sorting
// ---------------------------------------------------------------------------

describe('creating entries', () => {
  it('creates a folder in the directory being looked at', async () => {
    const { user, calls } = mount('/files?path=notes');
    await screen.findByRole('button', { name: 'a.txt' });

    await user.click(screen.getByRole('button', { name: 'New folder' }));
    await user.type(screen.getByRole('textbox', { name: 'Folder name' }), 'drafts');
    await user.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => {
      expect(calls.some((call) => call.path === '/api/files/directory')).toBe(true);
    });
    // The full destination, not a name the server would have to place.
    expect(calls.find((call) => call.path === '/api/files/directory')?.body).toEqual({
      path: 'notes/drafts',
    });
  });

  it('creates an empty file and opens it', async () => {
    const { user, calls } = mount();
    await screen.findByRole('button', { name: 'notes.md' });

    await user.click(screen.getByRole('button', { name: 'New file' }));
    await user.type(screen.getByRole('textbox', { name: 'File name' }), 'notes.md');
    await user.click(screen.getByRole('button', { name: 'Create' }));

    const write = await waitFor(() => {
      const call = calls.find((entry) => entry.method === 'PUT');
      expect(call).toBeDefined();
      return call;
    });

    // Empty, and with no timestamp: there is nothing yet to conflict with, and
    // a placeholder line would be content the reader did not write.
    expect(write?.body).toEqual({ path: 'notes.md', content: '' });
    expect(await screen.findByRole('textbox', { name: 'Contents of notes.md' })).toBeVisible();
  });
});

describe('reading a large directory', () => {
  it('filters by name without asking the server again', async () => {
    const { user, calls } = mount();
    await screen.findByRole('button', { name: 'notes.md' });
    const before = calls.length;

    await user.type(screen.getByRole('searchbox', { name: 'Filter by name' }), 'shot');

    expect(screen.getByRole('button', { name: 'shot.png' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'notes.md' })).not.toBeInTheDocument();
    // One directory is already loaded; filtering it is not a round trip.
    expect(calls.length).toBe(before);
  });

  it('sorts by a column and announces which one', async () => {
    const { user } = mount();
    await screen.findByRole('button', { name: 'notes.md' });

    await user.click(screen.getByRole('button', { name: 'Size' }));

    const header = screen.getByRole('columnheader', { name: /Size/ });
    expect(header).toHaveAttribute('aria-sort', 'descending');

    // Directories stay first in every order — they are where to go next, not
    // small files — and the files behind them are largest first.
    const ordered = screen
      .getAllByRole('row')
      .slice(1)
      .map((row) => within(row).getAllByRole('button')[0]?.textContent ?? '');
    expect(ordered).toEqual(['notes', 'shot.png', 'notes.md']);
  });
});
