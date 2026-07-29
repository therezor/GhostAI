/**
 * The switcher, the workspaces page and the query keys that keep them apart.
 *
 * The cache test is the one that matters most: two workspaces both contain
 * `notes.md`, so a key that forgot the workspace would serve one workspace's
 * listing for the other the instant the switcher moved — silently, and only in
 * a browser.
 */

import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { queryKeys } from '@/lib/query.js';
import { WorkspacesRoute } from '@/routes/workspaces.js';
import { renderWithProviders, stubApi } from '@/test/render.js';
import { WorkspaceSwitcher } from './workspace-switcher.js';
import { DEFAULT_WORKSPACE_ID } from './workspace-context.js';

function workspace(id: string, name: string, extra: Record<string, unknown> = {}): unknown {
  return {
    id,
    name,
    isDefault: id === DEFAULT_WORKSPACE_ID,
    createdAtMs: 1,
    updatedAtMs: 1,
    sessionCount: 0,
    ...extra,
  };
}

const TWO = {
  workspaces: [workspace('default', 'Default'), workspace('acme', 'Client Acme')],
};

/**
 * `localStorage`, stubbed per file rather than taken from the environment.
 *
 * The same reasoning `setup.ts` gives for `sessionStorage`: Node ships an
 * experimental global that shadows jsdom's and is inert, so a `setItem`
 * succeeds and the `getItem` after it returns null — which reads as a bug in
 * the code under test. Persisting a choice across a page reload should also not
 * mean persisting it across a test.
 */
beforeEach(() => {
  const entries = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    get length() {
      return entries.size;
    },
    clear: () => {
      entries.clear();
    },
    getItem: (key: string) => entries.get(key) ?? null,
    key: (index: number) => [...entries.keys()][index] ?? null,
    removeItem: (key: string) => entries.delete(key),
    setItem: (key: string, value: string) => entries.set(key, value),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('query keys', () => {
  it('put the workspace before the path, so two workspaces never share an entry', () => {
    expect(queryKeys.files('acme', 'notes.md')).not.toEqual(
      queryKeys.files('research', 'notes.md'),
    );
    expect(queryKeys.fileText('acme', 'notes.md')).not.toEqual(
      queryKeys.fileText('research', 'notes.md'),
    );
    expect(queryKeys.fileUrl('acme', 'x.png')).not.toEqual(queryKeys.fileUrl('research', 'x.png'));
  });

  it('keep the workspace at index 1, so a prefix invalidation still means something', () => {
    for (const key of [
      queryKeys.files('acme', 'a'),
      queryKeys.fileText('acme', 'a'),
      queryKeys.fileUrl('acme', 'a'),
    ]) {
      expect(key[1]).toBe('acme');
    }
  });

  it('keep the scoped session list under the unscoped prefix', () => {
    // One `invalidateQueries({ queryKey: ['sessions'] })` after a turn has to
    // reach whichever workspace is on screen.
    expect(queryKeys.sessions('acme')[0]).toBe(queryKeys.sessions()[0]);
  });
});

/**
 * The switcher, over a router that is only as big as it needs to be.
 *
 * It carries a `<Link>` to `/workspaces` now — a real link rather than a
 * dialog trigger, so middle-click and open-in-new-tab work — and a `Link`
 * outside a router throws. Two routes is enough to give it one; mounting the
 * whole application to assert that a menu lists two names would be testing the
 * shell again, which `shell.test.tsx` already does.
 */
function renderSwitcher(): ReturnType<typeof renderWithProviders> {
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => <WorkspaceSwitcher />,
  });
  const workspacesRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/workspaces',
    component: () => <p>workspaces</p>,
  });

  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, workspacesRoute]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });

  return renderWithProviders(<RouterProvider router={router as never} />);
}

describe('the workspace switcher', () => {
  it('names the current workspace and lists the others', async () => {
    stubApi({ 'GET /api/workspaces': [200, TWO] });
    renderSwitcher();

    await screen.findByRole('button', { name: /Workspace: Default/ });
    await userEvent.click(screen.getByRole('button', { name: /Workspace: Default/ }));

    expect(await screen.findByRole('menuitemradio', { name: /Client Acme/ })).toBeInTheDocument();
  });

  it('does not repeat what the workspaces page already explains', async () => {
    // `default` containing the others is explained once, on the page this menu
    // links to. A standing paragraph under the trigger restated the most
    // ordinary state in the app on every render of the sidebar.
    stubApi({ 'GET /api/workspaces': [200, TWO] });
    renderSwitcher();

    expect(await screen.findByRole('button', { name: /^Workspace: / })).toBeInTheDocument();
    expect(screen.queryByText(/reach their files/)).not.toBeInTheDocument();
  });

  it('sends you to the page rather than opening a dialog', async () => {
    stubApi({ 'GET /api/workspaces': [200, TWO] });
    renderSwitcher();

    await userEvent.click(await screen.findByRole('button', { name: /^Workspace: / }));

    // A link, so it can be middle-clicked and opened in a new tab — which a
    // `<button>` that set some state could never be.
    expect(await screen.findByRole('menuitem', { name: /Manage workspaces/ })).toHaveAttribute(
      'href',
      '/workspaces',
    );
  });

  it('remembers the choice across a remount', async () => {
    stubApi({ 'GET /api/workspaces': [200, TWO] });
    const first = renderSwitcher();

    await userEvent.click(await screen.findByRole('button', { name: /Workspace: Default/ }));
    await userEvent.click(await screen.findByRole('menuitemradio', { name: /Client Acme/ }));
    first.unmount();

    renderSwitcher();
    expect(
      await screen.findByRole('button', { name: /Workspace: Client Acme/ }),
    ).toBeInTheDocument();
  });
});

