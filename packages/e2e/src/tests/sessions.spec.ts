/**
 * Starting, naming and forking a conversation.
 *
 * The web UI had no way to start one. What looked like the control — a "Chat"
 * nav link — dropped `?session=` from a route that reads the store rather than
 * the URL, so it cleared nothing and the first message put the key straight
 * back. These four cases are the replacement, driven through the real server:
 * a conversation is created, it names itself after what was said in it, picking
 * another switches to it, and a branch forks without disturbing the original.
 *
 * The title is the one worth having end to end. Nothing in the browser derives
 * it — the agent loop does, from the first message, which is what makes a
 * conversation started in the terminal show up named in the sidebar. A unit
 * test of the derivation cannot see that.
 */

import { expect, test } from '../fixtures.js';

test.describe('conversations', () => {
  test('starts one, names it after the first message, and lists it', async ({ app }) => {
    const sidebar = app.getByRole('complementary', { name: 'Sidebar' });

    await sidebar.getByRole('button', { name: 'New session' }).click();
    // The key comes back from `POST /api/sessions`, which is why the button is
    // REST rather than the socket's `session.new`: the navigation needs it.
    await expect(app).toHaveURL(/\?session=/u);

    await app.getByRole('textbox', { name: 'Message' }).fill('stream a long answer');
    await app.getByRole('textbox', { name: 'Message' }).press('Enter');
    await expect(app.getByText('The workspace holds', { exact: false }).first()).toBeVisible({
      timeout: 15_000,
    });

    // Derived by the loop, so the sidebar shows a name rather than a uuid.
    await expect(sidebar.getByText('stream a long answer')).toBeVisible({ timeout: 15_000 });
  });

  test('saves nothing until something is said', async ({ app }) => {
    const sidebar = app.getByRole('complementary', { name: 'Sidebar' });

    await sidebar.getByRole('button', { name: 'New session' }).click();
    await expect(app.getByRole('heading', { name: 'Ready when you are.' })).toBeVisible();

    // Pressed, then thought better of. A row written on the press would still
    // be here — and the list would fill with conversations nobody had.
    await expect(sidebar.getByText('No conversations yet.')).toBeVisible();

    await app.getByRole('textbox', { name: 'Message' }).fill('stream a long answer');
    await app.getByRole('textbox', { name: 'Message' }).press('Enter');

    // Saved by the turn, not by the button.
    await expect(sidebar.getByText('stream a long answer')).toBeVisible({ timeout: 15_000 });
  });

  test('switches between conversations without losing either', async ({ app }) => {
    const sidebar = app.getByRole('complementary', { name: 'Sidebar' });
    const message = app.getByRole('textbox', { name: 'Message' });

    await sidebar.getByRole('button', { name: 'New session' }).click();
    await message.fill('list the workspace');
    await message.press('Enter');
    await expect(app.getByRole('region', { name: 'Tool call: list_dir' })).toBeVisible({
      timeout: 15_000,
    });

    await sidebar.getByRole('button', { name: 'New session' }).click();
    // A fresh conversation is empty, which the dead nav link never managed.
    await expect(app.getByRole('heading', { name: 'Ready when you are.' })).toBeVisible();

    await sidebar.getByRole('link', { name: /list the workspace/u }).click();
    await expect(app.getByRole('region', { name: 'Tool call: list_dir' })).toBeVisible({
      timeout: 15_000,
    });
  });

  test('marks the new session until there is a saved one to mark', async ({ app }) => {
    const sidebar = app.getByRole('complementary', { name: 'Sidebar' });

    await sidebar.getByRole('button', { name: 'New session' }).click();

    // A session exists on the socket before it exists in the list, and without
    // this the column would claim you are nowhere for the whole of that window.
    await expect(sidebar.locator('[aria-current="page"]')).toHaveText(/New session/u);

    await app.getByRole('textbox', { name: 'Message' }).fill('stream a long answer');
    await app.getByRole('textbox', { name: 'Message' }).press('Enter');
    await expect(sidebar.getByText('stream a long answer')).toBeVisible({ timeout: 15_000 });

    // Saved, so the mark moves to the row — and there is only ever one.
    await expect(sidebar.locator('[aria-current="page"]')).toHaveCount(1);
    await expect(sidebar.locator('[aria-current="page"]')).toHaveText(/stream a long answer/u);
  });

  test('lists a conversation on one line, without a message count', async ({ app }) => {
    const sidebar = app.getByRole('complementary', { name: 'Sidebar' });

    await sidebar.getByRole('button', { name: 'New session' }).click();
    await app.getByRole('textbox', { name: 'Message' }).fill('stream a long answer');
    await app.getByRole('textbox', { name: 'Message' }).press('Enter');

    const row = sidebar.getByRole('link', { name: /stream a long answer/u });
    await expect(row).toBeVisible({ timeout: 15_000 });

    // The title is what this list is scanned for. A count on a second line
    // halved how many conversations fit in the column to carry a number nobody
    // reads — it is still on the API for anything that wants it.
    await expect(row).not.toContainText('message');
  });

  test('marks which conversation is open', async ({ app }) => {
    const sidebar = app.getByRole('complementary', { name: 'Sidebar' });

    await sidebar.getByRole('button', { name: 'New session' }).click();
    await app.getByRole('textbox', { name: 'Message' }).fill('stream a long answer');
    await app.getByRole('textbox', { name: 'Message' }).press('Enter');
    await expect(sidebar.getByText('stream a long answer')).toBeVisible({ timeout: 15_000 });

    // `aria-current` is the accessible half of the surface change, and the half
    // a screenshot cannot check. Located by the attribute rather than through
    // `getByRole`, which has no `current` option and silently ignores one.
    await expect(sidebar.locator('a[aria-current="page"]')).toHaveText(/stream a long answer/u);
  });

  test('branches into a second conversation, leaving the first alone', async ({ app }) => {
    const sidebar = app.getByRole('complementary', { name: 'Sidebar' });
    const message = app.getByRole('textbox', { name: 'Message' });

    await sidebar.getByRole('button', { name: 'New session' }).click();
    await message.fill('stream a long answer');
    await message.press('Enter');
    await expect(sidebar.getByText('stream a long answer')).toBeVisible({ timeout: 15_000 });

    await app.getByRole('button', { name: 'Branch from here' }).first().click();

    // Two rows now name the same thing: the fork inherits the source's title.
    await expect(sidebar.getByText('stream a long answer')).toHaveCount(2, { timeout: 15_000 });
  });
});
