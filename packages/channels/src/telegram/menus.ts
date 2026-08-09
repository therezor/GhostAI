/**
 * Buttons, and the table their `callback_data` points into.
 *
 * Telegram caps `callback_data` at **64 bytes**, and the things a button has to
 * carry do not fit: a `callId` is model-authored — `toolu_01…`, and an MCP tool
 * call's id runs longer — and a session key is `telegram:<chatId>:<uuid>`.
 * Encoding the payload is a bug waiting for one long id, and the failure is a
 * button that silently stops working.
 *
 * So a button carries a **token**: a counter in base 36, four to six bytes
 * whatever it points at. That is not only a way round the limit; it is what
 * makes three other things possible at all.
 *
 *  - **A stale button can say so.** An entry has a deadline, so a menu from
 *    yesterday answers "That menu has expired" instead of switching to a
 *    session that has since been deleted.
 *  - **A button belongs to the chat it was posted in.** The entry records the
 *    chat, so a press relayed from somewhere else is refused. That matters
 *    because anybody in a group can tap a button the bot posted — see
 *    `access.ts` for the other half of that check.
 *  - **The table is bounded.** Menus are cheap to produce and a chat could open
 *    a hundred; the oldest entries are dropped rather than kept forever.
 */

import type { Clock } from '@ghostwire/core';
import type { ApprovalScope } from '@ghostwire/protocol';

import type { InlineKeyboardButton, InlineKeyboardMarkup } from './api.js';

/** Which listing a paging button belongs to. */
type MenuKind = 'sessions' | 'agents' | 'models' | 'workspaces';

/** What a button does when it is pressed. */
export type CallbackPayload =
  | {
      readonly kind: 'approve';
      readonly callId: string;
      readonly sessionKey: string;
      readonly approved: boolean;
      readonly scope: ApprovalScope;
    }
  | { readonly kind: 'session'; readonly sessionKey: string }
  | { readonly kind: 'agent'; readonly agentId: string }
  | { readonly kind: 'model'; readonly modelId: string }
  | { readonly kind: 'workspace'; readonly workspaceId: string }
  | { readonly kind: 'delete'; readonly sessionKey: string }
  | { readonly kind: 'output'; readonly field: string }
  | {
      readonly kind: 'page';
      readonly menu: MenuKind;
      readonly offset: number;
    };

interface CallbackEntry {
  readonly chatId: number;
  readonly expiresAtMs: number;
  readonly payload: CallbackPayload;
}

/** Why a press did nothing, when it did nothing. */
type CallbackRefusal = 'expired' | 'wrong_chat';

type CallbackLookup =
  | { readonly ok: true; readonly payload: CallbackPayload }
  | { readonly ok: false; readonly reason: CallbackRefusal };

/** How long a menu button stays live when nothing else says. */
const DEFAULT_CALLBACK_TTL_MS: number = 30 * 60 * 1000;

/** How many live buttons the process will remember at once. */
export const MAX_CALLBACK_ENTRIES = 500;

/**
 * The tokens currently pointing at something.
 *
 * One per channel, not per chat: the token is unique across the process, and
 * the chat it belongs to is checked on lookup rather than by partitioning.
 */
export class CallbackStore {
  private readonly clock: Clock;
  private readonly ttlMs: number;
  private readonly entries = new Map<string, CallbackEntry>();
  private counter = 0;

  constructor(options: { clock: Clock; ttlMs?: number }) {
    this.clock = options.clock;
    this.ttlMs = options.ttlMs ?? DEFAULT_CALLBACK_TTL_MS;
  }

  /** Live tokens. Exposed for the eviction test and for a debug log. */
  get size(): number {
    return this.entries.size;
  }

  /**
   * Files a payload and returns the token to put on the button.
   *
   * `expiresAtMs` overrides the default, which is how an approval button
   * inherits the gate's own deadline rather than outliving the request it
   * answers.
   */
  put(input: {
    chatId: number;
    payload: CallbackPayload;
    expiresAtMs?: number;
  }): string {
    this.counter += 1;
    const token = this.counter.toString(36);
    this.entries.set(token, {
      chatId: input.chatId,
      expiresAtMs: input.expiresAtMs ?? this.clock.now() + this.ttlMs,
      payload: input.payload,
    });
    this.evict();
    return token;
  }

  /**
   * What that button meant, or why it means nothing now.
   *
   * A hit is consumed only for a one-shot payload — an approval answers once —
   * while a menu's paging buttons stay live so the reader can go back a page.
   */
  take(token: string, chatId: number): CallbackLookup {
    const entry = this.entries.get(token);
    // An unknown token and an expired one are the same answer on purpose: a
    // reader pressing a button from yesterday should be told the menu is gone,
    // not that it never existed.
    if (entry === undefined || entry.expiresAtMs <= this.clock.now()) {
      this.entries.delete(token);
      return { ok: false, reason: 'expired' };
    }
    if (entry.chatId !== chatId) {
      return { ok: false, reason: 'wrong_chat' };
    }
    if (entry.payload.kind === 'approve') this.entries.delete(token);
    return { ok: true, payload: entry.payload };
  }

