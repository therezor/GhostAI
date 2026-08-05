/**
 * The Telegram channel: a long poll, an allowlist, and the four things a
 * channel does.
 *
 * Everything difficult is in a neighbouring module — the Bot API in `api.ts`,
 * escaping and chunking in `format.ts`, the command table in `commands.ts`,
 * buttons in `menus.ts`, the outbound policy in `render.ts` — so what is left
 * here is the lifecycle and the routing, which is the part worth being able to
 * read in one sitting.
 *
 * Four decisions are load-bearing:
 *
 *  - **`start()` does not await the loop.** `ChannelManager.start()` awaits
 *    `channel.start()`, so a method that ran the poll inline would never
 *    return and the server would never finish booting. It confirms the token,
 *    clears a stale webhook, registers the commands, and *then* kicks the loop
 *    off unawaited; `stop()` is what awaits it.
 *
 *  - **A bad token throws from `start()`.** That is the contract `channel.ts`
 *    states, and it is what makes a wrong credential a startup error rather
 *    than a channel that is silently dead.
 *
 *  - **Switching conversation is publishing a different key.** The manager
 *    derives a session from whatever key arrives, so `/new` and `/session`
 *    change this channel's own map and the next message lands on a different
 *    hub connection. There is no switch frame, and there deliberately is not
 *    one — see `ChannelControlFrame`.
 *
 *  - **Every inbound path goes through the allowlist**, messages and button
 *    presses alike. A press is an authorisation decision arriving from a person
 *    Telegram will happily let into any group the bot is in.
 */

import {
  GhostError,
  textPart,
  type Clock,
  type Logger,
  type OutboundKind,
  type OutboundMessage,
} from '@ghostai/core';
import { newUuid, type ApprovalScope } from '@ghostai/protocol';

import type {
  Channel,
  ChannelContext,
  ChannelControlFrame,
  ChannelFactory,
} from '../channel.js';
import type { ApprovalDraftDetail } from '../projection.js';
import {
  BotApi,
  TelegramApiError,
  type FetchLike,
  type TelegramCallbackQuery,
  type TelegramMessage,
  type TelegramUpdate,
  type TelegramUser,
} from './api.js';
import { AccessList } from './access.js';
import { ChatBook, defaultSessionKey } from './chats.js';
import {
  botCommands,
  parseCommand,
  runCommand,
  type CommandResult,
} from './commands.js';
import type { TelegramConsole } from './console.js';
import {
  CallbackStore,
  approvalKeyboard,
  pickerKeyboard,
  type CallbackPayload,
} from './menus.js';
import { TelegramRenderer } from './render.js';
import { parseTelegramSettings, type TelegramSettings } from './settings.js';

/** Backoff after a failed poll: one second, doubling, capped at a minute. */
const FIRST_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 60_000;

export interface TelegramChannelOptions {
  /**
   * The bot token, resolved by whoever builds this.
   *
   * Not read from `settings`, and not read from the environment here:
   * `ChannelContext` has no vault by design, and the composition root is the
   * one place that has both a vault and an environment. See
   * `packages/cli/src/telegram.ts`.
   */
  readonly token: string;
  readonly console: TelegramConsole;
  /** Overridden by tests. Defaults to the global `fetch`. */
  readonly fetchImpl?: FetchLike | undefined;
  /** The id it registers under. A second bot needs a second id. */
  readonly id?: string;
}

export interface TelegramChannel extends Channel {
  /** Live only after `start()`. Exposed so a test can assert the banner. */
  readonly username: string | undefined;
}

class Telegram implements TelegramChannel {
  readonly id: string;
  /**
   * `progress` is declared, so a turn fills one message in rather than posting
   * the answer twice. Whether it is *used* is per chat — see `/output`.
   */
  readonly accepts: readonly OutboundKind[] = [
    'reply',
    'notice',
    'error',
    'progress',
  ];

  username: string | undefined;

