import { describe, expect, it } from 'vitest';

import {
  CallbackStore,
  DEFAULT_PAGE_SIZE,
  MAX_CALLBACK_ENTRIES,
  approvalKeyboard,
  confirmKeyboard,
  pickerKeyboard,
  type PickerRow,
} from '#src/telegram/menus.js';

import { manualClock, type ManualClock } from './manual-clock.js';

const CHAT = 42;

/**
 * A store and the clock it reads.
 *
 * Two values rather than one intersected object: `CallbackStore.clock` is
 * `private`, and an intersection that names a private member of one side
 * collapses to `never`.
 */
function store(): { store: CallbackStore; clock: ManualClock } {
  const clock = manualClock();
  return { store: new CallbackStore({ clock }), clock };
}

describe('CallbackStore', () => {
  it('gives a token that fits Telegram’s 64-byte cap, whatever it points at', () => {
    // The whole reason a token exists: a `callId` is model-authored and an MCP
    // tool call's runs long.
    const { store: s } = store();
    const token = s.put({
      chatId: CHAT,
      payload: {
        kind: 'approve',
        callId: `toolu_${'0'.repeat(200)}`,
        sessionKey: `telegram:${String(CHAT)}:${'a'.repeat(64)}`,
        approved: true,
        scope: 'once',
      },
    });

    expect(Buffer.byteLength(token, 'utf8')).toBeLessThanOrEqual(64);
    expect(token.length).toBeLessThan(8);
  });

  it('gives back what was filed', () => {
    const { store: s } = store();
    const token = s.put({
      chatId: CHAT,
      payload: { kind: 'agent', agentId: 'x' },
    });

    expect(s.take(token, CHAT)).toEqual({
      ok: true,
      payload: { kind: 'agent', agentId: 'x' },
    });
  });

  it('refuses a token it never issued, as expired', () => {
    // A reader pressing a button from before a restart should be told the menu
    // is gone, not that it never existed.
    expect(store().store.take('zzz', CHAT)).toEqual({
      ok: false,
      reason: 'expired',
    });
  });

  it('refuses a token past its deadline', () => {
    const { store: s, clock } = store();
    const token = s.put({
      chatId: CHAT,
      payload: { kind: 'agent', agentId: 'x' },
    });
    clock.advance(31 * 60 * 1000);

    expect(s.take(token, CHAT)).toEqual({ ok: false, reason: 'expired' });
  });

  it('takes an approval’s deadline from the gate rather than its own', () => {
    const { store: s, clock } = store();
    const token = s.put({
      chatId: CHAT,
      expiresAtMs: clock.now() + 1000,
      payload: {
        kind: 'approve',
        callId: 'c1',
        sessionKey: 'telegram:42',
        approved: true,
        scope: 'once',
      },
    });
    clock.advance(2000);

    // The buttons die with the request they answer, rather than outliving it.
    expect(s.take(token, CHAT).ok).toBe(false);
  });

  it('refuses a press from another chat', () => {
    // Anybody in a group can tap a button the bot posted.
    const { store: s } = store();
    const token = s.put({
      chatId: CHAT,
      payload: { kind: 'agent', agentId: 'x' },
    });

    expect(s.take(token, 99)).toEqual({ ok: false, reason: 'wrong_chat' });
    // And the refusal does not consume it for the chat it belongs to.
    expect(s.take(token, CHAT).ok).toBe(true);
  });

  it('consumes an approval, so a double tap answers once', () => {
    const { store: s } = store();
    const token = s.put({
      chatId: CHAT,
      payload: {
        kind: 'approve',
        callId: 'c1',
        sessionKey: 'telegram:42',
        approved: true,
        scope: 'once',
      },
    });

    expect(s.take(token, CHAT).ok).toBe(true);
    expect(s.take(token, CHAT)).toEqual({ ok: false, reason: 'expired' });
  });

  it('keeps a paging button live, so a reader can go back', () => {
    const { store: s } = store();
    const token = s.put({
      chatId: CHAT,
      payload: { kind: 'page', menu: 'sessions', offset: 8 },
    });

    expect(s.take(token, CHAT).ok).toBe(true);
    expect(s.take(token, CHAT).ok).toBe(true);
  });

  it('forgets one chat’s buttons without touching another’s', () => {
    const { store: s } = store();
    const mine = s.put({
      chatId: CHAT,
      payload: { kind: 'agent', agentId: 'a' },
    });
    const theirs = s.put({
      chatId: 99,
      payload: { kind: 'agent', agentId: 'b' },
    });

    s.forget(CHAT);

    expect(s.take(mine, CHAT).ok).toBe(false);
    expect(s.take(theirs, 99).ok).toBe(true);
  });

  it('stays bounded, dropping the oldest', () => {
    const { store: s } = store();
    const first = s.put({
      chatId: CHAT,
      payload: { kind: 'agent', agentId: '0' },
    });
    for (let i = 0; i < MAX_CALLBACK_ENTRIES; i += 1) {
      s.put({ chatId: CHAT, payload: { kind: 'agent', agentId: String(i) } });
    }

    expect(s.size).toBeLessThanOrEqual(MAX_CALLBACK_ENTRIES);
    expect(s.take(first, CHAT).ok).toBe(false);
  });
});