describe('the workspaces page', () => {
  /** Opens the kebab for one row and returns nothing — the menu is on screen. */
  async function openActions(name: string): Promise<void> {
    await userEvent.click(await screen.findByRole('button', { name: `Actions for ${name}` }));
  }

  it('creates one from a name, never a path', async () => {
    const calls = stubApi({
      'GET /api/workspaces': [200, TWO],
      'POST /api/workspaces': [201, workspace('research', 'Research')],
    });
    renderWithProviders(<WorkspacesRoute />);

    await userEvent.click(await screen.findByRole('button', { name: 'New workspace' }));
    await userEvent.type(await screen.findByLabelText('Name'), 'Research');
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => {
      expect(calls.some((call) => call.method === 'POST')).toBe(true);
    });
    expect(calls.find((call) => call.method === 'POST')?.body).toEqual({ name: 'Research' });
  });

  it('renames one from the row menu', async () => {
    const calls = stubApi({
      'GET /api/workspaces': [200, TWO],
      'PATCH /api/workspaces/acme': [200, workspace('acme', 'Acme Ltd')],
    });
    renderWithProviders(<WorkspacesRoute />);

    await openActions('Client Acme');
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Rename' }));

    const field = await screen.findByLabelText('Name');
    expect(field).toHaveValue('Client Acme');

    await userEvent.clear(field);
    await userEvent.type(field, 'Acme Ltd{Enter}');

    await waitFor(() => {
      expect(calls.find((call) => call.method === 'PATCH')?.body).toEqual({ name: 'Acme Ltd' });
    });
  });

  it('cannot delete the default, because it is the parent of the others', async () => {
    stubApi({ 'GET /api/workspaces': [200, TWO] });
    renderWithProviders(<WorkspacesRoute />);

    await openActions('Default');

    expect(await screen.findByRole('menuitem', { name: 'Rename' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Delete' })).not.toBeInTheDocument();
  });

  it('asks before deleting, and sends nothing until the answer is yes', async () => {
    // The behaviour the dialog never had: a delete used to fire on the single
    // click of an icon sitting next to Rename.
    const calls = stubApi({ 'GET /api/workspaces': [200, TWO] });
    renderWithProviders(<WorkspacesRoute />);

    await openActions('Client Acme');
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }));

    expect(await screen.findByText(/Its folder and everything in it stays on disk/)).toBeVisible();
    expect(calls.some((call) => call.method === 'DELETE')).toBe(false);

    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(calls.some((call) => call.method === 'DELETE')).toBe(false);
  });

  it('offers to move the conversations when a delete is refused, then deletes', async () => {
    let refused = true;
    const calls = stubApi({
      'GET /api/workspaces': [200, TWO],
      'DELETE /api/workspaces/acme': () =>
        refused
          ? [
              409,
              {
                error: {
                  code: 'conflict',
                  message: '2 sessions still use this workspace',
                  retryable: false,
                  details: { sessionCount: 2 },
                },
              },
            ]
          : [204, null],
      'POST /api/workspaces/acme/sessions/move': () => {
        refused = false;
        return [200, { moved: 2 }];
      },
    });
    renderWithProviders(<WorkspacesRoute />);

    await openActions('Client Acme');
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Delete' }));

    // The 409 is a question, not a failure: the count it carries is what the
    // offer is made out of.
    expect(
      await screen.findByText(/2 conversations still belong to Client Acme/),
    ).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Move and delete' }));

    await waitFor(() => {
      expect(calls.filter((call) => call.method === 'DELETE')).toHaveLength(2);
    });
    expect(calls.some((call) => call.path === '/api/workspaces/acme/sessions/move')).toBe(true);
  });

  it('explains what a workspace is, once, where someone is reading about them', async () => {
    stubApi({ 'GET /api/workspaces': [200, TWO] });
    renderWithProviders(<WorkspacesRoute />);

    expect(await screen.findByText(/cannot reach each other/)).toBeInTheDocument();
  });

  it('keeps the default at the top however the list is sorted', async () => {
    stubApi({ 'GET /api/workspaces': [200, TWO] });
    renderWithProviders(<WorkspacesRoute />);

    const firstCell = async (): Promise<string> => {
      const rows = await screen.findAllByRole('row');
      // `rows[0]` is the header.
      return rows[1]?.textContent ?? '';
    };

    expect(await firstCell()).toContain('Default');

    await userEvent.click(screen.getByRole('button', { name: 'Name' }));
    expect(await firstCell()).toContain('Default');
  });
});
