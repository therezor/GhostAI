import { describe, expect, it } from 'vitest';

import { silentLogger } from '@ghostai/core';

import { BotApi } from '#src/telegram/api.js';
import type { ChatState } from '#src/telegram/chats.js';
import { TelegramRenderer, stripMarkdown } from '#src/telegram/render.js';

import { FakeBotApi } from './fake-bot-api.js';
import { manualClock, type ManualClock } from './manual-clock.js';

const CHAT = 42;

interface Setup {
  readonly fake: FakeBotApi;
  readonly renderer: TelegramRenderer;
  readonly chat: ChatState;
  readonly clock: ManualClock;
}

function setup(prefs: Partial<ChatState['prefs']> = {}): Setup {
  const fake = new FakeBotApi();
  const clock = manualClock();
  const renderer = new TelegramRenderer({
    api: new BotApi({ token: 't', apiBase: 'x', fetchImpl: fake.fetch }),
    clock,
    logger: silentLogger,
    editIntervalMs: 2000,
  });
  const chat: ChatState = {
    sessionKey: 'telegram:42',
    liveMessageId: undefined,
    liveTurnId: undefined,
    lastEditMs: 0,
    prefs: { progress: true, markdown: true, ...prefs },
  };
  return { fake, renderer, chat, clock };
}

describe('posting', () => {
  it('sends one message, formatted', async () => {
    const s = setup();

    await s.renderer.render({
      chatId: CHAT,
      chat: s.chat,
      text: 'Done.',
      kind: 'reply',
    });

    expect(s.fake.bodies('sendMessage')[0]).toMatchObject({
      chat_id: CHAT,
      text: 'Done\\.',
      parse_mode: 'MarkdownV2',
    });
  });

  it('sends plain text, with no parse mode, when markdown is off', async () => {
    const s = setup({ markdown: false });

    await s.renderer.render({
      chatId: CHAT,
      chat: s.chat,
      text: 'Done.',
      kind: 'reply',
    });

    const body = s.fake.bodies('sendMessage')[0];
    expect(body?.text).toBe('Done.');
    expect('parse_mode' in (body ?? {})).toBe(false);
  });

  it('splits an answer that outgrows one message', async () => {
    const s = setup({ markdown: false });

    await s.renderer.render({
      chatId: CHAT,
      chat: s.chat,
      text: Array.from({ length: 600 }, (slot, i) => `line ${String(i)}`).join(
        '\n',
      ),
      kind: 'reply',
    });

    const sent = s.fake.bodies('sendMessage');
    expect(sent.length).toBeGreaterThan(1);
    for (const body of sent) {
      expect(String(body.text).length).toBeLessThanOrEqual(4096);
    }
  });

  it('puts the buttons on the last piece only', async () => {
    const s = setup({ markdown: false });
    const keyboard = {
      inline_keyboard: [[{ text: 'Yes', callback_data: '1' }]],
    };

    await s.renderer.render({
      chatId: CHAT,
      chat: s.chat,
      text: 'x'.repeat(5000),
      kind: 'notice',
      keyboard,
    });

    const sent = s.fake.bodies('sendMessage');
    expect('reply_markup' in (sent[0] ?? {})).toBe(false);
    expect('reply_markup' in (sent.at(-1) ?? {})).toBe(true);
  });

  it('returns the id of the first message, for a card it will edit later', async () => {
    const s = setup();

    const id = await s.renderer.render({
      chatId: CHAT,
      chat: s.chat,
      text: 'approve?',
      kind: 'notice',
    });

    expect(typeof id).toBe('number');
  });
});

