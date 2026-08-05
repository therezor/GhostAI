/**
 * The Telegram channel against the contract every channel has to pass.
 *
 * The point of running it here rather than only testing this channel's own
 * behaviour: the seven properties are the ones a channel gets *almost* right —
 * a session key it made up, a `progress` it never declared, an answer that
 * keeps arriving after `stop()` — and each of them looks fine in a manual test
 * and breaks something else.
 */

import { afterAll } from 'vitest';

import { channelConformance } from '#testkit/index.js';
import { telegramChannel } from '#src/telegram/index.js';
import type { TelegramChannel } from '#src/telegram/index.js';

import { FakeBotApi, messageUpdate } from './fake-bot-api.js';
import { fakeConsole } from './console-double.js';

const CHAT = 42;

/**
 * One transport and one console for the whole file.
 *
 * The suite builds a manager per case but takes a single factory, so both are
 * captured once — and torn down in `afterAll` rather than `afterEach`, which
 * would close the database out from under the second case.
 */
const fake = new FakeBotApi();
const shell = fakeConsole();

afterAll(() => {
  shell.close();
});

channelConformance<TelegramChannel>({
  factory: telegramChannel({
    token: 'test-token',
    console: shell,
    fetchImpl: fake.fetch,
  }),
  // Without an allowlist the channel refuses to start, which is the whole
  // point of `access.ts` — so the suite has to supply one.
  settings: { allowlist: [`${String(CHAT)}|tester`] },
  receive: async (channel, text) => {
    fake.push(messageUpdate({ text, userId: CHAT }));
    // Two macrotasks: one for the poll to pick the update up, one for the
    // publish to reach the manager's pump.
    await tick();
    await tick();
  },
  sent: () => fake.texts(),
  conversation: String(CHAT),
});

async function tick(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}
