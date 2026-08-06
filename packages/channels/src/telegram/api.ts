/**
 * The Bot API, as much of it as a chat channel needs.
 *
 * Hand-written over `fetch`, the way `@ghostai/providers` writes the
 * `openai-chat` adapter, and for the same two reasons: the surface actually
 * used here is seven methods, and a dependency that wraps the whole API brings
 * its own update loop, its own session store and its own opinion about
 * middleware — none of which can be reconciled with a `ChannelManager` that
 * already owns the lifecycle.
 *
 * Three things in here are load-bearing:
 *
 *  - **The token is in the URL.** `api.telegram.org/bot<token>/sendMessage` is
 *    the Bot API's design, not a choice, and it means a logged request URL is a
 *    leaked credential. Nothing in this file logs a URL, and `TelegramApiError`
 *    carries the *method* rather than the address it was called at.
 *  - **`fetch` is injected.** Every test drives a fake, so no test opens a
 *    socket and the error paths — 429, 409, a body that is not JSON — are
 *    reachable without a network. Same seam, same reason, as `fetchImpl` on the
 *    provider.
 *  - **A Telegram failure is a value, not a status code.** The API answers
 *    `200 {ok: false}` as readily as it answers `400`, so the unwrapping below
 *    reads `ok` rather than `response.ok`, and `retry_after` is lifted out of
 *    `parameters` where the rate limiter puts it.
 */

/**
 * `fetch`, narrowed to what this file asks of it.
 *
 * Declared here rather than imported: `FetchImplementation` lives in
 * `@ghostai/security`, which this package does not depend on and should not
 * start depending on for a type alias. The global `fetch` satisfies this.
 */
export type FetchLike = (
  url: string,
  init: {
    readonly method: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body: string;
    readonly signal?: AbortSignal;
  },
) => Promise<{
  readonly status: number;
  json(): Promise<unknown>;
}>;

/** What the Bot API said went wrong. */
export class TelegramApiError extends Error {
  /** Telegram's `error_code`, or the HTTP status when it sent no body. */
  readonly code: number;
  /** Seconds to wait, when this was a rate limit. */
  readonly retryAfterSec: number | undefined;
  /** The API method, never the URL — the URL contains the bot token. */
  readonly method: string;

  constructor(input: {
    method: string;
    code: number;
    description: string;
    retryAfterSec?: number | undefined;
  }) {
    super(
      `Telegram ${input.method} failed (${String(input.code)}): ${input.description}`,
    );
    this.name = 'TelegramApiError';
    this.code = input.code;
    this.method = input.method;
    this.retryAfterSec = input.retryAfterSec;
  }

  /** A second poller on the same token, or a webhook still registered. */
  get isConflict(): boolean {
    return this.code === 409;
  }

  /** The token is wrong or revoked. Fatal at startup, by design. */
  get isUnauthorized(): boolean {
    return this.code === 401;
  }

  /**
   * An edit that changed nothing.
   *
   * Normal rather than exceptional: a turn whose last delta added no visible
   * text re-renders to the same string, and Telegram calls that a 400.
   */
  get isNotModified(): boolean {
    return this.message.includes('message is not modified');
  }
}

// ---------------------------------------------------------------------------
// The slice of Telegram's types this channel reads
// ---------------------------------------------------------------------------

export interface TelegramUser {
  readonly id: number;
  readonly username?: string;
}

interface TelegramChat {
  readonly id: number;
  /** `private`, `group`, `supergroup`, `channel`. */
  readonly type: string;
}

interface TelegramMessageEntity {
  readonly type: string;
  readonly offset: number;
  readonly length: number;
}

export interface TelegramMessage {
  readonly message_id: number;
  readonly chat: TelegramChat;
  readonly from?: TelegramUser;
  readonly text?: string;
  readonly entities?: readonly TelegramMessageEntity[];
}

export interface TelegramCallbackQuery {
  readonly id: string;
  readonly from: TelegramUser;
  readonly data?: string;
  readonly message?: TelegramMessage;
}

export interface TelegramUpdate {
  readonly update_id: number;
  readonly message?: TelegramMessage;
  readonly callback_query?: TelegramCallbackQuery;
}

/** One button. `callback_data` is capped at 64 *bytes* by Telegram. */
export interface InlineKeyboardButton {
  readonly text: string;
  readonly callback_data: string;
}

export interface InlineKeyboardMarkup {
  readonly inline_keyboard: ReadonlyArray<readonly InlineKeyboardButton[]>;
}

export interface BotCommand {
  readonly command: string;
  readonly description: string;
}

interface SendMessageInput {
  readonly chatId: number;
  readonly text: string;
  /** Omitted entirely for the plain-text retry. */
  readonly parseMode?: 'MarkdownV2' | undefined;
  readonly replyMarkup?: InlineKeyboardMarkup | undefined;
}