describe('the plain-text retry', () => {
  it('resends without markdown when Telegram refuses to parse it', async () => {
    // The safety net that lets the formatter stay small: a gap in it costs
    // formatting, not the answer.
    const s = setup();
    s.fake.fail('sendMessage', {
      code: 400,
      description: "Bad Request: can't parse entities",
    });

    await s.renderer.render({
      chatId: CHAT,
      chat: s.chat,
      text: 'Done.',
      kind: 'reply',
    });

    const sent = s.fake.bodies('sendMessage');
    expect(sent).toHaveLength(2);
    // Without `parse_mode`, and with the escaping undone — a message full of
    // backslashes looks worse than the one that failed.
    expect('parse_mode' in (sent[1] ?? {})).toBe(false);
    expect(sent[1]?.text).toBe('Done.');
  });

  it('gives up quietly when the retry fails too', async () => {
    const s = setup();
    s.fake.fail('sendMessage', { code: 400, description: 'nope' });
    s.fake.fail('sendMessage', { code: 400, description: 'still nope' });

    await expect(
      s.renderer.render({
        chatId: CHAT,
        chat: s.chat,
        text: 'x',
        kind: 'reply',
      }),
    ).resolves.toBeUndefined();
  });

  it('drops a rate-limited message rather than stalling every other chat', async () => {
    // `ChannelManager.tails` is keyed by channel, not by chat: a sleep here is
    // a stall for every conversation in the install.
    const s = setup();
    s.fake.fail('sendMessage', {
      code: 429,
      description: 'Too Many Requests',
      retryAfterSec: 30,
    });

    await s.renderer.render({
      chatId: CHAT,
      chat: s.chat,
      text: 'x',
      kind: 'reply',
    });

    expect(s.fake.bodies('sendMessage')).toHaveLength(1);
  });

  it('never retries a progress message', async () => {
    // Disposable by construction: the reply behind it carries the same text.
    const s = setup();
    s.fake.fail('sendMessage', { code: 400, description: 'nope' });

    await s.renderer.render({
      chatId: CHAT,
      chat: s.chat,
      text: 'partial',
      kind: 'progress',
      turnId: 't1',
    });

    expect(s.fake.bodies('sendMessage')).toHaveLength(1);
  });
});

describe('a turn filling one message in', () => {
  it('claims the message its first progress posted', async () => {
    const s = setup();

    await s.renderer.render({
      chatId: CHAT,
      chat: s.chat,
      text: 'thinking',
      kind: 'progress',
      turnId: 't1',
    });

    expect(s.chat.liveMessageId).toBeDefined();
    expect(s.chat.liveTurnId).toBe('t1');
  });

  it('edits rather than posting again, for the same turn', async () => {
    const s = setup();
    await s.renderer.render({
      chatId: CHAT,
      chat: s.chat,
      text: 'partial',
      kind: 'progress',
      turnId: 't1',
    });
    s.clock.advance(5000);

    await s.renderer.render({
      chatId: CHAT,
      chat: s.chat,
      text: 'the whole answer',
      kind: 'reply',
      turnId: 't1',
    });

    expect(s.fake.bodies('sendMessage')).toHaveLength(1);
    expect(s.fake.bodies('editMessageText')[0]?.text).toBe('the whole answer');
  });

  it('releases the message when the turn ends', async () => {
    const s = setup();
    await s.renderer.render({
      chatId: CHAT,
      chat: s.chat,
      text: 'partial',
      kind: 'progress',
      turnId: 't1',
    });
    s.clock.advance(5000);
    await s.renderer.render({
      chatId: CHAT,
      chat: s.chat,
      text: 'done',
      kind: 'reply',
      turnId: 't1',
    });

    // The next turn starts its own message rather than overwriting this one.
    expect(s.chat.liveMessageId).toBeUndefined();
  });

  it('posts fresh for another turn’s message', async () => {
    const s = setup();
    await s.renderer.render({
      chatId: CHAT,
      chat: s.chat,
      text: 'partial',
      kind: 'progress',
      turnId: 't1',
    });

    await s.renderer.render({
      chatId: CHAT,
      chat: s.chat,
      text: 'a different turn',
      kind: 'reply',
      turnId: 't2',
    });

    expect(s.fake.bodies('sendMessage')).toHaveLength(2);
  });

  it('never lets a notice overwrite the answer', async () => {
    const s = setup();
    await s.renderer.render({
      chatId: CHAT,
      chat: s.chat,
      text: 'partial',
      kind: 'progress',
      turnId: 't1',
    });

    await s.renderer.render({
      chatId: CHAT,
      chat: s.chat,
      text: 'something went wrong',
      kind: 'error',
      turnId: 't1',
    });

    expect(s.fake.bodies('sendMessage')).toHaveLength(2);
    expect(s.fake.bodies('editMessageText')).toHaveLength(0);
  });

  it('skips a progress edit inside the debounce window', async () => {
    // Telegram allows about one message per second per chat.
    const s = setup();
    await s.renderer.render({
      chatId: CHAT,
      chat: s.chat,
      text: 'a',
      kind: 'progress',
      turnId: 't1',
    });

    s.clock.advance(500);
    await s.renderer.render({
      chatId: CHAT,
      chat: s.chat,
      text: 'ab',
      kind: 'progress',
      turnId: 't1',
    });

    expect(s.fake.bodies('editMessageText')).toHaveLength(0);
  });

  it('lets a reply through the debounce, because it is the answer', async () => {
    const s = setup();
    await s.renderer.render({
      chatId: CHAT,
      chat: s.chat,
      text: 'a',
      kind: 'progress',
      turnId: 't1',
    });

    await s.renderer.render({
      chatId: CHAT,
      chat: s.chat,
      text: 'the answer',
      kind: 'reply',
      turnId: 't1',
    });

    expect(s.fake.bodies('editMessageText')).toHaveLength(1);
  });

  it('stops editing once an answer outgrows one message', async () => {
    const s = setup({ markdown: false });
    await s.renderer.render({
      chatId: CHAT,
      chat: s.chat,
      text: 'a',
      kind: 'progress',
      turnId: 't1',
    });

    await s.renderer.render({
      chatId: CHAT,
      chat: s.chat,
      text: 'x'.repeat(5000),
      kind: 'reply',
      turnId: 't1',
    });

    expect(s.chat.liveMessageId).toBeUndefined();
    expect(s.fake.bodies('sendMessage').length).toBeGreaterThan(1);
  });

  it('says nothing at all when progress is switched off for the chat', async () => {
    const s = setup({ progress: false });

    await s.renderer.render({
      chatId: CHAT,
      chat: s.chat,
      text: 'thinking',
      kind: 'progress',
      turnId: 't1',
    });

    expect(s.fake.calls).toHaveLength(0);
  });

  it('swallows an edit that changed nothing', async () => {
    // A delta that added no visible characters re-renders to the same string,
    // and Telegram calls that a 400.
    const s = setup();
    await s.renderer.render({
      chatId: CHAT,
      chat: s.chat,
      text: 'a',
      kind: 'progress',
      turnId: 't1',
    });
    s.fake.fail('editMessageText', {
      code: 400,
      description: 'Bad Request: message is not modified',
    });

    await expect(
      s.renderer.render({
        chatId: CHAT,
        chat: s.chat,
        text: 'a',
        kind: 'reply',
        turnId: 't1',
      }),
    ).resolves.toBeUndefined();
  });

  it('survives an edit that failed for a real reason', async () => {
    const s = setup();
    await s.renderer.render({
      chatId: CHAT,
      chat: s.chat,
      text: 'a',
      kind: 'progress',
      turnId: 't1',
    });
    s.fake.fail('editMessageText', { code: 400, description: 'gone' });

    await expect(
      s.renderer.render({
        chatId: CHAT,
        chat: s.chat,
        text: 'b',
        kind: 'reply',
        turnId: 't1',
      }),
    ).resolves.toBeUndefined();
  });
});