  private readonly api: BotApi;
  private readonly settings: TelegramSettings;
  private readonly access: AccessList;
  private readonly chats: ChatBook;
  private readonly menus: CallbackStore;
  private readonly renderer: TelegramRenderer;
  private readonly console: TelegramConsole;
  private readonly context: ChannelContext;
  private readonly logger: Logger;
  private readonly clock: Clock;
  /** The poll, so `stop()` can await it rather than racing the abort. */
  private polling: Promise<void> | undefined;
  private offset = 0;

  constructor(context: ChannelContext, options: TelegramChannelOptions) {
    this.id = context.id;
    this.context = context;
    this.logger = context.logger;
    this.clock = context.clock;
    this.console = options.console;
    this.settings = parseTelegramSettings(context.settings);
    this.access = new AccessList({
      allowlist: this.settings.allowlist,
      admins: this.settings.admins,
    });
    this.api = new BotApi({
      token: options.token,
      apiBase: this.settings.apiBase,
      ...(options.fetchImpl === undefined
        ? {}
        : { fetchImpl: options.fetchImpl }),
    });
    this.chats = new ChatBook(this.id);
    this.menus = new CallbackStore({ clock: this.clock });
    this.renderer = new TelegramRenderer({
      api: this.api,
      clock: this.clock,
      logger: this.logger,
      editIntervalMs: this.settings.editIntervalMs,
    });
  }

  async start(): Promise<void> {
    // Refused rather than started, and the difference matters: a bot that comes
    // up answering nobody looks exactly like a bot with a broken token, and
    // one that comes up answering *anybody* is a shell on this machine.
    if (this.access.empty) {
      throw new GhostError(
        'config',
        'channels.telegram.allowlist is empty, so this bot would answer nobody. ' +
          'Add your Telegram user id — message the bot and read the log line for it.',
      );
    }

    // A wrong token throws here, which fails `ChannelManager.start()` and so
    // fails `ghost serve`. That is the documented contract.
    const me = await this.api.getMe(this.context.signal);
    this.username = me.username;

    // The commonest 409 is a webhook left over from an earlier setup, and it
    // looks exactly like the serious one — a second process on the same token —
    // with none of the same cause. Clearing it turns that into a non-event.
    await this.api.deleteWebhook(this.context.signal);
    await this.api.setMyCommands(botCommands(), this.context.signal);

    this.logger.info(
      {
        channel: this.id,
        username: me.username,
        allowed: this.access.members.length,
      },
      'telegram channel connected',
    );

    // Not awaited: `ChannelManager.start()` awaits this method.
    this.polling = this.poll();
  }

  async stop(): Promise<void> {
    // Awaited, or vitest reports an open handle and the manager's shutdown
    // races the abort that is meant to end this.
    await this.polling;
    this.polling = undefined;
  }

  /** The manager's outbound pump, once per message it decided we accept. */
  async send(message: OutboundMessage): Promise<void> {
    const chatId = Number(message.target);
    if (!Number.isFinite(chatId)) return;
    const chat = this.chats.for(chatId);

    const text = message.content
      .map((part) => (part.type === 'text' ? part.text : ''))
      .join('');
    const turnId = message.metadata.turnId;
    const approval = approvalOf(message);

    if (approval !== undefined) {
      await this.renderer.render({
        chatId,
        chat,
        text: approvalText(text, approval),
        kind: message.kind,
        keyboard: approvalKeyboard({
          callId: approval.callId,
          sessionKey: message.sessionKey,
          chatId,
          store: this.menus,
          expiresAtMs: approval.expiresAtMs,
        }),
      });
      return;
    }

    await this.renderer.render({
      chatId,
      chat,
      text,
      kind: message.kind,
      ...(typeof turnId === 'string' ? { turnId } : {}),
    });
  }

  // -------------------------------------------------------------------------
  // Inbound
  // -------------------------------------------------------------------------

