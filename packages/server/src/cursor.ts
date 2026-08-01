/**
 * Opaque pagination cursors.
 *
 * Cursor rather than offset for a reader moving *through* a listing, because
 * these listings move under one: messages are appended while a transcript is
 * being read, and a turn landing anywhere bumps its session to the front of the
 * session list. An offset shifts with them, so an offset-paged reader sees one
 * row twice and misses another — on exactly the long conversations where it
 * matters.
 *
 * **Two endpoints now also accept an offset, and that is not a retreat from the
 * paragraph above.** `sessions.list` and `automation.runs` are read by numbered
 * pagers as well — the sessions management screen and a job's run history — and
 * a numbered pager is not the reader that argument is about. It does not walk
 * the list; it jumps to page 7 and acts on a row there, which is a position it
 * has never visited and therefore has no cursor for. Reordering under it costs
 * it the guarantee that consecutive pages do not overlap, which is a guarantee
 * it was never using: it is filtering to a handful of rows and clicking one.
 *
 * The two modes are alternatives and `assertOnePagingMode` refuses the pair.
 * Which one a caller gets is decided by which it sends: the sidebar and every
 * sequential reader send `cursor`, a pager sends `offset`, and a cursor is only
 * *issued* while the listing is in the ordering that cursor addresses.
 *
 * The encoding is base64url'd JSON, and the point of it is that it is *opaque*.
 * A cursor that reads as `42` is a cursor a client will do arithmetic on, and
 * the moment it does, the server can no longer change what a cursor addresses
 * without breaking it. The protocol says "echo back `nextCursor` verbatim"; this
 * makes that the only usable option rather than merely the documented one.
 *
 * A cursor that does not decode is a 400, never a silent restart from the top.
 * Silently ignoring it would page a client through the same first page forever.
 */

import { badRequest } from './errors.js';

/** Where a message listing resumes: the `seq` of the last row already sent. */
export interface MessageCursor {
  readonly seq: number;
}

/** Where a session listing resumes, in the `updatedAtMs DESC, key ASC` order. */
export interface SessionListCursor {
  readonly updatedAtMs: number;
  readonly key: string;
}

/** Where a notification listing resumes, in the `createdAtMs DESC, id ASC` order. */
export interface NotificationCursor {
  readonly createdAtMs: number;
  readonly id: string;
}

/** Where a run listing resumes, in the `startedAtMs DESC, id ASC` order. */
export interface AutomationRunCursor {
  readonly startedAtMs: number;
  readonly id: string;
}

/**
 * Refuses a request that names both paging modes.
 *
 * A cursor addresses a position in the sort order and an offset counts rows from
 * the top, so a request carrying both is asking for a page relative to a page.
 * There is no reading of that which is more correct than the others, and a
 * precedence rule would mean one of the two parameters is silently ignored —
 * which looks exactly like a server that paged wrongly.
 */
export function assertOnePagingMode(query: {
  readonly cursor?: string | undefined;
  readonly offset?: number | undefined;
}): void {
  if (query.cursor !== undefined && query.offset !== undefined) {
    throw badRequest('Send either a cursor or an offset, not both');
  }
}

function encode(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decode(cursor: string): unknown {
  try {
    return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    // Every failure mode — not base64, not JSON, truncated by a URL shortener —
    // is the same thing to the caller: a cursor this server did not issue.
    throw badRequest('Malformed pagination cursor');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw badRequest('Malformed pagination cursor');
  }
  return value;
}

function text(value: unknown): string {
  if (typeof value !== 'string' || value === '') {
    throw badRequest('Malformed pagination cursor');
  }
  return value;
}

export function encodeMessageCursor(cursor: MessageCursor): string {
  return encode({ s: cursor.seq });
}

export function decodeMessageCursor(cursor: string): MessageCursor {
  const raw = decode(cursor);
  if (!isRecord(raw)) throw badRequest('Malformed pagination cursor');
  return { seq: integer(raw.s) };
}

export function encodeSessionCursor(cursor: SessionListCursor): string {
  return encode({ u: cursor.updatedAtMs, k: cursor.key });
}

export function decodeSessionCursor(cursor: string): SessionListCursor {
  const raw = decode(cursor);
  if (!isRecord(raw)) throw badRequest('Malformed pagination cursor');
  return { updatedAtMs: integer(raw.u), key: text(raw.k) };
}

export function encodeNotificationCursor(cursor: NotificationCursor): string {
  return encode({ c: cursor.createdAtMs, i: cursor.id });
}

export function decodeNotificationCursor(cursor: string): NotificationCursor {
  const raw = decode(cursor);
  if (!isRecord(raw)) throw badRequest('Malformed pagination cursor');
  return { createdAtMs: integer(raw.c), id: text(raw.i) };
}

export function encodeAutomationRunCursor(cursor: AutomationRunCursor): string {
  return encode({ s: cursor.startedAtMs, i: cursor.id });
}

export function decodeAutomationRunCursor(cursor: string): AutomationRunCursor {
  const raw = decode(cursor);
  if (!isRecord(raw)) throw badRequest('Malformed pagination cursor');
  return { startedAtMs: integer(raw.s), id: text(raw.i) };
}
