/**
 * Notifications, on the connection everything else shares.
 *
 * They live in this package rather than in `@ghostai/core` for the same reason
 * the auth tables do: nothing below the transport raises one. A notification is
 * something a *user interface* shows — an automation run that finished while the
 * tab was closed, an approval that expired unanswered — and the agent loop has
 * no opinion about whether anyone is watching. What raises them is the scheduler
 * and the hub, both of which sit at this level.
 *
 * Two decisions worth stating:
 *
 *  - **Read is a timestamp, not a flag.** "When did this stop being new" is a
 *    question a UI asks — a badge that dims after a while, a digest of what
 *    arrived since a session started — and a boolean cannot answer it. The
 *    unread count is `read_at_ms IS NULL`, which the partial index serves
 *    directly.
 *
 *  - **The listing is keyset-paged over `(created_at_ms DESC, id ASC)`.** A
 *    notification arriving mid-scroll is exactly the case that makes an offset
 *    wrong, and it is also the case this table exists for.
 */

import { randomUUID } from 'node:crypto';
import type { DatabaseSync, SQLOutputValue, StatementSync } from 'node:sqlite';

import { GhostError, systemClock, type Clock } from '@ghostai/core';
import type { Notification } from '@ghostai/protocol';

import type { NotificationCursor } from './cursor.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS notifications (
  id            TEXT    PRIMARY KEY,
  title         TEXT    NOT NULL,
  body          TEXT    NOT NULL DEFAULT '',
  level         TEXT    NOT NULL DEFAULT 'info',
  created_at_ms INTEGER NOT NULL,
  read_at_ms    INTEGER,
  session_key   TEXT,
  job_id        TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS notifications_created ON notifications(created_at_ms DESC, id ASC);
