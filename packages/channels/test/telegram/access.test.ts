import { describe, expect, it } from 'vitest';

import { AccessList, parseAllowlist } from '#src/telegram/access.js';

/** A private chat: Telegram reports the chat id as the user's own. */
const alone = (userId: number): { userId: number; chatId: number } => ({
  userId,
  chatId: userId,
});

/** A group: a negative chat id, and a sender who is someone in it. */
const inGroup = (
  userId: number,
  chatId: number,
): { userId: number; chatId: number } => ({ userId, chatId });

describe('parseAllowlist', () => {
  it('reads a bare id', () => {
    expect(parseAllowlist(['4471'])).toEqual([{ id: 4471, label: undefined }]);
  });

  it('reads an id with a label, and keeps the label off the match', () => {
    expect(parseAllowlist(['4471|me'])).toEqual([{ id: 4471, label: 'me' }]);
  });

  it('reads a negative group id', () => {
    expect(parseAllowlist(['-100200|team'])).toEqual([
      { id: -100_200, label: 'team' },
    ]);
  });

  it('keeps a pipe that appears inside the label', () => {
    expect(parseAllowlist(['7|a|b'])).toEqual([{ id: 7, label: 'a|b' }]);
  });

  it('tolerates surrounding whitespace', () => {
    expect(parseAllowlist([' 7 | me '])).toEqual([{ id: 7, label: 'me' }]);
  });

  it('refuses an entry that is not an id, naming it', () => {
    // Skipping it would narrow the allowlist silently, and the symptom — one
    // person the bot stopped answering — is a long way from the typo.
    expect(() => parseAllowlist(['@someone'])).toThrow(/"@someone"/u);
  });

  it('refuses zero, which is no Telegram account', () => {
    expect(() => parseAllowlist(['0'])).toThrow(/not a Telegram id/u);
  });

  it('refuses a fractional id', () => {
    expect(() => parseAllowlist(['4.5'])).toThrow(/not a Telegram id/u);
  });
});

describe('AccessList', () => {
  it('is empty when nothing is listed, which is what refuses startup', () => {
    expect(new AccessList({ allowlist: [], admins: [] }).empty).toBe(true);
  });

  it('permits a listed sender in their own chat', () => {
    const list = new AccessList({ allowlist: ['7|me'], admins: [] });

    expect(list.permits(alone(7))).toBe(true);
  });

  it('refuses a sender nobody listed', () => {
    const list = new AccessList({ allowlist: ['7'], admins: [] });

    expect(list.permits(alone(8))).toBe(false);
  });

  it('refuses a listed sender in a group nobody listed', () => {
    const list = new AccessList({ allowlist: ['7'], admins: [] });

    expect(list.permits(inGroup(7, -100))).toBe(false);
  });

  it('refuses an unlisted member of a listed group', () => {
    // Being in the room is not a decision the operator made. This is the case
    // that a chat-id-only check would get wrong.
    const list = new AccessList({ allowlist: ['7', '-100'], admins: [] });

    expect(list.permits(inGroup(9, -100))).toBe(false);
  });

  it('permits a listed sender in a listed group', () => {
    const list = new AccessList({ allowlist: ['7', '-100'], admins: [] });

    expect(list.permits(inGroup(7, -100))).toBe(true);
  });

  it('treats every allowed sender as an admin when none are named', () => {
    const list = new AccessList({ allowlist: ['7', '8'], admins: [] });

    expect(list.admits(alone(7))).toBe(true);
    expect(list.admits(alone(8))).toBe(true);
  });

  it('narrows to the named admins once there are any', () => {
    const list = new AccessList({ allowlist: ['7', '8'], admins: ['7|me'] });

    expect(list.admits(alone(7))).toBe(true);
    expect(list.admits(alone(8))).toBe(false);
    // Still an ordinary user: they can talk, they cannot reconfigure.
    expect(list.permits(alone(8))).toBe(true);
  });

  it('never admits someone the allowlist refuses, admin list or not', () => {
    const list = new AccessList({ allowlist: ['7'], admins: ['9'] });

    expect(list.admits(alone(9))).toBe(false);
  });

  it('reports an unknown sender once, not on every message', () => {
    const list = new AccessList({ allowlist: ['7'], admins: [] });

    expect(list.shouldReport(99)).toBe(true);
    expect(list.shouldReport(99)).toBe(false);
    expect(list.shouldReport(98)).toBe(true);
  });

  it('stops reporting once the set is full, since the ids are theirs to pick', () => {
    const list = new AccessList({ allowlist: ['7'], admins: [] });
    for (let id = 1; id <= 1000; id += 1) list.shouldReport(id);

    expect(list.shouldReport(100_001)).toBe(false);
  });

  it('exposes its members for the startup log', () => {
    const list = new AccessList({
      allowlist: ['7|me', '-100|team'],
      admins: [],
    });

    expect(list.members.map((party) => party.label)).toEqual(['me', 'team']);
  });
});