  /**
   * `getUpdates` until the manager's signal fires.
   *
   * The signal reaches `fetch`, so a poll that is parked on Telegram's side
   * unwinds at shutdown rather than holding the process open for its full
   * timeout.
   */
  private async poll(): Promise<void> {
    let backoffMs = 0;

    while (!this.aborted()) {
      try {
        const updates = await this.api.getUpdates({
          offset: this.offset,
          timeoutSec: this.settings.pollTimeoutSec,
          signal: this.context.signal,
        });
        backoffMs = 0;
        for (const update of updates) {
          // Before handling, not after: an update that throws its way out of
          // here would otherwise be redelivered forever.
          this.offset = update.update_id + 1;
          await this.handle(update);
        }
      } catch (error) {
        if (this.aborted()) return;
        backoffMs = Math.min(
          backoffMs === 0 ? FIRST_BACKOFF_MS : backoffMs * 2,
          MAX_BACKOFF_MS,
        );
        this.reportPollFailure(error, backoffMs);
        try {
          await this.clock.sleep(backoffMs, this.context.signal);
        } catch {
          // `sleep` rejects on abort, which is the shutdown path.
          return;
        }
      }
    }
  }

  /**
   * A method rather than a property read.
   *
   * `while (!signal.aborted)` narrows the property to `false` for the whole
   * body, and TypeScript keeps that narrowing across the `await` that is
   * exactly when it stops being true — so the shutdown check inside the loop
   * reads as dead code and is compiled as one.
   */
  private aborted(): boolean {
    return this.context.signal.aborted;
  }

  private reportPollFailure(error: unknown, backoffMs: number): void {
    const conflict = error instanceof TelegramApiError && error.isConflict;
    const fields = { channel: this.id, err: error, backoffMs };
    if (conflict) {
      // Survived `deleteWebhook`, so this is a second process polling the same
      // bot. There is no clever recovery — the two would take turns stealing
      // each other's updates — and the log line is the fix.
      this.logger.error(
        fields,
        'another process is polling this bot; only one may',
      );
      return;
    }
    this.logger.warn(fields, 'telegram poll failed');
  }

  /** One update. Never throws: the poll loop is the only reader of the queue. */
  private async handle(update: TelegramUpdate): Promise<void> {
    try {
      if (update.message !== undefined) await this.onMessage(update.message);
      else if (update.callback_query !== undefined) {
        await this.onCallback(update.callback_query);
      }
    } catch (error) {
      this.logger.error(
        { channel: this.id, err: error },
        'telegram update could not be handled',
      );
    }
  }

  private async onMessage(message: TelegramMessage): Promise<void> {
    const from = message.from;
    const text = message.text;
    if (from === undefined || text === undefined || text === '') return;

    const requester = { userId: from.id, chatId: message.chat.id };
    if (!this.access.permits(requester)) {
      this.refuse(from, message.chat.id);
      return;
    }

    const chatId = message.chat.id;
    const chat = this.chats.for(chatId);
    const command = parseCommand(message, this.username);

    if (command === undefined) {
      // An ordinary message. The manager stamps the Telegram message id as the
      // frame's `clientMessageId`, so a redelivered update is acked rather than
      // run twice.
      const result = this.context.publish({
        sessionKey: chat.sessionKey,
        senderId: String(from.id),
        content: [textPart(text)],
        id: `${String(chatId)}:${String(message.message_id)}`,
        metadata: { target: String(chatId) },
      });
      if (result.kind !== 'accepted') {
        await this.sayRejected(chatId, result.kind);
      }
      return;
    }

    const outcome = await runCommand(command.name, {
      args: command.args,
      tail: command.tail,
      chatId,
      chat,
      console: this.console,
      menus: this.menus,
      channelId: this.id,
      isAdmin: this.access.admits(requester),
      control: (frame) => {
        this.control(chat.sessionKey, chatId, frame);
      },
      attach: (sessionKey) => {
        this.chats.attach(chatId, sessionKey);
      },
      newId: () => newUuid(),
    });
    await this.say(chatId, outcome);
  }

