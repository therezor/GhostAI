/**
 * Slash commands in the composer, through the real server.
 *
 * Three things a component test cannot see, which is why these three and not
 * the whole table. The completion list has to open against the *installed*
 * agents rather than a stubbed listing. `/rename` has to reach
 * `PATCH /api/sessions/:key` and come back far enough for the sidebar to agree.
 * And a message that merely looks like a command has to survive the whole
 * journey to the model as prose.
 *
 * **Every assertion here is on a durable state.** The toast a command raises is
 * the textbook transient — it is on screen for a few seconds and whether a run
 * catches it depends on how the machine was feeling — so what is asserted is
 * the title in the sidebar, the list in the box, the answer in the transcript.
 * The wording of the toasts is covered where it can be held still, in
 * `packages/web/test/chat/commands.test.ts`.
 */

import { expect, test } from '../src/fixtures.js';

test.describe('slash commands', () => {
  test('opens the list on a slash and completes what is typed', async ({
    app,
  }) => {
    const message = app.getByRole('textbox', { name: 'Message' });

    await message.fill('/');
    const list = app.getByRole('listbox', { name: 'Commands' });
    await expect(list.getByRole('option').first()).toContainText('/new');

    // Narrowing is the parser's, not a filter over what is already rendered.
    await message.fill('/ren');
    await expect(list.getByRole('option')).toHaveCount(1);
    await expect(list.getByRole('option')).toContainText('/rename');

    // `/rename` still needs an argument, so Enter accepts rather than sending
    // and leaves the cursor after the space.
    await message.press('Enter');
    await expect(message).toHaveValue('/rename ');

    // A command that needs nothing closes the list as soon as it is complete,
    // so Enter sends it. One keypress, as it is in the terminal and the bot.
    await message.fill('/stop');
    await expect(app.getByRole('listbox', { name: 'Commands' })).toHaveCount(0);
  });

  test('renames the session, and the sidebar agrees', async ({ app }) => {
    const sidebar = app.getByRole('complementary', { name: 'Sidebar' });
    const message = app.getByRole('textbox', { name: 'Message' });

    await message.fill('stream a long answer');
    await message.press('Enter');
    // The session has to exist before it can be renamed — nothing is stored
    // until the first turn lands, which is what `/rename` refuses on.
    await expect(sidebar.getByText('stream a long answer')).toBeVisible({
      timeout: 15_000,
    });

    await message.fill('/rename Renamed from the composer');
    await message.press('Enter');

    // The durable half: the title on the row, which came back from the PATCH.
    await expect(sidebar.getByText('Renamed from the composer')).toBeVisible({
      timeout: 15_000,
    });
    await expect(message).toHaveValue('');
  });

  test('sends a path as the sentence it is', async ({ app }) => {
    const message = app.getByRole('textbox', { name: 'Message' });

    // The trap the parser exists for. A second slash in the first word is what
    // keeps every path out of the dispatcher.
    await message.fill('/usr/bin/env is on the path');
    await expect(app.getByRole('listbox', { name: 'Commands' })).toHaveCount(0);

    await message.press('Enter');

    // It reached the transcript as a message, which is only true if nothing
    // claimed it on the way.
    await expect(
      app.getByText('/usr/bin/env is on the path', { exact: false }).first(),
    ).toBeVisible({ timeout: 15_000 });
  });
});
