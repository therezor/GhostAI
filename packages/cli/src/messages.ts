/**
 * Naming a message from a prompt.
 *
 * The web addresses a message by clicking it. A terminal has to say which one,
 * and the scheme is the crux of whether `/edit` and `/regenerate` are usable or
 * a guessing game.
 *
 * `seq` is the address, because it already is one everywhere else: it is
 * storage's per-session ordering, the REST pagination cursor, and what
 * `turn.regenerate` and `user.edit` carry on the wire. A second scheme invented
 * for the terminal would be a second thing to keep in step.
 *
 * A negative reference counts back over **user messages only**. `-1` is the last
 * thing you said, `-2` the one before — not the last two rows, because rows
 * include assistant turns and tool results, and nobody counts backwards over a
 * tool result. That distinction is the whole reason this is a function rather
 * than arithmetic at the call site.
 *
 * `/messages` is what makes the scheme usable rather than a guess: it prints the
 * seqs, so the number in `/edit 12` is one that was read rather than counted.
 */

import { GhostError, textOf, type SessionStore, type StoredMessageRecord } from '@ghostai/core';

/** How many rows `/messages` prints when no count is given. */
export const DEFAULT_MESSAGE_LINES = 12;

/** How far a listing looks back for the user messages a negative ref counts. */
const LOOKBACK = 400;

/**
 * Resolves a message reference to a `seq`.
 *
 * `undefined` means `-1`: the common case is re-running or rewriting the last
 * thing said, and making that the default is what keeps `/regenerate` a word
 * rather than a word and a number.
 */
export function resolveSeq(
  store: SessionStore,
  sessionKey: string,
  ref: string | undefined,
): number {
  const trimmed = ref?.trim() ?? '';
  const raw = trimmed === '' ? -1 : Number(trimmed);

  if (!Number.isInteger(raw) || raw === 0) {
    throw new GhostError('invalid_input', `Not a message reference: ${trimmed}`, {
      details: { ref: trimmed },
    });
  }

  if (raw > 0) {
    const [record] = store.messages(sessionKey, { afterSeq: raw - 1, beforeSeq: raw + 1 });
    if (record === undefined) {
      throw new GhostError('not_found', `No message ${String(raw)} in this conversation`, {
        details: { seq: raw },
      });
    }
    return raw;
  }

  const spoken = store
    .messages(sessionKey, { limit: LOOKBACK, fromEnd: true })
    .filter((record) => record.message.role === 'user');

  const record = spoken.at(raw);
  if (record === undefined) {
    throw new GhostError(
      'not_found',
      spoken.length === 0
        ? 'You have not said anything in this conversation yet'
        : `Only ${String(spoken.length)} of your messages are in this conversation`,
      { details: { offset: raw, available: spoken.length } },
    );
  }
  return record.seq;
}

export interface MessageLine {
  readonly seq: number;
  readonly role: string;
  readonly text: string;
}

/** The last `count` messages, oldest first, as the listing renders them. */
export function recentMessages(
  store: SessionStore,
  sessionKey: string,
  count: number = DEFAULT_MESSAGE_LINES,
): MessageLine[] {
  return store
    .messages(sessionKey, { limit: count, fromEnd: true })
    .map((record: StoredMessageRecord) => ({
      seq: record.seq,
      role: record.message.role,
      text: textOf(record.message),
    }));
}
