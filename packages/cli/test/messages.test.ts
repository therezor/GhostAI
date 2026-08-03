/**
 * Addressing a message from a prompt.
 *
 * The negative-offset rule is the part worth testing directly: `-1` counts back
 * over the messages *you* wrote, not over rows. A conversation with a tool call
 * in it has assistant turns and tool results between two questions, and an
 * offset that counted rows would resolve `-2` to a tool result nobody can edit.
 */

import { describe, expect, it } from 'vitest';

import {
  GhostError,
  SessionStore,
  assistantMessage,
  toolMessage,
  userMessage,
} from '@ghostai/core';

import { recentMessages, resolveSeq } from '#src/messages.js';

const SESSION = 'cli:default';

function store(): SessionStore {
  const created = new SessionStore();
  created.append(SESSION, userMessage('the first question'));
  created.append(SESSION, assistantMessage('', { toolCalls: [call('a')] }));
  created.append(SESSION, toolMessage('a', 'read_file', 'contents'));
  created.append(SESSION, assistantMessage('the first answer'));
  created.append(SESSION, userMessage('the second question'));
  created.append(SESSION, assistantMessage('the second answer'));
  return created;
}

const call = (id: string): { id: string; name: string; argumentsJson: string } => ({
  id,
  name: 'read_file',
  argumentsJson: '{}',
});

describe('resolveSeq', () => {
  it('defaults to the last thing you said', () => {
    const db = store();
    expect(resolveSeq(db, SESSION, undefined)).toBe(5);
    db.close();
  });

  it('counts back over your messages, not over rows', () => {
    const db = store();
    // Rows 2, 3 and 4 sit between the two questions. `-2` is the earlier
    // question, not a tool result.
    expect(resolveSeq(db, SESSION, '-2')).toBe(1);
    db.close();
  });

  it('takes a seq from the listing verbatim', () => {
    const db = store();
    expect(resolveSeq(db, SESSION, '3')).toBe(3);
    db.close();
  });

  it('refuses a seq that names no row', () => {
    const db = store();
    expect(() => resolveSeq(db, SESSION, '99')).toThrow(GhostError);
    db.close();
  });

  it('refuses an offset past what you have said', () => {
    const db = store();
    expect(() => resolveSeq(db, SESSION, '-9')).toThrow(GhostError);
    db.close();
  });

  it('refuses anything that is not an integer, including zero', () => {
    const db = store();
    for (const ref of ['0', 'x', '1.5', '--1']) {
      expect(() => resolveSeq(db, SESSION, ref)).toThrow(GhostError);
    }
    db.close();
  });

  it('says so plainly when you have said nothing yet', () => {
    const db = new SessionStore();
    db.ensureSession(SESSION);
    expect(() => resolveSeq(db, SESSION, undefined)).toThrow(/not said anything/u);
    db.close();
  });
});

describe('recentMessages', () => {
  it('returns the tail, oldest first, with the seqs the listing prints', () => {
    const db = store();
    expect(recentMessages(db, SESSION, 3).map((row) => row.seq)).toEqual([4, 5, 6]);
    db.close();
  });

  it('names each row by role, so a seq can be judged before it is used', () => {
    const db = store();
    expect(recentMessages(db, SESSION, 2).map((row) => row.role)).toEqual(['user', 'assistant']);
    db.close();
  });
});
