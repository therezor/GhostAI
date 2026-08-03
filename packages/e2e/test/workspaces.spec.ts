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

import { expect, test } from '../src/fixtures.js';

/** Every workspace as the registry has it, reduced to what an assertion reads. */
async function workspacesOf(
  app: Page,
  url: string,
): Promise<Array<{ id: string; name: string }>> {
  const response = await app.request.get(`${url}/api/workspaces`);
  const body = (await response.json()) as {
    workspaces: Array<{ id: string; name: string }>;
  };
  return body.workspaces.map((row) => ({ id: row.id, name: row.name }));
}

/** Picks a workspace from the sidebar switcher. */
async function switchTo(app: Page, name: string): Promise<void> {
  await app.getByRole('button', { name: /^Workspace: / }).click();
  await app.getByRole('menuitemradio', { name }).click();
}

test.describe('workspaces', () => {
  test('a workspace is created under a folder of its own choosing', async ({
    app,
    harness,
  }) => {
    // The two are separate answers, and the registry has always stored them in
    // separate columns — what only a browser shows is that the second box
    // actually reaches the request rather than being decoration over a slug the
    // name derived anyway.
    await app.goto(`${harness.url}/workspaces`);

    await app.getByRole('link', { name: 'New workspace' }).click();
    await app.getByLabel('Name').fill('Client Acme (2024 rebuild)');
    await app.getByLabel('Folder').fill('acme24');
    await app.getByRole('button', { name: 'Save changes' }).click();

    // The durable state, not the toast that announces it: the registry holds
    // both halves, separately, as they were typed.
    await expect
      .poll(async () => await workspacesOf(app, harness.url))
      .toContainEqual({
        id: 'acme24',
        name: 'Client Acme (2024 rebuild)',
      });

    // And Save lands on the workspace it made, which is the page that can now
    // move or remove it.
    await expect(app).toHaveURL(/\/workspaces\/acme24$/u);
  });

  test('an abandoned create makes no directory at all', async ({
    app,
    harness,
  }) => {
    // The reason create is a page rather than the dialog it replaced: that
    // dialog ran the `mkdir` the moment it was submitted.
    const before = await workspacesOf(app, harness.url);

    await app.goto(`${harness.url}/workspaces/new`);
    await app.getByLabel('Name').fill('Never finished');
    await app.getByRole('link', { name: 'Workspaces' }).first().click();

    expect(await workspacesOf(app, harness.url)).toEqual(before);
  });

  test('the row opens an editor, and the name changes without the folder moving', async ({
    app,
    harness,
  }) => {
    await app.request.post(`${harness.url}/api/workspaces`, {
      data: { name: 'Acme', id: 'acme' },
    });
    await app.goto(`${harness.url}/workspaces`);

    await app.getByRole('link', { name: 'Edit Acme' }).click();
    await expect(app).toHaveURL(/\/workspaces\/acme$/u);
    await expect(app.getByLabel('Folder')).toHaveValue('acme');

    await app.getByLabel('Name').fill('Acme Ltd');
    await app.getByRole('button', { name: 'Save changes' }).click();

    await expect
      .poll(async () => await workspacesOf(app, harness.url))
      .toContainEqual({
        id: 'acme',
        name: 'Acme Ltd',
      });
  });

  test('moving the folder renames the directory and takes the sessions', async ({
    app,
    harness,
  }) => {
    // The assertion only a real stack can make: the tree on disk, the registry
    // row and the sessions that named the old folder all end up agreeing. Each
    // of the three is a different store, and nothing below this level sees more
    // than one of them.
    await app.request.post(`${harness.url}/api/workspaces`, {
      data: { name: 'Acme', id: 'acme' },
    });
    await app.request.put(`${harness.url}/api/files/text`, {
      data: { path: 'brief.md', content: 'the brief', workspaceId: 'acme' },
    });
    await app.request.post(`${harness.url}/api/sessions`, {
      data: { key: 'web-acme-1', workspaceId: 'acme' },
    });

    await app.goto(`${harness.url}/workspaces/acme`);
    await app.getByLabel('Folder').fill('acme24');
    await app.getByRole('button', { name: 'Save changes' }).click();

    // The durable state: the editor is now on the new folder's URL.
    await expect(app).toHaveURL(/\/workspaces\/acme24$/u);
    await expect
      .poll(async () => await workspacesOf(app, harness.url))
      .toContainEqual({
        id: 'acme24',
        name: 'Acme',
      });

    // The files came with it, and are reachable under the new folder alone.
    await app.goto(`${harness.url}/files?workspace=acme24`);
    await expect(
      app.getByRole('link', { name: 'brief.md', exact: true }),
    ).toBeVisible();

    // And so did the session, which would otherwise resolve to a folder
    // that is not there any more.
    const sessions = await app.request.get(
      `${harness.url}/api/sessions?workspace=acme24`,
    );
    expect(
      (
        (await sessions.json()) as { sessions: Array<{ key: string }> }
      ).sessions.map((row) => row.key),
    ).toContain('web-acme-1');
  });

  test('the default workspace has no folder to move', async ({
    app,
    harness,
  }) => {
    await app.goto(`${harness.url}/workspaces/default`);

    // Its directory *is* the root every other workspace sits inside, so the box
    // is inert rather than absent, states `/`, and says why it cannot move.
    await expect(app.getByLabel('Folder')).toBeDisabled();
    await expect(app.getByLabel('Folder')).toHaveValue('/');
    await expect(app.getByText(/no folder of its own to move/)).toBeVisible();
  });

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
    await expect(
      app.getByRole('link', { name: 'acme', exact: true }),
    ).toBeVisible();

    await switchTo(app, 'Acme');
    await expect(
      app.getByRole('link', { name: 'acme-only.md', exact: true }),
    ).toBeVisible();
    await expect(
      app.getByRole('link', { name: 'research-only.md', exact: true }),
    ).toHaveCount(0);

    await switchTo(app, 'Research');
    await expect(
      app.getByRole('link', { name: 'research-only.md', exact: true }),
    ).toBeVisible();
    // The assertion the query key exists for: a cached listing from the
    // previous workspace would still be on screen here.
    await expect(
      app.getByRole('link', { name: 'acme-only.md', exact: true }),
    ).toHaveCount(0);
  });

  test('the workspace survives a reload, because it is in the URL', async ({
    app,
    harness,
  }) => {
    const created = await app.request.post(`${harness.url}/api/workspaces`, {
      data: { name: 'Acme', id: 'acme' },
    });
    expect(created.ok()).toBe(true);
    await app.request.put(`${harness.url}/api/files/text`, {
      data: { path: 'acme-only.md', content: 'a', workspaceId: 'acme' },
    });

    await app.goto(`${harness.url}/files?workspace=acme`);
    await expect(
      app.getByRole('link', { name: 'acme-only.md', exact: true }),
    ).toBeVisible();

    await app.reload();
    await expect(
      app.getByRole('link', { name: 'acme-only.md', exact: true }),
    ).toBeVisible();
  });

  test('a workspace with sessions cannot be deleted until they move', async ({
    app,
    harness,
  }) => {
    await app.request.post(`${harness.url}/api/workspaces`, {
      data: { name: 'Acme', id: 'acme' },
    });
    await app.request.post(`${harness.url}/api/sessions`, {
      data: { key: 'web-acme-1', workspaceId: 'acme' },
    });

    const refused = await app.request.delete(
      `${harness.url}/api/workspaces/acme`,
    );
    expect(refused.status()).toBe(409);
    // The count is what the dialog turns into its offer.
    expect(
      (
        (await refused.json()) as {
          error: { details: { sessionCount: number } };
        }
      ).error.details.sessionCount,
    ).toBe(1);

    const moved = await app.request.post(
      `${harness.url}/api/workspaces/acme/sessions/move`,
      {
        data: { to: 'default' },
      },
    );
    expect(moved.ok()).toBe(true);
    expect(
      (await app.request.delete(`${harness.url}/api/workspaces/acme`)).status(),
    ).toBe(204);
  });

  test('is not sitting under the drawer close button on a phone', async ({
    app,
  }) => {
    await app.setViewportSize({ width: 420, height: 840 });
    await app.getByRole('button', { name: 'Open menu' }).click();

    const drawer = app.getByRole('dialog');
    await expect(drawer).toBeVisible();

    const close = drawer.getByRole('button', { name: 'Close' });
    const picker = drawer.getByRole('button', { name: /^Workspace:/u });

    const closeBox = await close.boundingBox();
    const pickerBox = await picker.boundingBox();
    if (closeBox === null || pickerBox === null) {
      throw new Error('no layout to measure');
    }

    // The drawer is a dialog with no padding of its own, so its absolutely
    // positioned close button landed squarely on the first control in the
    // column. Two rectangles that do not overlap is the whole assertion.
    const overlaps =
      closeBox.x < pickerBox.x + pickerBox.width &&
      closeBox.x + closeBox.width > pickerBox.x &&
      closeBox.y < pickerBox.y + pickerBox.height &&
      closeBox.y + closeBox.height > pickerBox.y;
    expect(overlaps, 'the close button overlaps the workspace picker').toBe(
      false,
    );
  });

  test('reads as a labelled picker rather than another nav row', async ({
    app,
  }) => {
    const sidebar = app.getByRole('complementary', { name: 'Sidebar' });

    // The label names the group the way the session list's does, so the control
    // under it does not have to name itself with an icon.
    await expect(sidebar.getByText('Workspace', { exact: true })).toBeVisible();

    const trigger = sidebar.getByRole('button', { name: /^Workspace:/u });
    await expect(trigger).toBeVisible();

    // The same box as the rows beneath it — it wore a bordered surface for a
    // while and was the loudest thing in a column whose subject is elsewhere.
    // The chevron is what says it opens something.
    const [triggerBox, rowBox] = await Promise.all([
      trigger.evaluate((el) => getComputedStyle(el).height),
      sidebar
        .getByRole('link', { name: 'Files' })
        .evaluate((el) => getComputedStyle(el).height),
    ]);
    expect(triggerBox).toBe(rowBox);
  });
});
