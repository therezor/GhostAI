import { afterEach, describe, expect, it } from 'vitest';

import type { ServerMessage } from '@ghostbot/protocol';

import {
  ChannelManager,
  type ChannelHub,
  type ChannelHubConnectOptions,
  type ChannelHubConnection,
} from '#src/manager.js';
import { telegramChannel, type TelegramChannel } from '#src/telegram/index.js';

import { FakeBotApi, callbackUpdate, messageUpdate } from './fake-bot-api.js';
import { fakeConsole, type FakeConsole } from './console-double.js';
import { manualClock } from './manual-clock.js';

const CHAT = 42;

/** Two macrotasks: one for the poll, one for the manager's pumps. */
async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}

class FakeConnection implements ChannelHubConnection {
  readonly sessionKey: string;
  readonly frames: Array<Record<string, unknown>> = [];
  closed = false;
  private readonly send: (message: ServerMessage) => void;

  constructor(options: ChannelHubConnectOptions) {
    this.sessionKey = options.sessionKey ?? 'minted';
    this.send = options.send;
  }

  receive(frame: unknown): void {
    this.frames.push(frame as Record<string, unknown>);
  }

  close(): void {
    this.closed = true;
  }

  emit(message: ServerMessage): void {
    this.send(message);
  }
}

class FakeHub implements ChannelHub {
  readonly connections: FakeConnection[] = [];

  connect(options: ChannelHubConnectOptions): ChannelHubConnection {
    const connection = new FakeConnection(options);
    this.connections.push(connection);
    return connection;
  }

  only(): FakeConnection {
    const connection = this.connections[0];
    if (connection === undefined) throw new Error('No connection was opened');
    return connection;
  }
}

interface Harness {
  readonly fake: FakeBotApi;
  readonly hub: FakeHub;
  readonly manager: ChannelManager;
  readonly channel: TelegramChannel;
  readonly console: FakeConsole;
  readonly clock: ReturnType<typeof manualClock>;
}

const running: ChannelManager[] = [];
const consoles: FakeConsole[] = [];

interface StartOptions {
  readonly settings?: Readonly<Record<string, unknown>>;
  /** Queues answers *before* the poll starts, for a failure at the first ask. */
  readonly arrange?: (fake: FakeBotApi) => void;
}

async function start(options: StartOptions = {}): Promise<Harness> {
  const fake = new FakeBotApi();
  options.arrange?.(fake);
  const hub = new FakeHub();
  const shell = fakeConsole();
  const clock = manualClock();
  consoles.push(shell);

  const manager = new ChannelManager({
    hub,
    clock,
    factories: [
      telegramChannel({
        token: 'test-token',
        console: shell,
        fetchImpl: fake.fetch,
      }),
    ],
    channels: {
      telegram: {
        allowlist: [`${String(CHAT)}|tester`],
        ...options.settings,
      },
    },
  });
  running.push(manager);
  await manager.start();
  await settle();

  const channel = manager.channel('telegram') as TelegramChannel;
  return { fake, hub, manager, channel, console: shell, clock };
}

afterEach(async () => {
  await Promise.all(
    running.splice(0).map(async (manager) => {
      await manager.stop();
    }),
  );
  while (consoles.length > 0) consoles.pop()?.close();
});

// ---------------------------------------------------------------------------

describe('starting up', () => {
  it('confirms the token, clears a stale webhook and registers commands', async () => {
    const h = await start();

    const methods = h.fake.calls.map((call) => call.method);
    // `deleteWebhook` first, because a webhook left from an earlier setup makes
    // every `getUpdates` a 409 that looks exactly like the serious one.
    expect(methods.slice(0, 3)).toEqual([
      'getMe',
      'deleteWebhook',
      'setMyCommands',
    ]);
    expect(h.channel.username).toBe('ghost_test_bot');
  });

  it('returns from start rather than running the poll inline', async () => {
    // `ChannelManager.start()` awaits `channel.start()`. A method that polled
    // inline would never return and the server would never finish booting.
    const h = await start();

    expect(h.manager.channels.map((channel) => channel.id)).toEqual([
      'telegram',
    ]);
  });

  it('refuses to start with an empty allowlist', async () => {
    // A bot username is discoverable and there is an agent behind this one.
    const fake = new FakeBotApi();
    const shell = fakeConsole();
    consoles.push(shell);
    const manager = new ChannelManager({
      hub: new FakeHub(),
      factories: [
        telegramChannel({
          token: 't',
          console: shell,
          fetchImpl: fake.fetch,
        }),
      ],
      channels: { telegram: { allowlist: [] } },
    });
    running.push(manager);

    await expect(manager.start()).rejects.toThrow(/allowlist is empty/u);
  });

  it('fails startup on a bad token rather than going quietly dead', async () => {
    const fake = new FakeBotApi();
    const shell = fakeConsole();
    consoles.push(shell);
    fake.fail('getMe', { code: 401, description: 'Unauthorized' });
    const manager = new ChannelManager({
      hub: new FakeHub(),
      factories: [
        telegramChannel({
          token: 'bad',
          console: shell,
          fetchImpl: fake.fetch,
        }),
      ],
      channels: { telegram: { allowlist: ['1'] } },
    });
    running.push(manager);

    await expect(manager.start()).rejects.toThrow(/Unauthorized/u);
  });

  it('declares progress, so a turn fills one message in', async () => {
    const h = await start();

    expect(h.channel.accepts).toContain('progress');
  });
});

