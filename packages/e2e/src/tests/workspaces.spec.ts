/**
 * Workspaces, in a browser, against the real stack.
 *
 * The unit suites already prove the pieces: the jail clamps, the registry
 * refuses a path, the routes scope by workspace, the query keys carry it. What
 * only a browser can show is that they are wired to each other — that switching
 * in the sidebar actually moves the Files page, and that a file uploaded into
 * one workspace is not visible from another.
 *
 * That last assertion is the one worth the cost of a browser. A missing
 * workspace segment in a React Query key is invisible to every layer below the
 * cache: the server answers correctly, the client asks correctly, and the user
 * still sees the wrong workspace's files because an entry was served from
 * memory. It fails here and nowhere else.
 */

import type { Page } from '@playwright/test';

import { expect, test } from '../fixtures.js';

/** Picks a workspace from the sidebar switcher. */
async function switchTo(app: Page, name: string): Promise<void> {
  await app.getByRole('button', { name: /^Workspace: / }).click();
  await app.getByRole('menuitemradio', { name }).click();
}

test.describe('workspaces', () => {
  test('switching moves the Files page, and workspaces do not see each other', async ({
    app,
    harness,
  }) => {
    // Two workspaces, made through the API the manager uses. The manager has
    // its own component test; what this spec is here for is what happens after.
    for (const name of ['Acme', 'Research']) {
      const created = await app.request.post(`${harness.url}/api/workspaces`, {
        data: { name, id: name.toLowerCase() },
      });
      expect(created.ok(), `creating ${name} should succeed`).toBe(true);
    }

    await app.request.put(`${harness.url}/api/files/text`, {
      data: { path: 'acme-only.md', content: 'a', workspaceId: 'acme' },
    });
    await app.request.put(`${harness.url}/api/files/text`, {
      data: { path: 'research-only.md', content: 'r', workspaceId: 'research' },
    });

    await app.goto(`${harness.url}/files`);

    // Default is the parent of the others, so it sees them as folders — which
    // is the layout working, not a leak.
    await expect(app.getByRole('cell', { name: 'acme', exact: true })).toBeVisible();

    await switchTo(app, 'Acme');
    await expect(app.getByRole('cell', { name: 'acme-only.md', exact: true })).toBeVisible();
    await expect(app.getByRole('cell', { name: 'research-only.md', exact: true })).toHaveCount(0);

    await switchTo(app, 'Research');
    await expect(app.getByRole('cell', { name: 'research-only.md', exact: true })).toBeVisible();
    // The assertion the query key exists for: a cached listing from the
    // previous workspace would still be on screen here.
    await expect(app.getByRole('cell', { name: 'acme-only.md', exact: true })).toHaveCount(0);
  });

  test('the workspace survives a reload, because it is in the URL', async ({ app, harness }) => {
    const created = await app.request.post(`${harness.url}/api/workspaces`, {
      data: { name: 'Acme', id: 'acme' },
    });
    expect(created.ok()).toBe(true);
    await app.request.put(`${harness.url}/api/files/text`, {
      data: { path: 'acme-only.md', content: 'a', workspaceId: 'acme' },
    });

    await app.goto(`${harness.url}/files?workspace=acme`);
    await expect(app.getByRole('cell', { name: 'acme-only.md', exact: true })).toBeVisible();

    await app.reload();
    await expect(app.getByRole('cell', { name: 'acme-only.md', exact: true })).toBeVisible();
  });

  test('a workspace with conversations cannot be removed until they move', async ({
    app,
    harness,
  }) => {
    await app.request.post(`${harness.url}/api/workspaces`, {
      data: { name: 'Acme', id: 'acme' },
    });
    await app.request.post(`${harness.url}/api/sessions`, {
      data: { key: 'web-acme-1', workspaceId: 'acme' },
    });

    const refused = await app.request.delete(`${harness.url}/api/workspaces/acme`);
    expect(refused.status()).toBe(409);
    // The count is what the dialog turns into its offer.
    expect(
      ((await refused.json()) as { error: { details: { sessionCount: number } } }).error.details
        .sessionCount,
    ).toBe(1);

    const moved = await app.request.post(`${harness.url}/api/workspaces/acme/sessions/move`, {
      data: { to: 'default' },
    });
    expect(moved.ok()).toBe(true);
    expect((await app.request.delete(`${harness.url}/api/workspaces/acme`)).status()).toBe(204);
  });
});
