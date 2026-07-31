/**
 * Opaque pagination cursors.
 *
 * Cursor rather than offset everywhere a client pages, because both listings
 * move under a reader: messages are appended while a transcript is being read,
 * and a turn landing anywhere bumps its session to the front of the session
 * list. An offset shifts with them, so an offset-paged reader sees one row twice
 * and misses another — on exactly the long conversations where it matters.
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