  private async onCallback(query: TelegramCallbackQuery): Promise<void> {
    const chatId = query.message?.chat.id;
    if (chatId === undefined) {
      await this.api.answerCallbackQuery({ id: query.id });
      return;
    }

    // The same check a message gets. Anybody in a group can press a button the
    // bot posted, so without this an approval is answerable by a stranger.
    if (!this.access.permits({ userId: query.from.id, chatId })) {
      this.refuse(query.from, chatId);
      await this.api.answerCallbackQuery({
        id: query.id,
        text: 'Not for you.',
      });
      return;
    }

    const found = this.menus.take(query.data ?? '', chatId);
    if (!found.ok) {
      await this.api.answerCallbackQuery({
        id: query.id,
        text:
          found.reason === 'wrong_chat'
            ? 'That button belongs to another chat.'
            : 'That menu has expired. Ask again.',
      });
      return;
    }

    const said = await this.apply(found.payload, chatId, query.from.id);
    // Always answered, including on a refusal: an unanswered query leaves the
    // button spinning until it times out, which reads as a bot that has hung.
    await this.api.answerCallbackQuery({ id: query.id });
    if (said !== undefined) {
      const messageId = query.message?.message_id;
      // The card becomes its own outcome rather than a second message under it.
      if (messageId !== undefined) {
        await this.renderer.update({
          chatId,
          messageId,
          text: said,
          markdown: this.chats.for(chatId).prefs.markdown,
        });
      }
    }
  }

  /** Acts on a pressed button, and says what it did. */
  private async apply(
    payload: CallbackPayload,
    chatId: number,
    userId: number,
  ): Promise<string | undefined> {
    const chat = this.chats.for(chatId);

    switch (payload.kind) {
      case 'approve': {
        this.control(payload.sessionKey, chatId, {
          type: 'tool.approve',
          callId: payload.callId,
          approved: payload.approved,
          scope: payload.scope,
        });
        return payload.approved
          ? `Approved ${scopeWords(payload.scope)}. Waiting for the agent.`
          : 'Denied.';
      }

      case 'session':
        this.chats.attach(chatId, payload.sessionKey);
        return `Attached to \`${payload.sessionKey}\`.`;

      case 'agent':
        this.console.store.ensureSession(chat.sessionKey, { origin: this.id });
        this.console.store.updateSession(chat.sessionKey, {
          agentId: payload.agentId,
        });
        return `This session now runs on \`${payload.agentId}\`.`;

      case 'model': {
        if (!this.access.admits({ userId, chatId })) {
          return 'Choosing a model is for an administrator of this install.';
        }
        this.console.setModel(payload.modelId);
        return `Now running \`${payload.modelId}\`.`;
      }

      case 'workspace':
        this.console.store.ensureSession(chat.sessionKey, { origin: this.id });
        this.console.store.updateSession(chat.sessionKey, {
          workspaceId: payload.workspaceId,
        });
        return `This session now lives in \`${payload.workspaceId}\`.`;

      case 'delete': {
        this.console.store.deleteSession(payload.sessionKey);
        if (chat.sessionKey === payload.sessionKey) {
          this.chats.attach(chatId, defaultSessionKey(this.id, chatId));
        }
        return 'Deleted.';
      }

      case 'output': {
        const field = payload.field === 'progress' ? 'progress' : 'markdown';
        chat.prefs[field] = !chat.prefs[field];
        return `${field}: ${chat.prefs[field] ? 'on' : 'off'}`;
      }

      case 'page':
        return await this.page(payload, chatId);
    }
  }

