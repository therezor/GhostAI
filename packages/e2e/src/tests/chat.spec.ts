/**
 * The turn, end to end and in a browser.
 *
 * Everything here has a unit test somewhere already — the hub's queue, the
 * block splitter, the tool card's states, the abort chain. What none of those
 * can say is that the pieces are wired to each other: that a keystroke reaches
 * the loop, that the loop's events reach the transcript, and that Stop reaches
 * a running child. That is the whole subject of this file, and it is why it
 * drives the real composition rather than a mocked socket.
 */

import { expect, test } from '../fixtures.js';

test.describe('a turn', () => {
  test('streams an answer, its reasoning and its code block', async ({ app }) => {
    await app.getByLabel('Message').fill('stream a long answer');
    await app.getByRole('button', { name: 'Send' }).click();

    const transcript = app.getByTestId('transcript');
    await expect(transcript.getByText('Here is what I found.')).toBeVisible();
    await expect(transcript.getByText('That is the whole of it.')).toBeVisible();

    // The fence became a code block rather than a paragraph containing
    // backticks — which is the difference the block splitter exists to make.
    await expect(transcript.locator('pre code')).toContainText('const note =');

    // Reasoning is its own thing rather than folded into the answer — and it
    // is behind a disclosure that collapsed itself the moment the first answer
    // token arrived, which is the behaviour rather than an inconvenience.
    await expect(transcript.getByText(/Checking the workspace/)).toBeHidden();
    await transcript.getByRole('button', { name: 'Reasoning' }).click();
    await expect(transcript.getByText(/Checking the workspace/)).toBeVisible();

    // The turn finished: the composer is offering Send again, not Stop.
    await expect(app.getByRole('button', { name: 'Send' })).toBeVisible();
  });

  test('renders a tool card for a call that needs no approval', async ({ app }) => {
    await app.getByLabel('Message').fill('list the workspace');
    await app.getByRole('button', { name: 'Send' }).click();

    const card = app.getByRole('region', { name: 'Tool call: list_dir' });
    await expect(card).toBeVisible();
    // `list_dir` is in the `safe` band, so nothing stood between the call and
    // its execution.
    await expect(card.getByText('needs approval to run')).toHaveCount(0);

    // Expanding shows what the tool actually returned — the workspace fixture.
    await card.getByRole('button', { expanded: false }).click();
    await expect(card.getByText('notes.md')).toBeVisible();

    await expect(app.getByTestId('transcript').getByText('The workspace holds')).toBeVisible();
  });

  test('Stop aborts a turn while a tool is still running', async ({ app }) => {
    await app.getByLabel('Message').fill('wait for me');
    await app.getByRole('button', { name: 'Send' }).click();

    // The tool is running and will not finish on its own for a minute, so
    // anything observed after this point is observed mid-call.
    const card = app.getByRole('region', { name: 'Tool call: e2e_wait' });
    await expect(card).toBeVisible();
    await expect(card.getByLabel('Running')).toBeVisible();

    const stop = app.getByRole('button', { name: 'Stop the current turn' });
    await expect(stop).toBeVisible();
    await stop.click();

    // The composer went back to Send, which is driven by `session.status.busy`
    // — so the server agreed the turn is over, rather than the button merely
    // having been pressed.
    await expect(app.getByRole('button', { name: 'Send' })).toBeVisible();
    await expect(card.getByLabel('Running')).toHaveCount(0);
  });

  test('a queued message says so rather than disabling the composer', async ({ app }) => {
    await app.getByLabel('Message').fill('stall here');
    await app.getByRole('button', { name: 'Send' }).click();
    await expect(app.getByRole('button', { name: 'Stop the current turn' })).toBeVisible();

    // Enter still sends while a turn runs: the hub queues it. A composer that
    // disabled itself would lose whatever the user was mid-way through typing.
    const message = app.getByLabel('Message');
    await expect(message).toBeEditable();
    await message.fill('stall again');
    await message.press('Enter');

    await expect(app.getByText(/message waiting|messages waiting/)).toBeVisible();
    await app.getByRole('button', { name: 'Stop the current turn' }).click();
  });
});