interface EditMessageInput extends SendMessageInput {
  readonly messageId: number;
}

interface BotApiOptions {
  readonly token: string;
  readonly apiBase: string;
  /** Defaults to the global `fetch`. Every test supplies its own. */
  readonly fetchImpl?: FetchLike | undefined;
}

/** Reads `{ok, result, description, parameters}` without trusting any of it. */
function unwrap(method: string, status: number, body: unknown): unknown {
  const envelope =
    typeof body === 'object' && body !== null
      ? (body as Record<string, unknown>)
      : {};

  if (envelope.ok === true) return envelope.result;

  const parameters =
    typeof envelope.parameters === 'object' && envelope.parameters !== null
      ? (envelope.parameters as Record<string, unknown>)
      : {};
  const retryAfter = parameters.retry_after;

  throw new TelegramApiError({
    method,
    // Telegram answers `200 {ok: false}` as happily as it answers `400`, so
    // its own code wins when there is one.
    code:
      typeof envelope.error_code === 'number' ? envelope.error_code : status,
    description:
      typeof envelope.description === 'string'
        ? envelope.description
        : `HTTP ${String(status)}`,
    ...(typeof retryAfter === 'number' ? { retryAfterSec: retryAfter } : {}),
  });
}

export class BotApi {
  private readonly token: string;
  private readonly apiBase: string;
  private readonly fetchImpl: FetchLike;

  constructor(options: BotApiOptions) {
    this.token = options.token;
    this.apiBase = options.apiBase.replace(/\/+$/u, '');
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  /** Confirms the token and gives us the username to strip from commands. */
  async getMe(signal?: AbortSignal): Promise<TelegramUser> {
    return (await this.call('getMe', {}, signal)) as TelegramUser;
  }

  /**
   * Clears a webhook left over from an earlier setup.
   *
   * Called once at start, because a registered webhook makes every `getUpdates`
   * a 409 — and that particular 409 looks exactly like the serious one (a
   * second process polling the same bot) with none of the same cause.
   */
  async deleteWebhook(signal?: AbortSignal): Promise<void> {
    await this.call('deleteWebhook', {}, signal);
  }

  async setMyCommands(
    commands: readonly BotCommand[],
    signal?: AbortSignal,
  ): Promise<void> {
    await this.call('setMyCommands', { commands }, signal);
  }

  async getUpdates(input: {
    readonly offset: number;
    readonly timeoutSec: number;
    readonly signal?: AbortSignal;
  }): Promise<readonly TelegramUpdate[]> {
    const result = await this.call(
      'getUpdates',
      {
        offset: input.offset,
        timeout: input.timeoutSec,
        // Everything else — edits, channel posts, join events — is traffic this
        // channel has no answer for, and asking for it only makes the offset
        // advance over updates nobody reads.
        allowed_updates: ['message', 'callback_query'],
      },
      input.signal,
    );
    return Array.isArray(result) ? (result as TelegramUpdate[]) : [];
  }

  async sendMessage(
    input: SendMessageInput,
    signal?: AbortSignal,
  ): Promise<TelegramMessage> {
    return (await this.call(
      'sendMessage',
      {
        chat_id: input.chatId,
        text: input.text,
        ...(input.parseMode === undefined
          ? {}
          : { parse_mode: input.parseMode }),
        ...(input.replyMarkup === undefined
          ? {}
          : { reply_markup: input.replyMarkup }),
      },
      signal,
    )) as TelegramMessage;
  }

  async editMessageText(
    input: EditMessageInput,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.call(
      'editMessageText',
      {
        chat_id: input.chatId,
        message_id: input.messageId,
        text: input.text,
        ...(input.parseMode === undefined
          ? {}
          : { parse_mode: input.parseMode }),
        ...(input.replyMarkup === undefined
          ? {}
          : { reply_markup: input.replyMarkup }),
      },
      signal,
    );
  }

  /**
   * Answers a button press.
   *
   * Always called, including on a refusal: an unanswered `callback_query`
   * leaves the button spinning in the client until it times out, which reads as
   * a bot that has hung rather than one that said no.
   */
  async answerCallbackQuery(
    input: { readonly id: string; readonly text?: string },
    signal?: AbortSignal,
  ): Promise<void> {
    await this.call(
      'answerCallbackQuery',
      {
        callback_query_id: input.id,
        ...(input.text === undefined ? {} : { text: input.text }),
      },
      signal,
    );
  }

  private async call(
    method: string,
    body: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const response = await this.fetchImpl(
      `${this.apiBase}/bot${this.token}/${method}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        ...(signal === undefined ? {} : { signal }),
      },
    );

    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      // A proxy's HTML error page, or a truncated body. The status is all
      // there is to report, and it is more use than a JSON parse error.
      throw new TelegramApiError({
        method,
        code: response.status,
        description: 'the response body was not JSON',
      });
    }
    return unwrap(method, response.status, parsed);
  }
}