  /** Drops everything for one chat. `/exit` detaching, or a menu superseded. */
  forget(chatId: number): void {
    for (const [token, entry] of this.entries) {
      if (entry.chatId === chatId) this.entries.delete(token);
    }
  }

  /**
   * Keeps the table bounded, oldest first.
   *
   * Insertion order *is* age here, because a token is never re-inserted — so
   * the map's own iteration order is the eviction order and no second index is
   * needed. The same trick `ChannelManager` uses for its LRU.
   */
  private evict(): void {
    const now = this.clock.now();
    for (const [token, entry] of this.entries) {
      if (this.entries.size <= MAX_CALLBACK_ENTRIES) break;
      // Expired entries first, then simply the oldest.
      if (entry.expiresAtMs <= now) this.entries.delete(token);
    }
    while (this.entries.size > MAX_CALLBACK_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) return;
      this.entries.delete(oldest);
    }
  }
}

// ---------------------------------------------------------------------------
// Keyboards
// ---------------------------------------------------------------------------

/** Rows shown eight at a time, which is about a phone screen. */
export const DEFAULT_PAGE_SIZE = 8;

export interface PickerRow {
  /** Button text. Plain — Telegram does not parse entities in a button. */
  readonly label: string;
  /** Marked, so a listing says where you already are. */
  readonly current?: boolean;
  readonly payload: CallbackPayload;
}

interface PickerInput {
  readonly rows: readonly PickerRow[];
  readonly menu: MenuKind;
  readonly chatId: number;
  readonly store: CallbackStore;
  readonly offset?: number;
  readonly pageSize?: number;
}

/**
 * One page of a listing, with the arrows it needs and no more.
 *
 * The arrows are themselves tokens, so paging costs a round trip and no state
 * on the message — which is what lets a menu survive a restart badly rather
 * than wrongly: the button is simply expired.
 */
export function pickerKeyboard(input: PickerInput): InlineKeyboardMarkup {
  const pageSize = input.pageSize ?? DEFAULT_PAGE_SIZE;
  const offset = Math.max(0, Math.min(input.offset ?? 0, input.rows.length));
  const page = input.rows.slice(offset, offset + pageSize);

  const keyboard: InlineKeyboardButton[][] = page.map((row) => [
    {
      text: row.current === true ? `• ${row.label}` : row.label,
      callback_data: input.store.put({
        chatId: input.chatId,
        payload: row.payload,
      }),
    },
  ]);

  const arrows: InlineKeyboardButton[] = [];
  if (offset > 0) {
    arrows.push({
      text: '« Prev',
      callback_data: input.store.put({
        chatId: input.chatId,
        payload: {
          kind: 'page',
          menu: input.menu,
          offset: Math.max(0, offset - pageSize),
        },
      }),
    });
  }
  if (offset + pageSize < input.rows.length) {
    arrows.push({
      text: 'Next »',
      callback_data: input.store.put({
        chatId: input.chatId,
        payload: { kind: 'page', menu: input.menu, offset: offset + pageSize },
      }),
    });
  }
  if (arrows.length > 0) keyboard.push(arrows);

  return { inline_keyboard: keyboard };
}

interface ApprovalKeyboardInput {
  readonly callId: string;
  readonly sessionKey: string;
  readonly chatId: number;
  readonly store: CallbackStore;
  /** The gate's own deadline, so the buttons die with the request. */
  readonly expiresAtMs: number;
}

/**
 * Four buttons: the three approval scopes, and a refusal.
 *
 * Denial is `once` on purpose, though the gate supports the other two. A
 * "deny always" that is one tap away from "deny once", on a phone, is a way to
 * silently disable a tool for an agent and not find out for a week. An
 * operator who means it can say so where there is room to explain it.
 */
export function approvalKeyboard(
  input: ApprovalKeyboardInput,
): InlineKeyboardMarkup {
  const button = (
    text: string,
    approved: boolean,
    scope: ApprovalScope,
  ): InlineKeyboardButton => ({
    text,
    callback_data: input.store.put({
      chatId: input.chatId,
      expiresAtMs: input.expiresAtMs,
      payload: {
        kind: 'approve',
        callId: input.callId,
        sessionKey: input.sessionKey,
        approved,
        scope,
      },
    }),
  });

  return {
    inline_keyboard: [
      [
        button('✅ Once', true, 'once'),
        button('✅ This session', true, 'session'),
      ],
      [button('✅ Always', true, 'always'), button('⛔ Deny', false, 'once')],
    ],
  };
}

/** A yes/no pair for something that cannot be undone. */
export function confirmKeyboard(input: {
  readonly chatId: number;
  readonly store: CallbackStore;
  readonly confirm: CallbackPayload;
  readonly label?: string;
}): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        {
          text: input.label ?? 'Yes, delete it',
          callback_data: input.store.put({
            chatId: input.chatId,
            payload: input.confirm,
          }),
        },
      ],
    ],
  };
}
