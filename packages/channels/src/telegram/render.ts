/**
 * Putting one outbound message on Telegram.
 *
 * Separate from the channel because it is a second job: the channel decides
 * *what* to say, and this decides how a chat app can be made to show it. Three
 * constraints shape everything here, and only the first is obvious.
 *
 *  - **4096 characters, and MarkdownV2 or nothing.** `format.ts` owns both; the
 *    one thing added here is the retry. A message Telegram will not parse is
 *    sent again as plain text rather than lost, and that fallback is what lets
 *    the formatter stay small — a gap in it costs formatting, not the answer.
 *
 *  - **A turn owns one message.** `metadata.turnId` is already stamped by the
 *    manager, so a turn's first `progress` is posted and everything after it
 *    edits that message: the answer arrives by filling in rather than by being
 *    repeated twice, once in pieces and once whole. `notice` and `error` always
 *    post fresh, because an answer must not overwrite the warning before it.
 *
 *  - **Every chat shares one delivery chain.** `ChannelManager.tails` is keyed
 *    by *channel*, not by chat, so a `send` that sleeps on a `retry_after`
 *    stalls every other conversation in the install. Nothing here sleeps. A
 *    rate-limited `progress` is dropped — it is disposable by construction, and
 *    the `reply` behind it carries the same text — and anything else is retried
 *    once and then left to throw, which the manager logs and drops.
 */

import type { Clock, Logger, OutboundKind } from '@ghostai/core';

import type { BotApi, InlineKeyboardMarkup } from './api.js';
import { TelegramApiError } from './api.js';
import type { ChatState } from './chats.js';
import { chunkMessage, toMarkdownV2 } from './format.js';

/** A longer wait than this would hold up every other chat, so it is dropped. */
const MAX_RETRY_AFTER_SEC = 1;

export interface RendererOptions {
  readonly api: BotApi;
  readonly clock: Clock;
  readonly logger: Logger;
  /** The floor between two edits of one turn's message. */
  readonly editIntervalMs: number;
}

interface RenderRequest {
  readonly chatId: number;
  readonly chat: ChatState;
  readonly text: string;
  readonly kind: OutboundKind;
  /** Present for anything scoped to a turn. What groups the edits. */
  readonly turnId?: string | undefined;
  /** Attached to the last piece, when there is one. */
  readonly keyboard?: InlineKeyboardMarkup | undefined;
}

export class TelegramRenderer {
  private readonly api: BotApi;
  private readonly clock: Clock;
  private readonly logger: Logger;
  private readonly editIntervalMs: number;

  constructor(options: RendererOptions) {
    this.api = options.api;
    this.clock = options.clock;
    this.logger = options.logger;
    this.editIntervalMs = options.editIntervalMs;
  }

  /**
   * Says one thing in one chat. Returns the first message id it posted.
   *
   * The caller wants that id for a card it will edit later — an approval
   * becoming "Approved, waiting for the agent" — and gets `undefined` when the
   * message was an edit, was skipped, or could not be sent at all.
   */
  async render(request: RenderRequest): Promise<number | undefined> {
    const { chat, kind } = request;
    if (kind === 'progress' && !chat.prefs.progress) return undefined;

    const body = chat.prefs.markdown
      ? toMarkdownV2(request.text)
      : request.text;
    const pieces = chunkMessage(body);

    // One piece, on the message this turn already owns: an edit.
    if (pieces.length === 1 && this.owns(request)) {
      await this.edit(request, pieces[0] ?? '');
      return undefined;
    }

    // Anything else posts, and whatever the turn owned stops being live —
    // an answer that outgrew one message cannot keep collecting edits into it.
    this.release(chat);
    return await this.postAll(request, pieces);
  }

  /** Rewrites a message this channel posted earlier. For a settled card. */
  async update(input: {
    chatId: number;
    messageId: number;
    text: string;
    markdown: boolean;
  }): Promise<void> {
    try {
      await this.api.editMessageText({
        chatId: input.chatId,
        messageId: input.messageId,
        text: input.markdown ? toMarkdownV2(input.text) : input.text,
        ...(input.markdown ? { parseMode: 'MarkdownV2' as const } : {}),
      });
    } catch (error) {
      if (error instanceof TelegramApiError && error.isNotModified) return;
      this.warn('telegram card update failed', error);
    }
  }

  /** Whether this message belongs to the turn the live message is holding. */
  private owns(request: RenderRequest): boolean {
    const { chat, kind, turnId } = request;
    return (
      (kind === 'reply' || kind === 'progress') &&
      turnId !== undefined &&
      chat.liveTurnId === turnId &&
      chat.liveMessageId !== undefined
    );
  }