  /** Another screen of a listing, rebuilt rather than remembered. */
  private async page(
    payload: Extract<CallbackPayload, { kind: 'page' }>,
    chatId: number,
  ): Promise<string | undefined> {
    if (payload.menu !== 'sessions' && payload.menu !== 'agents') {
      // `models` and `workspaces` are re-asked rather than paged: both are
      // short enough that a second `/model` costs less than the state.
      return 'Ask again for the next page.';
    }

    const chat = this.chats.for(chatId);
    const rows =
      payload.menu === 'sessions'
        ? this.console.store
            .listSessions({ origin: this.id, limit: 100 })
            .map((session) => ({
              label: `${session.title === '' ? session.key : session.title} · ${String(session.messageCount)}`,
              ...(session.key === chat.sessionKey ? { current: true } : {}),
              payload: {
                kind: 'session' as const,
                sessionKey: session.key,
              },
            }))
        : this.console.agents().map((agent) => ({
            label: `${agent.label} · ${agent.model}`,
            payload: { kind: 'agent' as const, agentId: agent.id },
          }));

    await this.renderer.render({
      chatId,
      chat,
      text: 'Which one?',
      kind: 'notice',
      keyboard: pickerKeyboard({
        rows,
        menu: payload.menu,
        chatId,
        store: this.menus,
        offset: payload.offset,
      }),
    });
    return undefined;
  }

  // -------------------------------------------------------------------------
  // Small things
  // -------------------------------------------------------------------------

  private control(
    sessionKey: string,
    chatId: number,
    frame: ChannelControlFrame,
  ): void {
    this.context.control({
      sessionKey,
      target: String(chatId),
      frame,
    });
  }

  private async say(chatId: number, outcome: CommandResult): Promise<void> {
    await this.renderer.render({
      chatId,
      chat: this.chats.for(chatId),
      text: outcome.text,
      kind: 'notice',
      ...(outcome.keyboard === undefined ? {} : { keyboard: outcome.keyboard }),
    });
  }

  private async sayRejected(chatId: number, reason: string): Promise<void> {
    await this.renderer.render({
      chatId,
      chat: this.chats.for(chatId),
      text:
        reason === 'rate_limited'
          ? 'Slow down a moment — that was too fast.'
          : 'Busy right now. Try again shortly.',
      kind: 'notice',
    });
  }

  /**
   * A stranger, dropped.
   *
   * Silently, because a reply confirms the bot is live and spends the rate
   * limit on whoever is knocking — and logged exactly once per id, because the
   * ids are theirs to choose and a line each would be a way to fill a disk.
   * That one line is the whole onboarding path: message the bot, read the log,
   * add the id, restart.
   */
  private refuse(from: TelegramUser, chatId: number): void {
    if (!this.access.shouldReport(from.id)) return;
    this.logger.warn(
      {
        channel: this.id,
        userId: from.id,
        username: from.username,
        chatId,
      },
      'telegram message from a sender not on the allowlist',
    );
  }
}

/** The approval detail the projection put on an outbound message, if it did. */
function approvalOf(message: OutboundMessage): ApprovalDraftDetail | undefined {
  const detail = message.metadata.approval;
  if (typeof detail !== 'object' || detail === null) return undefined;
  const { callId, name, risk, expiresAtMs } = detail as Record<string, unknown>;
  if (typeof callId !== 'string' || typeof name !== 'string') return undefined;
  return {
    callId,
    name,
    risk: (typeof risk === 'string'
      ? risk
      : 'safe') as ApprovalDraftDetail['risk'],
    expiresAtMs: typeof expiresAtMs === 'number' ? expiresAtMs : 0,
  };
}

/**
 * The card an approval shows.
 *
 * The tool and its risk band, and nothing the model wrote. `args` never leaves
 * the projection — see the note there — so there is nothing here to leak into
 * the one place a human is being asked to make a judgement.
 */
function approvalText(text: string, approval: ApprovalDraftDetail): string {
  return `🔐 ${text}\n\ntool: \`${approval.name}\` · risk: ${approval.risk}`;
}

function scopeWords(scope: ApprovalScope): string {
  switch (scope) {
    case 'once':
      return 'once';
    case 'session':
      return 'for this session';
    case 'always':
      return 'for this agent, from now on';
  }
}

/**
 * The factory the manager registers.
 *
 * Built by the composition root, which is the only place with a vault to read
 * the token from and a runtime to build the console over.
 */
export function telegramChannel(
  options: TelegramChannelOptions,
): ChannelFactory {
  const id = options.id ?? 'telegram';
  return {
    id,
    create: (context) => new Telegram(context, options),
  };
}
