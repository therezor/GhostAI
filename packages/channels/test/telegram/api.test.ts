import { describe, expect, it } from 'vitest';

import { BotApi, TelegramApiError } from '#src/telegram/api.js';

import { FakeBotApi } from './fake-bot-api.js';

function build(): { api: BotApi; fake: FakeBotApi } {
  const fake = new FakeBotApi();
  const api = new BotApi({
    token: 'secret-token',
    apiBase: 'https://api.telegram.org',
    fetchImpl: fake.fetch,
  });
  return { api, fake };
}

describe('BotApi', () => {
  it('posts JSON to the method’s own endpoint', async () => {
    const { api, fake } = build();

    await api.sendMessage({ chatId: 7, text: 'hi' });

    expect(fake.calls[0]?.method).toBe('sendMessage');
    expect(fake.calls[0]?.body).toEqual({ chat_id: 7, text: 'hi' });
  });

  it('omits parse_mode entirely when there is none', async () => {
    // The plain-text retry depends on this: `parse_mode: undefined` would be
    // serialised away by JSON, but an empty string would not.
    const { api, fake } = build();

    await api.sendMessage({ chatId: 7, text: 'hi' });

    expect('parse_mode' in (fake.calls[0]?.body ?? {})).toBe(false);
  });

  it('sends the keyboard when one is given', async () => {
    const { api, fake } = build();

    await api.sendMessage({
      chatId: 7,
      text: 'approve?',
      parseMode: 'MarkdownV2',
      replyMarkup: { inline_keyboard: [[{ text: 'Yes', callback_data: '1' }]] },
    });

    expect(fake.calls[0]?.body).toMatchObject({
      parse_mode: 'MarkdownV2',
      reply_markup: {
        inline_keyboard: [[{ text: 'Yes', callback_data: '1' }]],
      },
    });
  });

  it('asks only for the update kinds it can answer', async () => {
    const { api, fake } = build();
    fake.push({ message: { message_id: 1, chat: { id: 1, type: 'private' } } });

    await api.getUpdates({ offset: 5, timeoutSec: 30 });

    expect(fake.calls[0]?.body).toEqual({
      offset: 5,
      timeout: 30,
      allowed_updates: ['message', 'callback_query'],
    });
  });

  it('trims a trailing slash off the base rather than doubling it', async () => {
    const fake = new FakeBotApi();
    const api = new BotApi({
      token: 't',
      apiBase: 'https://proxy.example/',
      fetchImpl: fake.fetch,
    });

    await expect(api.getMe()).resolves.toMatchObject({ id: 1 });
  });

  it('reads a 200 that says ok:false as a failure', async () => {
    // Telegram answers this as readily as it answers a 4xx.
    const { api, fake } = build();
    fake.reply('sendMessage', {
      status: 200,
      body: { ok: false, error_code: 400, description: 'chat not found' },
    });

    await expect(api.sendMessage({ chatId: 7, text: 'x' })).rejects.toThrow(
      /chat not found/u,
    );
  });

  it('lifts retry_after out of parameters', async () => {
    const { api, fake } = build();
    fake.fail('sendMessage', {
      code: 429,
      description: 'Too Many Requests',
      retryAfterSec: 17,
    });

    const error = await api
      .sendMessage({ chatId: 7, text: 'x' })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TelegramApiError);
    expect((error as TelegramApiError).retryAfterSec).toBe(17);
  });

  it('recognises the conflict a second poller causes', async () => {
    const { api, fake } = build();
    fake.fail('getUpdates', { code: 409, description: 'Conflict' });

    const error = await api
      .getUpdates({ offset: 0, timeoutSec: 1 })
      .catch((caught: unknown) => caught);

    expect((error as TelegramApiError).isConflict).toBe(true);
  });

  it('recognises a revoked token', async () => {
    const { api, fake } = build();
    fake.fail('getMe', { code: 401, description: 'Unauthorized' });

    const error = await api.getMe().catch((caught: unknown) => caught);

    expect((error as TelegramApiError).isUnauthorized).toBe(true);
  });

  it('recognises an edit that changed nothing', async () => {
    // Normal, not exceptional: a delta that added no visible text re-renders
    // to the same string.
    const { api, fake } = build();
    fake.fail('editMessageText', {
      code: 400,
      description: 'Bad Request: message is not modified',
    });

    const error = await api
      .editMessageText({ chatId: 7, messageId: 1, text: 'same' })
      .catch((caught: unknown) => caught);

    expect((error as TelegramApiError).isNotModified).toBe(true);
  });

  it('reports the status when the body is not JSON at all', async () => {
    // A proxy's HTML error page.
    const fake = new FakeBotApi();
    const api = new BotApi({ token: 't', apiBase: 'x', fetchImpl: fake.fetch });
    fake.reply('getMe', { status: 502, body: undefined });
    // `json()` resolving to undefined is the shape a non-object body takes.

    await expect(api.getMe()).rejects.toThrow(/502/u);
  });

  it('falls back to the HTTP status when Telegram sent no error_code', async () => {
    const { api, fake } = build();
    fake.reply('getMe', { status: 503, body: { ok: false } });

    const error = await api.getMe().catch((caught: unknown) => caught);

    expect((error as TelegramApiError).code).toBe(503);
    expect((error as TelegramApiError).message).toContain('HTTP 503');
  });

  it('never puts the bot token in the error it throws', async () => {
    // The token is in the URL by the Bot API's own design, so an error that
    // quoted the address would be a leaked credential in a log file.
    const { api, fake } = build();
    fake.fail('sendMessage', { code: 400, description: 'nope' });

    const error = await api
      .sendMessage({ chatId: 7, text: 'x' })
      .catch((caught: unknown) => caught);

    expect(String(error)).not.toContain('secret-token');
    expect((error as TelegramApiError).method).toBe('sendMessage');
  });

  it('lets a transport failure through as itself', async () => {
    const { api, fake } = build();
    fake.reply('getMe', { throws: new Error('ECONNREFUSED') });

    await expect(api.getMe()).rejects.toThrow(/ECONNREFUSED/u);
  });

  it('treats a non-array getUpdates result as no updates', async () => {
    const { api, fake } = build();
    fake.reply('getUpdates', { status: 200, body: { ok: true, result: null } });

    await expect(api.getUpdates({ offset: 0, timeoutSec: 1 })).resolves.toEqual(
      [],
    );
  });

  it('answers a callback query, with and without text', async () => {
    const { api, fake } = build();

    await api.answerCallbackQuery({ id: 'q1' });
    await api.answerCallbackQuery({ id: 'q2', text: 'Expired.' });

    expect(fake.bodies('answerCallbackQuery')).toEqual([
      { callback_query_id: 'q1' },
      { callback_query_id: 'q2', text: 'Expired.' },
    ]);
  });

  it('registers the command list and clears a stale webhook', async () => {
    const { api, fake } = build();

    await api.deleteWebhook();
    await api.setMyCommands([{ command: 'help', description: 'this list' }]);

    expect(fake.calls.map((call) => call.method)).toEqual([
      'deleteWebhook',
      'setMyCommands',
    ]);
    expect(fake.bodies('setMyCommands')[0]).toEqual({
      commands: [{ command: 'help', description: 'this list' }],
    });
  });
});