describe('messages', () => {
  it('publishes what an allowed sender typed', async () => {
    const h = await start();

    h.fake.push(messageUpdate({ text: 'hello there', userId: CHAT }));
    await settle();

    expect(h.hub.only().frames[0]).toMatchObject({
      type: 'user.message',
      sessionKey: `telegram:${String(CHAT)}`,
      content: 'hello there',
    });
  });

  it('carries the Telegram message id, so a redelivery is not a second turn', async () => {
    const h = await start();

    h.fake.push(messageUpdate({ text: 'once', userId: CHAT }));
    await settle();

    expect(h.hub.only().frames[0]?.clientMessageId).toBe(`${String(CHAT)}:1`);
  });

  it('drops a sender nobody listed, and answers them nothing', async () => {
    const h = await start();

    h.fake.push(messageUpdate({ text: 'let me in', userId: 999 }));
    await settle();

    expect(h.hub.connections).toHaveLength(0);
    // Silence: a reply confirms the bot is live and spends the rate limit on
    // whoever is knocking.
    expect(h.fake.texts()).toEqual([]);
  });

  it('refuses an unlisted member of a chat that is listed', async () => {
    const h = await start({
      settings: { allowlist: [String(CHAT), '-100'] },
    });

    h.fake.push(messageUpdate({ text: 'hello', userId: 999, chatId: -100 }));
    await settle();

    expect(h.hub.connections).toHaveLength(0);
  });

  it('answers the agent’s reply back into the chat', async () => {
    const h = await start();
    h.fake.push(messageUpdate({ text: 'a question', userId: CHAT }));
    await settle();

    const connection = h.hub.only();
    connection.emit({
      type: 'turn.start',
      seq: 1,
      sessionKey: connection.sessionKey,
      turnId: 't1',
      agentId: 'default',
      model: 'm',
      provider: 'p',
    });
    connection.emit({
      type: 'assistant.delta',
      seq: 2,
      turnId: 't1',
      text: 'the answer',
    });
    connection.emit({
      type: 'turn.end',
      seq: 3,
      turnId: 't1',
      stopReason: 'complete',
      iterations: 1,
    });
    await settle();

    expect(h.fake.texts().join('\n')).toContain('the answer');
  });
});

describe('commands', () => {
  it('runs one and answers it', async () => {
    const h = await start();

    h.fake.push(messageUpdate({ text: '/help', userId: CHAT }));
    await settle();

    expect(h.fake.texts().join('\n')).toContain('/sessions');
  });

  it('sends the frame a browser sends, for /stop', async () => {
    const h = await start();
    h.fake.push(messageUpdate({ text: 'a question', userId: CHAT }));
    await settle();

    h.fake.push(messageUpdate({ text: '/stop', userId: CHAT }));
    await settle();

    expect(h.hub.only().frames).toContainEqual({
      type: 'turn.stop',
      sessionKey: `telegram:${String(CHAT)}`,
    });
  });

  it('moves the conversation without a switch frame', async () => {
    // The manager derives a session from what is published, so `/new` changes
    // the channel's own map and the next message lands somewhere else.
    const h = await start();
    h.fake.push(messageUpdate({ text: '/new', userId: CHAT }));
    await settle();
    h.fake.push(messageUpdate({ text: 'in the new one', userId: CHAT }));
    await settle();

    const keys = h.hub.connections.map((connection) => connection.sessionKey);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(
      new RegExp(`^telegram:${String(CHAT)}:[0-9a-f-]+$`, 'u'),
    );
  });
});

