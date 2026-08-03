/**
 * One agent handing a task to another, through the real stack.
 *
 * The whole chain is live here and that is the point: a real `AgentLoop`
 * resolves a second real `AgentLoop` from the runtime's cache, runs a turn on
 * it against a second session in SQLite, and its events reach the browser as
 * `subagent.event` frames over the same socket the caller's use.
 *
 * **Only durable state is asserted.** A delegation streams — the card opens
 * itself, says "working", and closes on `turn.end` — and the scripted provider
 * answers inside a frame, so every one of those is a race against how busy the
 * runner is. This spec waits for what the run settles into; the in-flight
 * wording is held still in `chat/subagent.test.tsx`.
 */

import type { Locator, Page } from '@playwright/test';

import { expect, test } from '../src/fixtures.js';
import { SUBAGENT_TASK } from '../src/harness/script.js';

/**
 * The delegating card, and its *own* header.
 *
 * Every locator here goes through the header rather than the card, because a
 * delegating card contains another tool card: `card.getByLabel('Succeeded')`
 * matches the outer status glyph and the nested one, and Playwright's strict
 * mode fails on the ambiguity. The header is the one row that belongs to this
 * card alone.
 */
function delegation(app: Page): { card: Locator; header: Locator } {
  const card = app.getByRole('region', { name: 'Tool call: ask_researcher' });
  return { card, header: card.getByRole('button', { name: /ask_researcher/ }) };
}

/** Opens the disclosure if it is closed, so a test never depends on auto-open. */
async function expand(header: Locator): Promise<void> {
  if ((await header.getAttribute('aria-expanded')) === 'false') await header.click();
}

test.use({
  harnessOptions: {
    config: {
      agents: {
        list: {
          // A second agent, and the default pointed at it. Nothing else about
          // it is special — it is an ordinary entry, which is the design.
          researcher: {
            label: 'Researcher',
            tools: { list_dir: 'allow', read_file: 'allow' },
          },
          default: {
            // `permission` is spelled out because `ConfigPatch` is the schema's
            // *output* type — the protocol keeps input and output identical so
            // the OpenAPI document describes what the server enforces, which
            // means a defaulted field is still required of a TypeScript literal.
            // A hand-written `config.json` may leave it out; this cannot.
            subagents: [
              {
                id: 'researcher',
                prompt: 'Ask when you need to look something up.',
                permission: 'allow',
              },
            ],
          },
        },
      },
    },
  },
});

test.describe('a delegating agent', () => {
  test('runs the subagent and answers from what it returned', async ({ app }) => {
    await app.getByRole('textbox', { name: 'Message' }).fill('delegate this to the researcher');
    await app.getByRole('button', { name: 'Send' }).click();

    // The delegation is a tool call like any other, named after the agent.
    const { card, header } = delegation(app);
    await expect(card).toBeVisible();
    await expect(header.getByLabel('Succeeded')).toBeVisible();

    // What the caller did with the answer.
    await expect(
      app.getByTestId('transcript').getByText('The researcher found notes.md.'),
    ).toBeVisible();
  });

  test('shows what the subagent did, nested inside the card', async ({ app }) => {
    await app.getByRole('textbox', { name: 'Message' }).fill('delegate this to the researcher');
    await app.getByRole('button', { name: 'Send' }).click();

    const { card, header } = delegation(app);
    await expect(header.getByLabel('Succeeded')).toBeVisible();
    await expand(header);

    const run = card.getByRole('region', { name: 'Subagent run: Researcher' });
    await expect(run).toBeVisible();
    // The task the caller wrote, as the argument on the card. `first()` because
    // the same sentence is also the subagent's own opening message inside the
    // run — which is exactly the point: one string, two places it has to be.
    await expect(card.getByText(SUBAGENT_TASK).first()).toBeVisible();

    // The subagent's own tool call, as a card of its own inside the run — the
    // same landmark and the same status label a top-level call gets.
    const nested = run.getByRole('region', { name: 'Tool call: list_dir' });
    await expect(nested).toBeVisible();
    await expect(nested.getByLabel('Succeeded')).toBeVisible();
    await expect(run.getByText('There is one file: notes.md.')).toBeVisible();
  });

  test('can still show the run after a reload', async ({ app }) => {
    await app.getByRole('textbox', { name: 'Message' }).fill('delegate this to the researcher');
    await app.getByRole('button', { name: 'Send' }).click();
    await expect(delegation(app).header.getByLabel('Succeeded')).toBeVisible();

    // The events are gone; the rows are not. The parent's history names the
    // subagent's session, and the card fetches it when a reader opens it.
    await app.reload();

    const { card, header } = delegation(app);
    await expect(header.getByLabel('Succeeded')).toBeVisible();
    await expand(header);

    const run = card.getByRole('region', { name: 'Subagent run: Researcher' });
    await expect(run).toBeVisible();
    await expect(run.getByRole('region', { name: 'Tool call: list_dir' })).toBeVisible();
    await expect(run.getByText('There is one file: notes.md.')).toBeVisible();
  });

  test('leaves the subagent run in the sidebar, openable like any session', async ({ app }) => {
    await app.getByRole('textbox', { name: 'Message' }).fill('delegate this to the researcher');
    await app.getByRole('button', { name: 'Send' }).click();
    await expect(delegation(app).header.getByLabel('Succeeded')).toBeVisible();

    // These used to be hidden on the grounds that a delegation is not a
    // session. It is still not one — but it is the turn that produced the
    // answer, and hiding it left no way to read it when the answer was wrong.
    const sidebar = app.getByRole('complementary', { name: 'Sidebar' });
    await expect(sidebar.getByText(SUBAGENT_TASK)).toHaveCount(1);
  });
});

test.describe('the agent editor', () => {
  test('shows the delegation the config declares', async ({ app }) => {
    await app.getByRole('link', { name: 'Agents' }).click();
    await app.getByRole('link', { name: 'default' }).click();

    await expect(app.getByRole('combobox', { name: 'Agent for subagent 1' })).toHaveText(
      'Researcher',
    );
    // The derived name, which is what the model is really offered.
    await expect(app.getByText('ask_researcher')).toBeVisible();
  });
});
