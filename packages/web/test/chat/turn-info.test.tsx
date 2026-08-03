/**
 * The turn-details popover, driven directly.
 *
 * Most of what it shows is arithmetic over numbers the turn already carries.
 * The one row that is not is **where the session came from**, and that row is
 * here for a reason worth writing down: it used to be a badge under the message
 * box, beside the agent picker. Every session a person opens is `web`, so the
 * badge printed the same word under almost every composer in the app and told
 * nobody anything — the same objection `BADGED_ORIGINS` in
 * `sessions/sessions-page.tsx` already raised against badging `web` in the list.
 *
 * It belongs with the model and the provider instead: one popover answering
 * "what did this actually run on", asked only by someone who wants to know.
 */

import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TurnItem } from '@/state/transcript.js';
import { renderWithProviders, stubFetch } from '@testkit/render.js';

import { TurnInfo } from '@/chat/turn-info.js';

const SESSION = 'web:1';

const TURN: TurnItem = {
  kind: 'turn',
  id: 't1',
  sessionKey: SESSION,
  model: 'test-model',
  provider: 'test',
  parts: [],
  stopReason: 'complete',
  // Present, so the body renders its table rather than the "no figures" line.
  usage: { promptTokens: 1200, completionTokens: 88, totalTokens: 1288 },
  iterations: 1,
  elapsedMs: 2000,
  firstSeq: 1,
  lastSeq: 2,
  done: true,
  failure: undefined,
};

function sessionRow(origin: string): Record<string, [number, unknown]> {
  return {
    [`/api/sessions/${encodeURIComponent(SESSION)}`]: [
      200,
      {
        key: SESSION,
        title: 'Nightly weather',
        messageCount: 2,
        createdAtMs: 1,
        updatedAtMs: 2,
        origin,
        workspaceId: 'default',
      },
    ],
  };
}

async function openDetails(): Promise<void> {
  renderWithProviders(<TurnInfo turn={TURN} sessionKey={SESSION} />);
  await userEvent.click(screen.getByRole('button', { name: 'Turn details' }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('where a session came from', () => {
  it('names the origin, so a scheduled run is not mistaken for one someone had', async () => {
    // A session key is a plain id and says nothing about what made it, which is
    // the right shape for a key — so this is the only place the answer is
    // readable once the session is open.
    stubFetch(sessionRow('automation'));
    await openDetails();

    expect(await screen.findByText('Started by')).toBeInTheDocument();
    expect(screen.getByText('automation')).toBeInTheDocument();
  });

  it('says nothing for a session someone started themselves', async () => {
    // `web` is every session opened by hand. A row that is always present and
    // always says the same word is a row that costs a line and answers nothing.
    stubFetch(sessionRow('web'));
    await openDetails();

    // Waited for through a row that is always there, so the assertion below is
    // about the origin being absent rather than about the fetch being slow.
    expect(await screen.findByText('Model')).toBeInTheDocument();
    expect(screen.queryByText('Started by')).not.toBeInTheDocument();
    expect(screen.queryByText('web')).not.toBeInTheDocument();
  });

  it('says nothing for a session with no row yet', async () => {
    // A fresh tab has not been spoken in, so the server has no row for it and
    // inventing `web` would be a claim rather than a fact.
    stubFetch({ [`/api/sessions/${encodeURIComponent(SESSION)}`]: [404, { error: 'not found' }] });
    await openDetails();

    expect(await screen.findByText('Model')).toBeInTheDocument();
    expect(screen.queryByText('Started by')).not.toBeInTheDocument();
  });
});