describe('update', () => {
  it('rewrites a card this channel posted', async () => {
    const s = setup();

    await s.renderer.update({
      chatId: CHAT,
      messageId: 7,
      text: 'Approved.',
      markdown: true,
    });

    expect(s.fake.bodies('editMessageText')[0]).toMatchObject({
      message_id: 7,
      text: 'Approved\\.',
    });
  });

  it('is quiet when the card already says that', async () => {
    const s = setup();
    s.fake.fail('editMessageText', {
      code: 400,
      description: 'Bad Request: message is not modified',
    });

    await expect(
      s.renderer.update({
        chatId: CHAT,
        messageId: 7,
        text: 'same',
        markdown: false,
      }),
    ).resolves.toBeUndefined();
  });

  it('is quiet when the card is gone', async () => {
    const s = setup();
    s.fake.fail('editMessageText', {
      code: 400,
      description: 'message to edit not found',
    });

    await expect(
      s.renderer.update({
        chatId: CHAT,
        messageId: 7,
        text: 'x',
        markdown: false,
      }),
    ).resolves.toBeUndefined();
  });
});

describe('stripMarkdown', () => {
  it('undoes the escaping, so a retry does not show backslashes', () => {
    expect(stripMarkdown('Done\\. 2 \\* 3\\.')).toBe('Done. 2 * 3.');
  });

  it('leaves an unescaped backslash alone', () => {
    expect(stripMarkdown('C:\\\\Users')).toBe('C:\\Users');
  });
});