describe('pickerKeyboard', () => {
  const rows = (count: number): PickerRow[] =>
    Array.from({ length: count }, (slot, i) => ({
      label: `row ${String(i)}`,
      payload: { kind: 'agent', agentId: String(i) },
    }));

  it('puts one choice per row', () => {
    const keyboard = pickerKeyboard({
      rows: rows(3),
      menu: 'agents',
      chatId: CHAT,
      store: store().store,
    });

    expect(keyboard.inline_keyboard).toHaveLength(3);
    expect(keyboard.inline_keyboard[0]).toHaveLength(1);
  });

  it('marks where you already are', () => {
    const keyboard = pickerKeyboard({
      rows: [
        {
          label: 'here',
          current: true,
          payload: { kind: 'agent', agentId: 'a' },
        },
      ],
      menu: 'agents',
      chatId: CHAT,
      store: store().store,
    });

    expect(keyboard.inline_keyboard[0]?.[0]?.text).toBe('• here');
  });

  it('offers no arrows when everything fits', () => {
    const keyboard = pickerKeyboard({
      rows: rows(DEFAULT_PAGE_SIZE),
      menu: 'models',
      chatId: CHAT,
      store: store().store,
    });

    expect(keyboard.inline_keyboard).toHaveLength(DEFAULT_PAGE_SIZE);
  });

  it('offers Next but not Prev on the first page', () => {
    const keyboard = pickerKeyboard({
      rows: rows(20),
      menu: 'models',
      chatId: CHAT,
      store: store().store,
    });
    const arrows = keyboard.inline_keyboard.at(-1) ?? [];

    expect(arrows.map((button) => button.text)).toEqual(['Next »']);
  });

  it('offers Prev but not Next on the last page', () => {
    const keyboard = pickerKeyboard({
      rows: rows(10),
      menu: 'models',
      chatId: CHAT,
      store: store().store,
      offset: 8,
    });
    const arrows = keyboard.inline_keyboard.at(-1) ?? [];

    expect(arrows.map((button) => button.text)).toEqual(['« Prev']);
    // Two rows left, not eight.
    expect(keyboard.inline_keyboard).toHaveLength(3);
  });

  it('offers both in the middle, and pages by exactly one screen', () => {
    const { store: s } = store();
    const keyboard = pickerKeyboard({
      rows: rows(30),
      menu: 'models',
      chatId: CHAT,
      store: s,
      offset: 8,
    });
    const arrows = keyboard.inline_keyboard.at(-1) ?? [];

    expect(arrows.map((button) => button.text)).toEqual(['« Prev', 'Next »']);
    expect(s.take(arrows[0]?.callback_data ?? '', CHAT)).toEqual({
      ok: true,
      payload: { kind: 'page', menu: 'models', offset: 0 },
    });
    expect(s.take(arrows[1]?.callback_data ?? '', CHAT)).toEqual({
      ok: true,
      payload: { kind: 'page', menu: 'models', offset: 16 },
    });
  });

  it('clamps an offset past the end rather than showing nothing at all', () => {
    const keyboard = pickerKeyboard({
      rows: rows(3),
      menu: 'sessions',
      chatId: CHAT,
      store: store().store,
      offset: 99,
    });

    // One row of arrows, and Prev lands back inside the list.
    expect(keyboard.inline_keyboard).toHaveLength(1);
  });

  it('survives an empty listing', () => {
    const keyboard = pickerKeyboard({
      rows: [],
      menu: 'sessions',
      chatId: CHAT,
      store: store().store,
    });

    expect(keyboard.inline_keyboard).toEqual([]);
  });
});

describe('approvalKeyboard', () => {
  it('offers the three scopes and a refusal', () => {
    const { store: s, clock } = store();
    const keyboard = approvalKeyboard({
      callId: 'c1',
      sessionKey: 'telegram:42',
      chatId: CHAT,
      store: s,
      expiresAtMs: clock.now() + 60_000,
    });
    const decisions = keyboard.inline_keyboard.flat().map((button) => {
      const found = s.take(button.callback_data, CHAT);
      return found.ok && found.payload.kind === 'approve'
        ? `${found.payload.approved ? 'yes' : 'no'}:${found.payload.scope}`
        : 'lost';
    });

    expect(decisions).toEqual([
      'yes:once',
      'yes:session',
      'yes:always',
      // Denial is `once`, though the gate supports the others: a "deny always"
      // one tap from "deny once", on a phone, disables a tool for a week
      // before anybody notices.
      'no:once',
    ]);
  });

  it('lays out two rows of two, which is one thumb’s reach', () => {
    const { store: s, clock } = store();
    const keyboard = approvalKeyboard({
      callId: 'c1',
      sessionKey: 'telegram:42',
      chatId: CHAT,
      store: s,
      expiresAtMs: clock.now() + 60_000,
    });

    expect(keyboard.inline_keyboard.map((row) => row.length)).toEqual([2, 2]);
  });
});

describe('confirmKeyboard', () => {
  it('offers exactly one way to say yes', () => {
    const { store: s } = store();
    const keyboard = confirmKeyboard({
      chatId: CHAT,
      store: s,
      confirm: { kind: 'delete', sessionKey: 'telegram:42' },
    });

    expect(keyboard.inline_keyboard).toHaveLength(1);
    expect(keyboard.inline_keyboard[0]?.[0]?.text).toBe('Yes, delete it');
  });
});
