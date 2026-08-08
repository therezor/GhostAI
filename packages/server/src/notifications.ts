/**
 * Notifications, on the connection everything else shares.
 *
 * They live in this package rather than in `@ghostbot/core` for the same reason
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

import type { DatabaseSync, StatementSync } from 'node:sqlite';

import { rowReader, systemClock, type Clock, type Row } from '@ghostbot/core';
import { newUuid, type Notification } from '@ghostbot/protocol';

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
const LEVELS: ReadonlySet<string> = new Set([
  'info',
  'success',
  'warning',
  'error',
]);

interface NotificationStoreOptions {
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

interface ListNotificationsOptions {
  readonly limit?: number;
  /**
   * For a numbered pager, where `after` is for a sequential reader.
   *
   * The two are alternatives and never combined — `notifications.list` refuses
   * the pair with a 400. See `cursor.ts`.
   */
  readonly offset?: number;
  readonly after?: NotificationCursor;
  readonly unreadOnly?: boolean;
}

const read = rowReader('notifications');

/**
 * A level written by something that predates a level being added, or by a
 * extension, becomes `info` rather than failing the read. The alternative is one
 * bad row making the whole notification list unreadable.
 */
function readLevel(row: Row): Notification['level'] {
  const value = read.string(row, 'level');
  return LEVELS.has(value) ? (value as Notification['level']) : 'info';
}

function rowToNotification(row: Row): Notification {
  const readAtMs = read.optionalInt(row, 'read_at_ms');
  const sessionKey = read.optionalString(row, 'session_key');
  const jobId = read.optionalString(row, 'job_id');
  return {
    id: read.string(row, 'id'),
    title: read.string(row, 'title'),
    body: read.string(row, 'body'),
    level: readLevel(row),
    createdAtMs: read.int(row, 'created_at_ms'),
    ...(readAtMs === undefined ? {} : { readAtMs }),
    ...(sessionKey === undefined ? {} : { sessionKey }),
    ...(jobId === undefined ? {} : { jobId }),
  };
}

export class NotificationStore {
  private readonly db: DatabaseSync;
  private readonly clock: Clock;
  private readonly newId: () => string;
  private readonly statements = new Map<string, StatementSync>();

  constructor(options: NotificationStoreOptions) {
    this.db = options.database;
    this.clock = options.clock ?? systemClock;
    this.newId = options.newId ?? newUuid;
    this.db.exec(SCHEMA);
  }

  private stmt(sql: string): StatementSync {
    const cached = this.statements.get(sql);
    if (cached !== undefined) return cached;
    const prepared = this.db.prepare(sql);
    this.statements.set(sql, prepared);
    return prepared;
  }

  create(input: CreateNotificationInput): Notification {
    const notification: Notification = {
      id: this.newId(),
      title: input.title,
      body: input.body ?? '',
      level: input.level ?? 'info',
      createdAtMs: this.clock.now(),
      ...(input.sessionKey === undefined
        ? {}
        : { sessionKey: input.sessionKey }),
      ...(input.jobId === undefined ? {} : { jobId: input.jobId }),
    };

    this.stmt(
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
    const row = this.stmt('SELECT * FROM notifications WHERE id = ?').get(id);
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
    const { limit = 50, offset = 0, after, unreadOnly = false } = options;
    const rows = this.stmt(
      `SELECT * FROM notifications
        WHERE (? = 0 OR read_at_ms IS NULL)
          AND (? IS NULL
               OR created_at_ms < ?
               OR (created_at_ms = ? AND id > ?))
        ORDER BY created_at_ms DESC, id ASC
        LIMIT ? OFFSET ?`,
    ).all(
      unreadOnly ? 1 : 0,
      after?.createdAtMs ?? null,
      after?.createdAtMs ?? null,
      after?.createdAtMs ?? null,
      after?.id ?? null,
      limit,
      offset,
    );

    return rows.map(rowToNotification);
  }

  /**
   * How many the same filter matches, ignoring the page.
   *
   * The `unreadOnly` predicate is repeated rather than shared through a helper
   * the way `SessionStore` does: it is one clause with one binding, and a
   * function wrapping it would be indirection protecting nothing.
   */
  count(options: { readonly unreadOnly?: boolean } = {}): number {
    const row = this.stmt(
      'SELECT COUNT(*) AS n FROM notifications WHERE (? = 0 OR read_at_ms IS NULL)',
    ).get(options.unreadOnly === true ? 1 : 0);
    return row === undefined ? 0 : read.int(row, 'n');
  }

  unreadCount(): number {
    const row = this.stmt(
      'SELECT COUNT(*) AS n FROM notifications WHERE read_at_ms IS NULL',
    ).get();
    return row === undefined ? 0 : read.int(row, 'n');
  }

  /**
   * Marks one read and returns it as it now stands.
   *
   * Idempotent in the way that matters: a second call does not move the
   * timestamp, so "read at" keeps meaning the first time it was seen rather than
   * the last time a tab was refreshed.
   */
  markRead(id: string): Notification | undefined {
    this.stmt(
      'UPDATE notifications SET read_at_ms = ? WHERE id = ? AND read_at_ms IS NULL',
    ).run(this.clock.now(), id);
    return this.get(id);
  }

  /** Marks everything unread as read. Returns how many rows changed. */
  markAllRead(): number {
    return Number(
      this.stmt(
        'UPDATE notifications SET read_at_ms = ? WHERE read_at_ms IS NULL',
      ).run(this.clock.now()).changes,
    );
  }

  delete(id: string): boolean {
    return (
      Number(
        this.stmt('DELETE FROM notifications WHERE id = ?').run(id).changes,
      ) > 0
    );
  }

  /**
   * Empties the table, and reports how many went.
   *
   * Read *and* unread, which is the whole point of it: an operator clearing a
   * backlog is clearing the backlog, and a "delete all" that quietly kept the
   * unread ones would leave the bell still counting after the list looked empty.
   * The route in front of it is what asks first.
   */
  deleteAll(): number {
    return Number(this.stmt('DELETE FROM notifications').run().changes);
  }
}