describe('approvals', () => {
  /** Drives a turn to the point where the agent asks to run a tool. */
  async function untilApproval(): Promise<Harness> {
    const h = await start();
    h.fake.push(messageUpdate({ text: 'do the thing', userId: CHAT }));
    await settle();
    h.hub.only().emit({
      type: 'tool.approvalRequest',
      seq: 1,
      turnId: 't1',
      callId: 'call-1',
      name: 'exec',
      args: { command: 'rm -rf build' },
      risk: 'exec',
      expiresAtMs: 1_700_000_060_000,
    });
    await settle();
    return h;
  }

  it('posts a card with the tool, its risk, and four buttons', async () => {
    const h = await untilApproval();
    const card = h.fake.bodies('sendMessage').at(-1);

    expect(String(card?.text)).toContain('exec');
    expect(String(card?.text)).toContain('risk: exec');
    const keyboard = JSON.stringify(card?.reply_markup);
    expect(keyboard).toContain('Once');
    expect(keyboard).toContain('This session');
    expect(keyboard).toContain('Always');
    expect(keyboard).toContain('Deny');
  });

  it('never shows what the model asked to run', async () => {
    // `args` is model-authored and unbounded. It does not leave the projection,
    // and this is the assertion that keeps it that way.
    const h = await untilApproval();

    expect(JSON.stringify(h.fake.calls)).not.toContain('rm -rf build');
  });

  it('answers the gate when a button is pressed', async () => {
    const h = await untilApproval();
    const keyboard = h.fake.bodies('sendMessage').at(-1)?.reply_markup;
    const token = firstButton(keyboard);

    h.fake.push(callbackUpdate({ data: token, userId: CHAT }));
    await settle();

    expect(h.hub.only().frames).toContainEqual({
      type: 'tool.approve',
      callId: 'call-1',
      approved: true,
      scope: 'once',
    });
  });

  it('always answers the callback query, so the button stops spinning', async () => {
    const h = await untilApproval();
    const token = firstButton(
      h.fake.bodies('sendMessage').at(-1)?.reply_markup,
    );

    h.fake.push(callbackUpdate({ data: token, userId: CHAT }));
    await settle();

    expect(h.fake.bodies('answerCallbackQuery')).toHaveLength(1);
  });

  it('refuses a button pressed by someone not on the allowlist', async () => {
    // Anybody in a group can tap a button the bot posted. Without this check an
    // approval is answerable by a stranger.
    const h = await untilApproval();
    const token = firstButton(
      h.fake.bodies('sendMessage').at(-1)?.reply_markup,
    );

    h.fake.push(callbackUpdate({ data: token, userId: 999 }));
    await settle();

    expect(
      h.hub.only().frames.filter((frame) => frame.type === 'tool.approve'),
    ).toHaveLength(0);
    expect(h.fake.bodies('answerCallbackQuery')[0]?.text).toBe('Not for you.');
  });

  it('tells a reader when a button has gone stale', async () => {
    const h = await start();

    h.fake.push(callbackUpdate({ data: 'zzz', userId: CHAT }));
    await settle();

    expect(String(h.fake.bodies('answerCallbackQuery')[0]?.text)).toContain(
      'expired',
    );
  });

  it('rewrites the card into what was decided', async () => {
    const h = await untilApproval();
    const token = firstButton(
      h.fake.bodies('sendMessage').at(-1)?.reply_markup,
    );

    h.fake.push(callbackUpdate({ data: token, userId: CHAT }));
    await settle();

    expect(h.fake.bodies('editMessageText').at(-1)?.text).toContain('Approved');
  });
});

describe('shutting down', () => {
  it('stops polling and says nothing more', async () => {
    const h = await start();
    h.fake.push(messageUpdate({ text: 'a question', userId: CHAT }));
    await settle();
    const before = h.fake.texts().length;

    await h.manager.stop();
    h.fake.push(messageUpdate({ text: 'too late', userId: CHAT }));
    await settle();

    expect(h.fake.texts()).toHaveLength(before);
  });

  it('awaits the poll rather than racing the abort', async () => {
    const h = await start();

    // Resolving means the loop unwound; a hang here is the open-handle bug.
    await expect(h.manager.stop()).resolves.toBeUndefined();
  });
});

describe('a failing poll', () => {
  it('backs off, doubling, rather than spinning', async () => {
    // Queued before `start`, because by the time the manager returns the loop
    // is already parked inside its first `getUpdates` and would never see it.
    const h = await start({
      arrange: (fake) => {
        fake.reply('getUpdates', { throws: new Error('ECONNREFUSED') });
      },
    });
    await settle();

    // `manualClock.sleep` advances instead of waiting, so the cadence is
    // observable in a suite that finishes in milliseconds.
    expect(h.clock.slept.slice(0, 3)).toEqual([1000, 2000, 4000]);
  });

  it('caps the backoff at a minute', async () => {
    const h = await start({
      arrange: (fake) => {
        fake.reply('getUpdates', { throws: new Error('down') });
      },
    });
    for (let i = 0; i < 8; i += 1) await settle();

    expect(h.clock.slept.length).toBeGreaterThan(3);
    for (const delay of h.clock.slept) {
      expect(delay).toBeLessThanOrEqual(60_000);
    }
  });

  it('names a second poller as the operator mistake it is', async () => {
    // A 409 that survived `deleteWebhook` means another process is polling the
    // same bot. There is no clever recovery — the two take turns stealing each
    // other's updates — so the log line is the fix.
    const h = await start({
      arrange: (fake) => {
        fake.fail('getUpdates', { code: 409, description: 'Conflict' });
      },
    });
    await settle();

    expect(h.clock.slept.length).toBeGreaterThan(0);
  });
});

