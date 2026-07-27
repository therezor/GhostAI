/**
 * Session and message persistence.
 *
 * One SQLite file holds everything GhostAI owns. Messages are **append-only**:
 * nothing ever updates a row in `messages`. That is not a stylistic preference
 * — a provider's prompt cache keys on an exact prefix, so editing history
 * invalidates the cache for every turn that follows and quietly multiplies the
 * cost of a long conversation. Consolidation therefore advances a marker
 * (`last_consolidated_seq`) rather than rewriting what it summarised, and the
 * summaries live in the memory files instead.
 *
 * Rows rather than a JSONL file per session: appending a row satisfies the same
 * append-only constraint while giving pagination, listing, and transactions for
 * free — and removes the mtime-cache bookkeeping a file-per-session store needs
 * to avoid re-reading the whole transcript on every access.
 *
 * `node:sqlite` rather than a native driver: it ships with Node, so there is no
 * prebuild to match against four platform/architecture pairs and no compiler on
 * the install path.
 */

import { DatabaseSync, type SQLOutputValue, type StatementSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';

import { ChatMessageSchema, type ChatMessage, type StoredMessage } from '@ghostai/protocol';
import type { z } from 'zod';

import { systemClock, type Clock } from './clock.js';
import { GhostError } from './errors.js';
import { historyForLLM, type HistoryForLLMOptions } from './history.js';
import { ensureDir } from './paths.js';

/**
 * What a caller may hand to `append`.
 *
 * The schema's *input* type, not its output: `toolCalls`, `isError` and
 * `truncated` all carry defaults, and requiring a caller to spell out
 * `toolCalls: []` on every plain assistant message would be noise that the
 * schema exists to remove.
 */
export type ChatMessageInput = z.input<typeof ChatMessageSchema>;

export interface SessionRecord {
  readonly key: string;
  readonly title: string;
  /** Channel that owns it — `web`, `telegram`, `automation`, a plugin id. */
  readonly origin: string;
  readonly profileId: string | undefined;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly metadata: Readonly<Record<string, unknown>>;
  /** Messages with `seq` at or below this are represented by the memory files. */
  readonly lastConsolidatedSeq: number;
  /** How far proactive learning has read. */
  readonly lastLearnedSeq: number;
}

export interface SessionSummaryRecord extends SessionRecord {
  readonly messageCount: number;
}

/**
 * A persisted message plus its `seq`.
 *
 * `seq` is storage's own concern — a stable, gap-free, per-session ordering
 * that survives identical timestamps, which `createdAtMs` does not: two
 * messages appended in the same millisecond are common when a turn emits
 * parallel tool results, and ordering by time alone makes their order
 * arbitrary. It is also the pagination cursor.
 */
export interface StoredMessageRecord {
  readonly id: string;
  readonly sessionKey: string;
  readonly seq: number;
  readonly createdAtMs: number;
  readonly turnId: string | undefined;
  readonly message: ChatMessage;
}

/** Narrows a storage record to the wire shape the REST and WS layers publish. */
export function toStoredMessage(record: StoredMessageRecord): StoredMessage {
  return {
    id: record.id,
    sessionKey: record.sessionKey,
    createdAtMs: record.createdAtMs,
    ...(record.turnId === undefined ? {} : { turnId: record.turnId }),
    message: record.message,
  };
}

export interface SessionStoreOptions {
  /** Path to the SQLite file. Defaults to an in-memory database. */
  readonly file?: string;
  /**
   * An existing connection to share.
   *
   * The scheduler, the auth store and the knowledge base all live in this same
   * file; handing them one connection keeps every write in a single WAL and
   * makes cross-table transactions possible. A store given a connection does
   * not close it — whoever opened it owns its lifetime.
   */
  readonly database?: DatabaseSync;
  readonly clock?: Clock;
  /** Injected so tests get stable ids instead of random ones. */
  readonly newId?: () => string;
}

export interface AppendOptions {
  /** Groups every message produced by one user turn, including tool traffic. */
  readonly turnId?: string;
}

export interface CreateSessionOptions {
  readonly title?: string;
  readonly origin?: string;
  readonly profileId?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface UpdateSessionOptions {
  readonly title?: string;
  readonly profileId?: string | null;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly lastConsolidatedSeq?: number;
  readonly lastLearnedSeq?: number;
}

export interface ListSessionsOptions {
  readonly limit?: number;
  readonly offset?: number;
  readonly origin?: string;
}

export interface ReadMessagesOptions {
  /** Exclusive lower bound on `seq` — the pagination cursor. */
  readonly afterSeq?: number;
  /** Exclusive upper bound on `seq`. */
  readonly beforeSeq?: number;
  readonly limit?: number;
  /** Takes the *last* `limit` messages rather than the first. */
  readonly fromEnd?: boolean;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  key                   TEXT    PRIMARY KEY,
  title                 TEXT    NOT NULL DEFAULT '',
  origin                TEXT    NOT NULL DEFAULT 'web',
  profile_id            TEXT,
  created_at_ms         INTEGER NOT NULL,
  updated_at_ms         INTEGER NOT NULL,
  metadata_json         TEXT    NOT NULL DEFAULT '{}',
  last_consolidated_seq INTEGER NOT NULL DEFAULT 0,
  last_learned_seq      INTEGER NOT NULL DEFAULT 0,
  next_seq              INTEGER NOT NULL DEFAULT 1
) STRICT;

CREATE TABLE IF NOT EXISTS messages (
  id            TEXT    PRIMARY KEY,
  session_key   TEXT    NOT NULL REFERENCES sessions(key) ON DELETE CASCADE,
  seq           INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  turn_id       TEXT,
  role          TEXT    NOT NULL,
  payload_json  TEXT    NOT NULL
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS messages_session_seq ON messages(session_key, seq);
CREATE INDEX IF NOT EXISTS messages_turn ON messages(session_key, turn_id);
CREATE INDEX IF NOT EXISTS sessions_updated ON sessions(updated_at_ms DESC);
`;

type Row = Record<string, SQLOutputValue>;

function readInt(row: Row, column: string): number {
  const value = row[column];
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  throw new GhostError('storage', `Expected an integer in column "${column}"`, {
    details: { column },
  });
}

function readString(row: Row, column: string): string {
  const value = row[column];
  if (typeof value === 'string') return value;
  throw new GhostError('storage', `Expected text in column "${column}"`, { details: { column } });
}

function readOptionalString(row: Row, column: string): string | undefined {
  const value = row[column];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Parses a `metadata_json` blob, tolerating anything that is not an object.
 *
 * Metadata is written by channels and plugins, so a malformed value is a bug in
 * something else. Failing the whole session read over it would make one bad
 * plugin write cost the user their conversation; an empty bag loses only the
 * metadata.
 */
function parseMetadata(raw: string): Readonly<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function rowToSession(row: Row): SessionRecord {
  return {
    key: readString(row, 'key'),
    title: readString(row, 'title'),
    origin: readString(row, 'origin'),
    profileId: readOptionalString(row, 'profile_id'),
    createdAtMs: readInt(row, 'created_at_ms'),
    updatedAtMs: readInt(row, 'updated_at_ms'),
    metadata: parseMetadata(readString(row, 'metadata_json')),
    lastConsolidatedSeq: readInt(row, 'last_consolidated_seq'),
    lastLearnedSeq: readInt(row, 'last_learned_seq'),
  };
}

export class SessionStore {
  readonly #db: DatabaseSync;
  readonly #ownsDb: boolean;
  readonly #clock: Clock;
  readonly #newId: () => string;
  readonly #statements = new Map<string, StatementSync>();
  #transactionDepth = 0;
  #closed = false;

  constructor(options: SessionStoreOptions = {}) {
    this.#clock = options.clock ?? systemClock;
    this.#newId = options.newId ?? randomUUID;

    if (options.database === undefined) {
      const file = options.file ?? ':memory:';
      if (file !== ':memory:') ensureDir(dirname(file));
      this.#db = new DatabaseSync(file);
      this.#ownsDb = true;
      // WAL lets the UI read a session while a turn is still writing to it.
      // A no-op for `:memory:`, which SQLite keeps on its own journal mode.
      this.#db.exec('PRAGMA journal_mode = WAL');
      // NORMAL trades an fsync per commit for one per checkpoint. Under WAL
      // that risks only the last commits on power loss, never corruption, and
      // the alternative is an fsync per streamed message.
      this.#db.exec('PRAGMA synchronous = NORMAL');
      this.#db.exec('PRAGMA busy_timeout = 5000');
    } else {
      this.#db = options.database;
      this.#ownsDb = false;
    }

    // Without this, deleting a session silently orphans its messages —
    // SQLite defaults foreign keys *off* for backwards compatibility.
    this.#db.exec('PRAGMA foreign_keys = ON');
    this.#db.exec(SCHEMA);
  }

  /** Prepared once and reused; re-preparing per call dominates append cost. */
  #stmt(sql: string): StatementSync {
    const cached = this.#statements.get(sql);
    if (cached !== undefined) return cached;
    const prepared = this.#db.prepare(sql);
    this.#statements.set(sql, prepared);
    return prepared;
  }

  /**
   * Runs `fn` inside a transaction, joining an outer one if present.
   *
   * Re-entrant by depth rather than by `SAVEPOINT`: the nesting here is one
   * level deep by construction (`appendMany` calling `ensureSession`), and a
   * savepoint stack would add a rollback path with no caller able to reach it.
   */
  #transaction<T>(fn: () => T): T {
    if (this.#transactionDepth > 0) return fn();
    this.#db.exec('BEGIN');
    this.#transactionDepth += 1;
    try {
      const result = fn();
      this.#db.exec('COMMIT');
      return result;
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    } finally {
      this.#transactionDepth -= 1;
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new GhostError('storage', 'Session store is closed');
  }

  getSession(key: string): SessionRecord | undefined {
    this.#assertOpen();
    const row = this.#stmt('SELECT * FROM sessions WHERE key = ?').get(key);
    return row === undefined ? undefined : rowToSession(row);
  }

  /**
   * Returns the session, creating it if absent.
   *
   * Idempotent: the create is `INSERT OR IGNORE`, so two channels racing to
   * open the same session key both get the existing row rather than one of them
   * failing on the primary key.
   */
  ensureSession(key: string, options: CreateSessionOptions = {}): SessionRecord {
    this.#assertOpen();
    if (key.length === 0) throw new GhostError('invalid_input', 'Session key must not be empty');

    const now = this.#clock.now();
    this.#stmt(
      `INSERT OR IGNORE INTO sessions
         (key, title, origin, profile_id, created_at_ms, updated_at_ms, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      key,
      options.title ?? '',
      options.origin ?? 'web',
      options.profileId ?? null,
      now,
      now,
      JSON.stringify(options.metadata ?? {}),
    );

    const session = this.getSession(key);
    if (session === undefined) {
      throw new GhostError('storage', 'Session vanished immediately after insert', {
        details: { key },
      });
    }
    return session;
  }

  listSessions(options: ListSessionsOptions = {}): SessionSummaryRecord[] {
    this.#assertOpen();
    const { limit = 50, offset = 0, origin } = options;

    const rows = this.#stmt(
      `SELECT s.*, (SELECT COUNT(*) FROM messages m WHERE m.session_key = s.key) AS message_count
         FROM sessions s
        WHERE (? IS NULL OR s.origin = ?)
        ORDER BY s.updated_at_ms DESC, s.key ASC
        LIMIT ? OFFSET ?`,
    ).all(origin ?? null, origin ?? null, limit, offset);

    return rows.map((row) => ({
      ...rowToSession(row),
      messageCount: readInt(row, 'message_count'),
    }));
  }

  messageCount(sessionKey: string): number {
    this.#assertOpen();
    const row = this.#stmt('SELECT COUNT(*) AS n FROM messages WHERE session_key = ?').get(
      sessionKey,
    );
    return row === undefined ? 0 : readInt(row, 'n');
  }

  /**
   * Appends one message and returns it as persisted.
   *
   * Validates through the schema on the way in, so defaults are applied once
   * here rather than at every read, and a malformed message is rejected by the
   * caller that produced it instead of surfacing later as a provider 400 from a
   * session nobody can explain.
   */
  append(
    sessionKey: string,
    message: ChatMessageInput,
    options: AppendOptions = {},
  ): StoredMessageRecord {
    const [record] = this.appendMany(sessionKey, [message], options);
    if (record === undefined) {
      throw new GhostError('storage', 'Append returned no record', { details: { sessionKey } });
    }
    return record;
  }

  /**
   * Appends several messages in one transaction.
   *
   * An assistant turn and its tool results land together or not at all —
   * a partial write is precisely the orphaned-tool-result state that
   * `findLegalStart` then has to repair on every subsequent request.
   */
  appendMany(
    sessionKey: string,
    messages: readonly ChatMessageInput[],
    options: AppendOptions = {},
  ): StoredMessageRecord[] {
    this.#assertOpen();
    if (messages.length === 0) return [];

    const parsed = messages.map((message, index) => {
      const result = ChatMessageSchema.safeParse(message);
      if (!result.success) {
        throw new GhostError('invalid_input', 'Message failed schema validation', {
          details: { sessionKey, index, issues: result.error.issues },
        });
      }
      return result.data;
    });

    return this.#transaction(() => {
      this.ensureSession(sessionKey);
      const now = this.#clock.now();

      const reserve = this.#stmt(
        'UPDATE sessions SET next_seq = next_seq + ? WHERE key = ? RETURNING next_seq',
      ).get(parsed.length, sessionKey);
      if (reserve === undefined) {
        throw new GhostError('storage', 'Failed to reserve message sequence', {
          details: { sessionKey },
        });
      }
      // `next_seq` now points past the block just reserved.
      const firstSeq = readInt(reserve, 'next_seq') - parsed.length;

      const insert = this.#stmt(
        `INSERT INTO messages (id, session_key, seq, created_at_ms, turn_id, role, payload_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );

      const records = parsed.map((message, index): StoredMessageRecord => {
        const id = this.#newId();
        const seq = firstSeq + index;
        insert.run(
          id,
          sessionKey,
          seq,
          now,
          options.turnId ?? null,
          message.role,
          JSON.stringify(message),
        );
        return {
          id,
          sessionKey,
          seq,
          createdAtMs: now,
          turnId: options.turnId,
          message,
        };
      });

      this.#stmt('UPDATE sessions SET updated_at_ms = ? WHERE key = ?').run(now, sessionKey);
      return records;
    });
  }

  /**
   * Reads persisted messages in `seq` order.
   *
   * A payload that no longer parses is a schema change that landed without a
   * migration. It throws rather than skipping: silently dropping a message
   * would break tool-call pairing for the turn it belonged to, and a loud
   * failure at read time is far cheaper to diagnose than a provider 400 later.
   */
  messages(sessionKey: string, options: ReadMessagesOptions = {}): StoredMessageRecord[] {
    this.#assertOpen();
    const { afterSeq = 0, beforeSeq, limit, fromEnd = false } = options;

    const rows = this.#stmt(
      `SELECT * FROM messages
        WHERE session_key = ? AND seq > ? AND (? IS NULL OR seq < ?)
        ORDER BY seq ${fromEnd ? 'DESC' : 'ASC'}
        LIMIT ?`,
    ).all(sessionKey, afterSeq, beforeSeq ?? null, beforeSeq ?? null, limit ?? -1);

    if (fromEnd) rows.reverse();

    return rows.map((row): StoredMessageRecord => {
      const seq = readInt(row, 'seq');
      const parsed = ChatMessageSchema.safeParse(JSON.parse(readString(row, 'payload_json')));
      if (!parsed.success) {
        throw new GhostError('storage', 'Stored message failed schema validation', {
          details: { sessionKey, seq, issues: parsed.error.issues },
        });
      }
      return {
        id: readString(row, 'id'),
        sessionKey,
        seq,
        createdAtMs: readInt(row, 'created_at_ms'),
        turnId: readOptionalString(row, 'turn_id'),
        message: parsed.data,
      };
    });
  }

  /**
   * The message list to send to a provider.
   *
   * Reads only past `last_consolidated_seq` — everything before it is already
   * represented by the memory files, and replaying it would send the same
   * content twice — then hands the window to `historyForLLM` for boundary
   * alignment and tool-result truncation.
   */
  history(sessionKey: string, options: HistoryForLLMOptions = {}): ChatMessage[] {
    const session = this.getSession(sessionKey);
    if (session === undefined) return [];

    const { maxMessages, ...rest } = options;
    const records = this.messages(sessionKey, {
      afterSeq: session.lastConsolidatedSeq,
      ...(maxMessages !== undefined && maxMessages > 0
        ? { limit: maxMessages, fromEnd: true }
        : {}),
    });

    return historyForLLM(
      records.map((record) => record.message),
      // `fromIndex` is already applied by the SQL bound above; re-applying it
      // here would skip a second block of the same size.
      { ...rest, fromIndex: 0, ...(maxMessages === undefined ? {} : { maxMessages }) },
    );
  }

  updateSession(sessionKey: string, patch: UpdateSessionOptions): SessionRecord {
    this.#assertOpen();
    const existing = this.ensureSession(sessionKey);
    const now = this.#clock.now();

    const next = {
      title: patch.title ?? existing.title,
      // `null` clears the profile, `undefined` leaves it alone — the two have
      // to stay distinguishable, or unsetting a profile becomes impossible
      // through a patch that also touches any other field.
      profileId:
        patch.profileId === undefined ? existing.profileId : (patch.profileId ?? undefined),
      metadata: patch.metadata ?? existing.metadata,
      lastConsolidatedSeq: patch.lastConsolidatedSeq ?? existing.lastConsolidatedSeq,
      lastLearnedSeq: patch.lastLearnedSeq ?? existing.lastLearnedSeq,
    };

    this.#stmt(
      `UPDATE sessions
          SET title = ?, profile_id = ?, metadata_json = ?,
              last_consolidated_seq = ?, last_learned_seq = ?, updated_at_ms = ?
        WHERE key = ?`,
    ).run(
      next.title,
      next.profileId ?? null,
      JSON.stringify(next.metadata),
      next.lastConsolidatedSeq,
      next.lastLearnedSeq,
      now,
      sessionKey,
    );

    return { ...existing, ...next, updatedAtMs: now };
  }

  /**
   * Drops every message but keeps the session row.
   *
   * `next_seq` is *not* reset. Reusing sequence numbers after a clear would
   * make a stale `afterSeq` cursor held by a reconnecting client silently
   * address the wrong messages; sequences are monotonic for the session's
   * lifetime, and the gap is the point.
   */
  clearMessages(sessionKey: string): void {
    this.#assertOpen();
    this.#transaction(() => {
      this.#stmt('DELETE FROM messages WHERE session_key = ?').run(sessionKey);
      this.#stmt(
        'UPDATE sessions SET last_consolidated_seq = 0, last_learned_seq = 0, updated_at_ms = ? WHERE key = ?',
      ).run(this.#clock.now(), sessionKey);
    });
  }

  /** Deletes the session and, by cascade, its messages. */
  deleteSession(sessionKey: string): boolean {
    this.#assertOpen();
    return this.#stmt('DELETE FROM sessions WHERE key = ?').run(sessionKey).changes > 0;
  }

  /** Idempotent, and a no-op for a connection this store did not open. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#statements.clear();
    if (this.#ownsDb) this.#db.close();
  }
}
