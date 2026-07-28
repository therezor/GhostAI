/**
 * The switcher, the manager and the query keys that keep them apart.
 *
 * The cache test is the one that matters most: two workspaces both contain
 * `notes.md`, so a key that forgot the workspace would serve one workspace's
 * listing for the other the instant the switcher moved — silently, and only in
 * a browser.
 */

import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { queryKeys } from '@/lib/query.js';
import { renderWithProviders, stubApi } from '@/test/render.js';
import { WorkspaceManager } from './workspace-manager.js';
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
    clear: () => { entries.clear(); },
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

describe('the workspace switcher', () => {
  it('names the current workspace and lists the others', async () => {
    stubApi({ 'GET /api/workspaces': [200, TWO] });
    renderWithProviders(<WorkspaceSwitcher />);

    await screen.findByRole('button', { name: /Workspace: Default/ });
    await userEvent.click(screen.getByRole('button', { name: /Workspace: Default/ }));

    expect(await screen.findByRole('menuitemradio', { name: /Client Acme/ })).toBeInTheDocument();
  });

  it('says that the default reaches every other workspace', async () => {
    // Not decoration: `default` is the folder that contains the others, so a
    // user who has not been told will assume an isolation that is not there.
    stubApi({ 'GET /api/workspaces': [200, TWO] });
    renderWithProviders(<WorkspaceSwitcher />);

    expect(await screen.findByText(/reach their files/)).toBeInTheDocument();
  });

  it('remembers the choice across a remount', async () => {
    stubApi({ 'GET /api/workspaces': [200, TWO] });
    const first = renderWithProviders(<WorkspaceSwitcher />);

    await userEvent.click(await screen.findByRole('button', { name: /Workspace: Default/ }));
    await userEvent.click(await screen.findByRole('menuitemradio', { name: /Client Acme/ }));
    first.unmount();

    renderWithProviders(<WorkspaceSwitcher />);
    expect(await screen.findByRole('button', { name: /Workspace: Client Acme/ })).toBeInTheDocument();
  });
});

describe('the workspace manager', () => {
  it('creates one from a name, never a path', async () => {
    const calls = stubApi({
      'GET /api/workspaces': [200, TWO],
      'POST /api/workspaces': [201, workspace('research', 'Research')],
    });
    renderWithProviders(<WorkspaceManager open onOpenChange={() => undefined} />);

    await userEvent.type(await screen.findByLabelText('New workspace'), 'Research');
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() => {
      expect(calls.some((call) => call.method === 'POST')).toBe(true);
    });
    expect(calls.find((call) => call.method === 'POST')?.body).toEqual({ name: 'Research' });
  });

  it('cannot remove the default', async () => {
    stubApi({ 'GET /api/workspaces': [200, TWO] });
    renderWithProviders(<WorkspaceManager open onOpenChange={() => undefined} />);

    expect(await screen.findByRole('button', { name: 'Remove Default' })).toBeDisabled();
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
    renderWithProviders(<WorkspaceManager open onOpenChange={() => undefined} />);

    await userEvent.click(await screen.findByRole('button', { name: 'Remove Client Acme' }));

    // The 409 is a question, not a failure: the count it carries is what the
    // offer is made out of.
    expect(await screen.findByText(/2 conversations still belong to Client Acme/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Move and remove' }));

    await waitFor(() => {
      expect(calls.filter((call) => call.method === 'DELETE')).toHaveLength(2);
    });
    expect(calls.some((call) => call.path === '/api/workspaces/acme/sessions/move')).toBe(true);
  });

  it('says the files survive a removal', async () => {
    stubApi({ 'GET /api/workspaces': [200, TWO] });
    renderWithProviders(<WorkspaceManager open onOpenChange={() => undefined} />);

    // Removing detaches. Saying so is what makes the button safe to press.
    expect(await screen.findByText(/cannot reach each other/)).toBeInTheDocument();
  });
});