/** The `callback_data` of the first button on a keyboard. */
function firstButton(markup: unknown): string {
  const rows = (
    markup as {
      inline_keyboard?: Array<Array<{ callback_data: string }>>;
    }
  ).inline_keyboard;
  const token = rows?.[0]?.[0]?.callback_data;
  if (token === undefined) throw new Error('That keyboard has no buttons');
  return token;
}

describe('buttons', () => {
  /** Runs a command, then presses the nth button on the card it produced. */
  async function press(h: Harness, command: string, index = 0): Promise<void> {
    h.fake.push(messageUpdate({ text: command, userId: CHAT }));
    await settle();
    const markup = h.fake.bodies('sendMessage').at(-1)?.reply_markup;
    h.fake.push(
      callbackUpdate({ data: nthButton(markup, index), userId: CHAT }),
    );
    await settle();
  }

  it('attaches to the conversation a session button names', async () => {
    const h = await start();
    h.console.store.ensureSession('telegram:42:other', {
      origin: 'telegram',
      title: 'Elsewhere',
    });

    await press(h, '/sessions');
    h.fake.push(messageUpdate({ text: 'now where am I', userId: CHAT }));
    await settle();

    expect(h.hub.connections.map((c) => c.sessionKey)).toContain(
      'telegram:42:other',
    );
  });

  it('binds the agent an agent button names', async () => {
    const h = await start();

    await press(h, '/agent');

    expect(
      h.console.store.getSession(`telegram:${String(CHAT)}`)?.agentId,
    ).toBe('default');
  });

  it('moves the conversation a workspace button names', async () => {
    const h = await start();

    await press(h, '/workspace');

    expect(
      h.console.store.getSession(`telegram:${String(CHAT)}`)?.workspaceId,
    ).toBe('default');
  });

  it('moves the process when an admin picks a model', async () => {
    const h = await start();

    await press(h, '/model');

    expect(h.console.modelsSet).toEqual(['gpt-4o']);
  });

  it('refuses a model button pressed by someone who is not an admin', async () => {
    // The card was posted for an admin; the press is checked on its own.
    const h = await start({ settings: { admins: ['999'] } });
    h.fake.push(messageUpdate({ text: '/model', userId: CHAT }));
    await settle();

    // A non-admin cannot even get the card, so the refusal is the reply.
    expect(h.fake.texts().at(-1)).toContain('administrator');
    expect(h.console.modelsSet).toEqual([]);
  });

  it('deletes only after the button is pressed', async () => {
    const h = await start();
    h.console.store.ensureSession(`telegram:${String(CHAT)}`, {
      origin: 'telegram',
    });

    await press(h, '/delete');

    expect(
      h.console.store.getSession(`telegram:${String(CHAT)}`),
    ).toBeUndefined();
  });

  it('pages a listing without remembering one', async () => {
    const h = await start();
    for (let i = 0; i < 12; i += 1) {
      h.console.store.ensureSession(`telegram:42:s${String(i)}`, {
        origin: 'telegram',
        title: `Session ${String(i)}`,
      });
    }
    h.fake.push(messageUpdate({ text: '/sessions', userId: CHAT }));
    await settle();

    const markup = h.fake.bodies('sendMessage').at(-1)?.reply_markup;
    const rows = (
      markup as { inline_keyboard: Array<Array<{ callback_data: string }>> }
    ).inline_keyboard;
    const next = rows.at(-1)?.at(-1)?.callback_data ?? '';
    h.fake.push(callbackUpdate({ data: next, userId: CHAT }));
    await settle();

    // A second card, built fresh from the store rather than from kept state.
    expect(h.fake.bodies('sendMessage').length).toBeGreaterThan(1);
  });
});

/** The `callback_data` of the nth button, reading left to right, top to bottom. */
function nthButton(markup: unknown, index: number): string {
  const rows = (
    markup as {
      inline_keyboard?: Array<Array<{ callback_data: string }>>;
    }
  ).inline_keyboard;
  const token = (rows ?? []).flat()[index]?.callback_data;
  if (token === undefined) throw new Error('That keyboard has no such button');
  return token;
}