  private release(chat: ChatState): void {
    chat.liveMessageId = undefined;
    chat.liveTurnId = undefined;
  }

  private async postAll(
    request: RenderRequest,
    pieces: readonly string[],
  ): Promise<number | undefined> {
    let first: number | undefined;

    for (const [index, piece] of pieces.entries()) {
      const posted = await this.post({
        ...request,
        text: piece,
        // Only the last piece carries the buttons, so a keyboard is not
        // repeated once per chunk of a long card.
        keyboard: index === pieces.length - 1 ? request.keyboard : undefined,
      });
      if (index === 0) first = posted;
    }

    // A `progress` claims the message it just posted, so the rest of the turn
    // fills it in. A `reply` never does: the turn is over.
    if (
      request.kind === 'progress' &&
      first !== undefined &&
      request.turnId !== undefined &&
      pieces.length === 1
    ) {
      request.chat.liveMessageId = first;
      request.chat.liveTurnId = request.turnId;
      request.chat.lastEditMs = this.clock.now();
    }
    return first;
  }

  private async post(request: RenderRequest): Promise<number | undefined> {
    const send = async (markdown: boolean): Promise<number> => {
      const message = await this.api.sendMessage({
        chatId: request.chatId,
        text: markdown ? request.text : stripMarkdown(request.text),
        ...(markdown ? { parseMode: 'MarkdownV2' as const } : {}),
        ...(request.keyboard === undefined
          ? {}
          : { replyMarkup: request.keyboard }),
      });
      return message.message_id;
    };

    try {
      return await send(request.chat.prefs.markdown);
    } catch (error) {
      if (!this.retryable(error, request.kind)) return undefined;
      // Deliberately without `parse_mode`. The commonest reason a message is
      // refused is a construct the formatter mis-escaped, and re-sending the
      // same bytes would be refused the same way.
      try {
        return await send(false);
      } catch (retried) {
        this.warn('telegram send failed', retried);
        return undefined;
      }
    }
  }

  private async edit(request: RenderRequest, text: string): Promise<void> {
    const { chat } = request;
    const messageId = chat.liveMessageId;
    if (messageId === undefined) return;

    // Telegram allows roughly one message per second per chat. A `reply` always
    // lands, because it is the answer; an intermediate `progress` is skipped
    // rather than queued, since the next one carries everything it did.
    if (
      request.kind === 'progress' &&
      this.clock.now() - chat.lastEditMs < this.editIntervalMs
    ) {
      return;
    }

    try {
      await this.api.editMessageText({
        chatId: request.chatId,
        messageId,
        text: chat.prefs.markdown ? text : stripMarkdown(text),
        ...(chat.prefs.markdown ? { parseMode: 'MarkdownV2' as const } : {}),
      });
      chat.lastEditMs = this.clock.now();
    } catch (error) {
      // Identical text is normal rather than a fault: a delta that added no
      // visible characters re-renders to the same string.
      if (!(error instanceof TelegramApiError && error.isNotModified)) {
        this.warn('telegram edit failed', error);
      }
    }
    if (request.kind === 'reply') this.release(chat);
  }

  /**
   * Whether to try once more, or let this one go.
   *
   * A rate limit longer than a second is never waited out: the sleep would sit
   * on the chain every other conversation is queued behind.
   */
  private retryable(error: unknown, kind: OutboundKind): boolean {
    if (!(error instanceof TelegramApiError)) return false;
    const retryAfter = error.retryAfterSec;
    if (retryAfter !== undefined && retryAfter > MAX_RETRY_AFTER_SEC) {
      this.logger.warn(
        { channel: 'telegram', kind, retryAfterSec: retryAfter },
        'telegram rate limited; dropped rather than stalling every chat',
      );
      return false;
    }
    return kind !== 'progress';
  }

  private warn(message: string, error: unknown): void {
    // Structured, and never the request URL — it carries the bot token.
    this.logger.warn({ channel: 'telegram', err: error }, message);
  }
}

/**
 * Undoes MarkdownV2 escaping, for the plain-text retry.
 *
 * The text reaching a retry has already been through `toMarkdownV2`, so it is
 * full of backslashes that would otherwise be shown literally — a worse-looking
 * message than the one that failed.
 */
export function stripMarkdown(text: string): string {
  return text.replace(/\\([_*[\]()~`>#+\-=|{}.!\\])/gu, '$1');
}