CREATE INDEX IF NOT EXISTS notifications_unread ON notifications(created_at_ms DESC) WHERE read_at_ms IS NULL;
`;

/** Every level the protocol's `Notification` allows. */
const LEVELS: ReadonlySet<string> = new Set(['info', 'success', 'warning', 'error']);

export interface NotificationStoreOptions {
  /** Shared with `SessionStore` and `AuthStore`: one file, one WAL. */
  readonly database: DatabaseSync;
  readonly clock?: Clock;
  readonly newId?: () => string;
}

export interface CreateNotificationInput {
  readonly title: string;
  readonly body?: string;
  readonly level?: Notification['level'];
  readonly sessionKey?: string;
  readonly jobId?: string;
}

export interface ListNotificationsOptions {
  readonly limit?: number;
  readonly after?: NotificationCursor;
  readonly unreadOnly?: boolean;
}

type Row = Record<string, SQLOutputValue>;

function readInt(row: Row, column: string): number {
  const value = row[column];
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  throw new GhostError('storage', `Expected an integer in notifications.${column}`);
}

function readOptionalInt(row: Row, column: string): number | undefined {
  const value = row[column];
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  return undefined;
}

function readString(row: Row, column: string): string {
  const value = row[column];
  if (typeof value === 'string') return value;
  throw new GhostError('storage', `Expected text in notifications.${column}`);
}

function readOptionalString(row: Row, column: string): string | undefined {
  const value = row[column];
  return typeof value === 'string' ? value : undefined;
}

/**
 * A level written by something that predates a level being added, or by a
 * plugin, becomes `info` rather than failing the read. The alternative is one
 * bad row making the whole notification list unreadable.
 */
function readLevel(row: Row): Notification['level'] {
  const value = readString(row, 'level');
  return LEVELS.has(value) ? (value as Notification['level']) : 'info';
}

function rowToNotification(row: Row): Notification {
  const readAtMs = readOptionalInt(row, 'read_at_ms');
  const sessionKey = readOptionalString(row, 'session_key');
  const jobId = readOptionalString(row, 'job_id');
  return {
    id: readString(row, 'id'),
    title: readString(row, 'title'),
    body: readString(row, 'body'),
    level: readLevel(row),
    createdAtMs: readInt(row, 'created_at_ms'),
    ...(readAtMs === undefined ? {} : { readAtMs }),
    ...(sessionKey === undefined ? {} : { sessionKey }),
    ...(jobId === undefined ? {} : { jobId }),
  };
}

export class NotificationStore {
  readonly #db: DatabaseSync;
  readonly #clock: Clock;
  readonly #newId: () => string;
  readonly #statements = new Map<string, StatementSync>();

  constructor(options: NotificationStoreOptions) {
    this.#db = options.database;
    this.#clock = options.clock ?? systemClock;
    this.#newId = options.newId ?? randomUUID;
    this.#db.exec(SCHEMA);
  }

  #stmt(sql: string): StatementSync {
    const cached = this.#statements.get(sql);
    if (cached !== undefined) return cached;
    const prepared = this.#db.prepare(sql);
    this.#statements.set(sql, prepared);
    return prepared;
  }

  create(input: CreateNotificationInput): Notification {
    const notification: Notification = {
      id: this.#newId(),
      title: input.title,
      body: input.body ?? '',
      level: input.level ?? 'info',
      createdAtMs: this.#clock.now(),
      ...(input.sessionKey === undefined ? {} : { sessionKey: input.sessionKey }),
      ...(input.jobId === undefined ? {} : { jobId: input.jobId }),
    };

    this.#stmt(
      `INSERT INTO notifications (id, title, body, level, created_at_ms, read_at_ms, session_key, job_id)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
    ).run(
      notification.id,
      notification.title,
      notification.body,
      notification.level,
      notification.createdAtMs,
      notification.sessionKey ?? null,
      notification.jobId ?? null,
    );

    return notification;
  }

  get(id: string): Notification | undefined {
    const row = this.#stmt('SELECT * FROM notifications WHERE id = ?').get(id);
    return row === undefined ? undefined : rowToNotification(row);
  }

  /**
   * A page, newest first.
   *
   * The predicate is the sort order written as a comparison, the same shape
   * `SessionStore.listSessions` uses: strictly older, or the same millisecond
   * and an id that sorts later. Two notifications raised in one millisecond are
   * the normal case for an automation run that finishes several jobs.
   */
  list(options: ListNotificationsOptions = {}): Notification[] {
    const { limit = 50, after, unreadOnly = false } = options;
    const rows = this.#stmt(
      `SELECT * FROM notifications
        WHERE (? = 0 OR read_at_ms IS NULL)
          AND (? IS NULL
               OR created_at_ms < ?
               OR (created_at_ms = ? AND id > ?))
        ORDER BY created_at_ms DESC, id ASC
        LIMIT ?`,
    ).all(
      unreadOnly ? 1 : 0,
      after?.createdAtMs ?? null,
      after?.createdAtMs ?? null,
      after?.createdAtMs ?? null,
      after?.id ?? null,
      limit,
    );

    return rows.map(rowToNotification);
  }

  unreadCount(): number {
    const row = this.#stmt(
      'SELECT COUNT(*) AS n FROM notifications WHERE read_at_ms IS NULL',
    ).get();
    return row === undefined ? 0 : readInt(row, 'n');
  }

  /**
   * Marks one read and returns it as it now stands.
   *
   * Idempotent in the way that matters: a second call does not move the
   * timestamp, so "read at" keeps meaning the first time it was seen rather than
   * the last time a tab was refreshed.
   */
  markRead(id: string): Notification | undefined {
    this.#stmt('UPDATE notifications SET read_at_ms = ? WHERE id = ? AND read_at_ms IS NULL').run(
      this.#clock.now(),
      id,
    );
    return this.get(id);
  }

  /** Marks everything unread as read. Returns how many rows changed. */
  markAllRead(): number {
    return Number(
      this.#stmt('UPDATE notifications SET read_at_ms = ? WHERE read_at_ms IS NULL').run(
        this.#clock.now(),
      ).changes,
    );
  }

  delete(id: string): boolean {
    return Number(this.#stmt('DELETE FROM notifications WHERE id = ?').run(id).changes) > 0;
  }
}
