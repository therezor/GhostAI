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
 * **`truncateAfter` does not break that rule, and it is worth being precise
 * about why.** The rule forbids *rewriting* — an `UPDATE` on a `messages` row,
 * which changes a prefix the provider has already cached and invalidates
 * everything after it. Dropping a *suffix* changes no prefix: every retained
 * row is byte-identical, so the cached prefix stays warm and the conversation
 * simply re-diverges from the cut. That is the case a prompt cache is built
 * for. Regenerate and edit are therefore expressible; "change what the model
 * was told three turns ago and keep the answers" still is not.
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

import {
  ChatMessageSchema,
  SUBAGENT_ORIGIN,
  subagentRunsOf,
  type ChatMessage,
  type StopReason,
  type StoredMessage,
  type Usage,
} from '@ghostai/protocol';
import type { z } from 'zod';

import { systemClock, type Clock } from './clock.js';
import { GhostError } from './errors.js';
import { findLegalEnd, historyForLLM, type HistoryForLLMOptions } from './history.js';
import { textOf } from './messages.js';
import { ensureDir } from './paths.js';
import { deriveSessionTitle } from './session-title.js';
import { DEFAULT_WORKSPACE_ID } from './workspace-id.js';

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
  /**
   * The workspace this session's tools run inside.
   *
   * Set once, at creation, and never moved: a turn resolves its jail from
   * *this* value rather than from whatever the request said, which is what
   * makes switching workspaces in the UI safe while a turn is still running.
   */
  readonly workspaceId: string;
  readonly agentId: string | undefined;
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
    seq: record.seq,
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
  /** Defaults to `default`. Honoured only when the row is actually created. */
  readonly workspaceId?: string;
  readonly agentId?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface UpdateSessionOptions {
  readonly title?: string;
  readonly agentId?: string | null;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly lastConsolidatedSeq?: number;
  readonly lastLearnedSeq?: number;
}

export interface ListSessionsOptions {
  readonly limit?: number;
  readonly offset?: number;
  readonly origin?: string;
  /** Restricts the listing to one workspace. */
  readonly workspaceId?: string;
  /**
   * Keyset cursor: the `(updatedAtMs, key)` of the last row already seen.
   *
   * Preferred over `offset` for anything a user pages through, because the
   * ordering key moves. A turn landing between two requests bumps a session to
   * the front, which shifts every offset behind it by one and makes an
   * offset-paged reader see one row twice and miss another. A keyset predicate
   * asks for "strictly after this row in the sort order" instead, so a row that
   * moves forward is one the reader has already passed and a row that does not
   * move keeps its place.
   *
   * Ignored unless both fields are present — half a cursor cannot address a
   * position in a two-column ordering.
   */
  readonly after?: SessionCursor;
}

/** A position in the `updated_at_ms DESC, key ASC` ordering `listSessions` uses. */
export interface SessionCursor {
  readonly updatedAtMs: number;
  readonly key: string;
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

export interface TruncateResult {
  /** Where the cut actually landed, after snapping to a legal boundary. */
  readonly seq: number;
  readonly deleted: number;
}

export interface ForkSessionOptions {
  /** Defaults to `<origin>-<uuid>`, matching what the REST create route mints. */
  readonly key?: string;
  readonly title?: string;
  readonly workspaceId?: string;
  readonly agentId?: string;
  readonly origin?: string;
}

export interface ForkResult {
  readonly session: SessionRecord;
  readonly copied: number;
  /** Where the fork actually cut, after snapping. */
  readonly seq: number;
}

/** What one turn cost, recorded when it ends. */
export interface TurnStatsRecord {
  readonly turnId: string;
  readonly sessionKey: string;
  /** Which agent ran the turn. Empty on a turn recorded before agents existed. */
  readonly agentId: string;
  readonly provider: string;
  readonly model: string;
  readonly startedAtMs: number;
  readonly endedAtMs: number;
  readonly iterations: number;
  readonly stopReason: StopReason;
  readonly usage: Usage;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  key                   TEXT    PRIMARY KEY,
  title                 TEXT    NOT NULL DEFAULT '',
  origin                TEXT    NOT NULL DEFAULT 'web',
  agent_id              TEXT,
  -- No \`REFERENCES workspaces(id)\`: the two tables are created by two
  -- different stores in an order nothing guarantees. The relationship is held
  -- in code instead, which is also what lets a *detached* workspace's sessions
  -- keep resolving to their own files rather than falling into another's.
  workspace_id          TEXT    NOT NULL DEFAULT '${DEFAULT_WORKSPACE_ID}',
  created_at_ms         INTEGER NOT NULL,
  updated_at_ms         INTEGER NOT NULL,
  metadata_json         TEXT    NOT NULL DEFAULT '{}',
  last_consolidated_seq INTEGER NOT NULL DEFAULT 0,
  last_learned_seq      INTEGER NOT NULL DEFAULT 0,
  next_seq              INTEGER NOT NULL DEFAULT 1
) STRICT;

CREATE INDEX IF NOT EXISTS sessions_workspace ON sessions(workspace_id, updated_at_ms DESC);

CREATE TABLE IF NOT EXISTS messages (
  id            TEXT    PRIMARY KEY,
  session_key   TEXT    NOT NULL REFERENCES sessions(key) ON DELETE CASCADE,
  seq           INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  turn_id       TEXT,
  role          TEXT    NOT NULL,
  payload_json  TEXT    NOT NULL
) STRICT;

-- What a turn cost, keyed by the id that groups its messages.
--
-- Here rather than in the migration ledger because the ledger is only for
-- altering tables that already exist; a new table is created by the store that
-- owns it. That is also what lets this one carry a real foreign key, which
-- ADD COLUMN cannot express -- so deleting a session takes its stats with it.
--
-- Usage is five integer columns rather than a JSON blob so that a session's
-- total is one SUM(...) GROUP BY session_key over a page of keys instead of a
-- query per row. SUM over all-NULL returns NULL, which is exactly what the two
-- optional usage fields mean.
--
-- The agent is recorded per turn rather than read from the session because a
-- session can be moved to another agent, and a transcript that then reported
-- every past turn as the new agent's work would be a lie about what ran.
CREATE TABLE IF NOT EXISTS turn_stats (
  turn_id           TEXT    PRIMARY KEY,
  session_key       TEXT    NOT NULL REFERENCES sessions(key) ON DELETE CASCADE,
  agent_id          TEXT    NOT NULL DEFAULT '',
  provider          TEXT    NOT NULL DEFAULT '',
  model             TEXT    NOT NULL DEFAULT '',
  started_at_ms     INTEGER NOT NULL,
  ended_at_ms       INTEGER NOT NULL,
  iterations        INTEGER NOT NULL DEFAULT 0,
  stop_reason       TEXT    NOT NULL DEFAULT '',
  prompt_tokens     INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens      INTEGER NOT NULL DEFAULT 0,
  cached_tokens     INTEGER,
  reasoning_tokens  INTEGER
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS messages_session_seq ON messages(session_key, seq);
CREATE INDEX IF NOT EXISTS messages_turn ON messages(session_key, turn_id);
CREATE INDEX IF NOT EXISTS sessions_updated ON sessions(updated_at_ms DESC);
CREATE INDEX IF NOT EXISTS turn_stats_session ON turn_stats(session_key, ended_at_ms DESC);
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
 * An integer column that may be `NULL`.
 *
 * `SUM` over a column of all-`NULL` returns `NULL` rather than `0`, which is
 * exactly the distinction the two optional usage fields carry: a provider that
 * never reported cached tokens is not a provider that reported zero.
 */
function readOptionalInt(row: Row, column: string): number | undefined {
  const value = row[column];
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  return undefined;
}

function readUsage(row: Row): Usage {
  const cachedTokens = readOptionalInt(row, 'cached_tokens');
  const reasoningTokens = readOptionalInt(row, 'reasoning_tokens');
  return {
    promptTokens: readOptionalInt(row, 'prompt_tokens') ?? 0,
    completionTokens: readOptionalInt(row, 'completion_tokens') ?? 0,
    totalTokens: readOptionalInt(row, 'total_tokens') ?? 0,
    ...(cachedTokens === undefined ? {} : { cachedTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
  };
}

function rowToTurnStats(row: Row): TurnStatsRecord {
  return {
    turnId: readString(row, 'turn_id'),
    sessionKey: readString(row, 'session_key'),
    agentId: readString(row, 'agent_id'),
    provider: readString(row, 'provider'),
    model: readString(row, 'model'),
    startedAtMs: readInt(row, 'started_at_ms'),
    endedAtMs: readInt(row, 'ended_at_ms'),
    iterations: readInt(row, 'iterations'),
    stopReason: readString(row, 'stop_reason') as StopReason,
    usage: readUsage(row),
  };
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
    workspaceId: readString(row, 'workspace_id'),
    agentId: readOptionalString(row, 'agent_id'),
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

  /**
   * The connection this store is using, so a sibling store can share it.
   *
   * `WorkspaceStore` has a cross-table invariant with `sessions` — a workspace
   * cannot be detached while sessions still name it — and two stores holding
   * separate connections to the same file could not read each other's
   * uncommitted work. Closing it is not the borrower's business; `close()`
   * here still only closes a connection this store opened.
   */
  get database(): DatabaseSync {
    return this.#db;
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
         (key, title, origin, workspace_id, agent_id, created_at_ms, updated_at_ms, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      key,
      options.title ?? '',
      options.origin ?? 'web',
      // `OR IGNORE`, so this only lands when the row is created. A session's
      // workspace is fixed at birth: a turn arriving with a different one must
      // not move a conversation's files out from under it.
      options.workspaceId ?? DEFAULT_WORKSPACE_ID,
      options.agentId ?? null,
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
    const { limit = 50, offset = 0, origin, workspaceId, after } = options;

    // The predicate is the sort order written as a comparison: strictly older,
    // or the same instant and a key that sorts later. Bound as `?` twice each
    // rather than named, because `node:sqlite` binds positionally.
    // Subagent sessions are excluded unless asked for by name. They are real
    // rows — that is what makes a delegation inspectable after a reload — but
    // they are not conversations: one turn, started by a model, ending when the
    // tool call that made it returns. A sidebar that listed them would bury the
    // conversations a person actually had under the machinery of one of them.
    //
    // Expressed as `origin = ?` winning over the exclusion rather than as a
    // separate flag, so there is one way to ask and no combination that means
    // two things.
    const rows = this.#stmt(
      `SELECT s.*, (SELECT COUNT(*) FROM messages m WHERE m.session_key = s.key) AS message_count
         FROM sessions s
        WHERE (? IS NULL OR s.origin = ?)
          AND (? IS NOT NULL OR s.origin <> '${SUBAGENT_ORIGIN}')
          AND (? IS NULL OR s.workspace_id = ?)
          AND (? IS NULL
               OR s.updated_at_ms < ?
               OR (s.updated_at_ms = ? AND s.key > ?))
        ORDER BY s.updated_at_ms DESC, s.key ASC
        LIMIT ? OFFSET ?`,
    ).all(
      origin ?? null,
      origin ?? null,
      origin ?? null,
      workspaceId ?? null,
      workspaceId ?? null,
      after?.updatedAtMs ?? null,
      after?.updatedAtMs ?? null,
      after?.updatedAtMs ?? null,
      after?.key ?? null,
      limit,
      offset,
    );

    return rows.map((row) => ({
      ...rowToSession(row),
      messageCount: readInt(row, 'message_count'),
    }));
  }

  /**
   * How many sessions name a workspace.
   *
   * Lives here rather than on `WorkspaceStore` because this table is this
   * store's, and a registry reaching across to count rows it does not own is
   * how two stores end up with two ideas of the same schema. Detaching a
   * workspace is refused while this is non-zero.
   */
  countByWorkspace(workspaceId: string): number {
    this.#assertOpen();
    const row = this.#stmt('SELECT COUNT(*) AS n FROM sessions WHERE workspace_id = ?').get(
      workspaceId,
    );
    return row === undefined ? 0 : readInt(row, 'n');
  }

  /**
   * Moves every session in one workspace to another, and reports how many.
   *
   * The escape hatch behind the delete refusal: an operator who wants a
   * workspace gone anyway moves its conversations to the default first. It
   * deliberately does not touch `updated_at_ms` — reassigning is bookkeeping,
   * not activity, and bumping every row would reorder the session list.
   */
  reassignWorkspace(from: string, to: string): number {
    this.#assertOpen();
    const result = this.#stmt('UPDATE sessions SET workspace_id = ? WHERE workspace_id = ?').run(
      to,
      from,
    );
    return Number(result.changes);
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
      // `null` clears the agent, `undefined` leaves it alone — the two have
      // to stay distinguishable, or unsetting an agent becomes impossible
      // through a patch that also touches any other field.
      agentId: patch.agentId === undefined ? existing.agentId : (patch.agentId ?? undefined),
      metadata: patch.metadata ?? existing.metadata,
      lastConsolidatedSeq: patch.lastConsolidatedSeq ?? existing.lastConsolidatedSeq,
      lastLearnedSeq: patch.lastLearnedSeq ?? existing.lastLearnedSeq,
    };

    this.#stmt(
      `UPDATE sessions
          SET title = ?, agent_id = ?, metadata_json = ?,
              last_consolidated_seq = ?, last_learned_seq = ?, updated_at_ms = ?
        WHERE key = ?`,
    ).run(
      next.title,
      next.agentId ?? null,
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

  /**
   * The largest cut at or below `seq` that leaves no tool call unanswered.
   *
   * A cut through the middle of a tool exchange strands the `assistant` that
   * declared the calls, which every provider rejects with a 400 — the mirror of
   * the defect `findLegalStart` repairs at the other end of the window. Only the
   * *unconsolidated* tail is examined, because everything at or below
   * `last_consolidated_seq` is represented by the memory files rather than
   * replayed, so pairing across that boundary is not a thing a provider ever
   * sees.
   */
  #legalSeq(session: SessionRecord, seq: number): number {
    const floor = Math.min(session.lastConsolidatedSeq, seq);
    const records = this.messages(session.key, { afterSeq: floor, beforeSeq: seq + 1 });
    const end = findLegalEnd(records.map((record) => record.message));

    if (end === records.length) return seq;
    if (end === 0) return floor;
    return records[end - 1]?.seq ?? floor;
  }

  /**
   * Drops every message after `seq`, and reports where the cut actually landed.
   *
   * This is what regenerate and edit are built on: re-running a turn means
   * forgetting the answers that followed the question. See the module header for
   * why removing a suffix is compatible with the append-only rule that forbids
   * rewriting a row.
   *
   * The cut is always snapped to a legal tool boundary. The caller has no
   * information this store lacks with which to decide otherwise, and an
   * unsnapped cut does not fail here — it fails as a provider 400 on the next
   * turn, a long way from the code that caused it.
   *
   * `next_seq` is deliberately left alone, for the reason `clearMessages` gives:
   * a stale `afterSeq` cursor held by a reconnecting client must never come back
   * to address a different message. Sequences go sparse after a truncation, and
   * the gap is the point.
   *
   * **Concurrency is the caller's problem**, because it has to be: this store
   * cannot know a turn is running, and truncating under one would race the
   * loop's own append. The hub guards with `busy()`; the CLI's REPL only reaches
   * this at an idle prompt.
   */
  truncateAfter(sessionKey: string, seq: number): TruncateResult {
    this.#assertOpen();

    return this.#transaction(() => {
      const session = this.getSession(sessionKey);
      if (session === undefined) {
        throw new GhostError('not_found', `No such session: ${sessionKey}`, {
          details: { sessionKey },
        });
      }

      const cut = Math.max(0, this.#legalSeq(session, seq));
      const deleted = Number(
        this.#stmt('DELETE FROM messages WHERE session_key = ? AND seq > ?').run(sessionKey, cut)
          .changes,
      );

      // Nothing moved, so nothing should be bumped to the top of the session
      // list — a no-op truncation is not activity.
      if (deleted > 0) {
        // Clamping is not housekeeping. A marker left above the highest
        // surviving seq makes `history()` read `afterSeq: 100` on a session
        // whose last message is 50, which is an empty prompt on a conversation
        // that visibly has messages. It does not un-summarise the memory files;
        // it restores `marker <= max(seq)`, and the rows it would have skipped
        // are gone regardless.
        this.#stmt(
          `UPDATE sessions
              SET last_consolidated_seq = MIN(last_consolidated_seq, ?),
                  last_learned_seq      = MIN(last_learned_seq, ?),
                  updated_at_ms         = ?
            WHERE key = ?`,
        ).run(cut, cut, this.#clock.now(), sessionKey);
      }

      return { seq: cut, deleted };
    });
  }

  /**
   * Copies a conversation up to `uptoSeq` into a new session.
   *
   * What "branch" means here. The alternative — a `parent_seq` column and a
   * message tree — buys sibling navigation at the cost of teaching every reader
   * of the flat log about branches, including the CLI and `historyForLLM`. A
   * fork is a session, so it appears in the sidebar, opens in the CLI and is
   * deleted like any other, and the code that reads it needs to know nothing.
   *
   * Two decisions carry the weight:
   *
   *  - **Seqs are reseated densely from 1.** A fork is a new sequence space;
   *    preserving the source's numbering would start a fresh conversation at seq
   *    4711 and leave the markers below pointing at rows that are not there.
   *  - **`turn_id` and `created_at_ms` are preserved.** Up to the cut the fork
   *    *is* the same conversation, so it renders identically and its turn stats
   *    — which are keyed by turn id — still describe the run that produced it.
   *
   * Lineage goes in the metadata bag rather than a column: it costs no schema,
   * no index and no query surface, and nothing needs to search by it.
   */
  forkSession(sourceKey: string, uptoSeq: number, options: ForkSessionOptions = {}): ForkResult {
    this.#assertOpen();

    return this.#transaction(() => {
      const source = this.getSession(sourceKey);
      if (source === undefined) {
        throw new GhostError('not_found', `No such session: ${sourceKey}`, {
          details: { sessionKey: sourceKey },
        });
      }

      const cut = Math.max(0, this.#legalSeq(source, uptoSeq));
      const records = this.messages(sourceKey, { beforeSeq: cut + 1 });
      const now = this.#clock.now();
      const origin = options.origin ?? source.origin;
      const key = options.key ?? `${origin}-${this.#newId()}`;

      if (this.getSession(key) !== undefined) {
        throw new GhostError('conflict', `Session already exists: ${key}`, {
          details: { sessionKey: key },
        });
      }

      const firstUser = records.find((record) => record.message.role === 'user');
      const title =
        options.title ??
        (source.title !== ''
          ? source.title
          : firstUser === undefined
            ? ''
            : deriveSessionTitle(textOf(firstUser.message)));

      // Seqs are reseated by position, so translating a marker is a count of
      // the copied rows it covered — exact rather than approximate.
      const consolidated = records.filter(
        (record) => record.seq <= source.lastConsolidatedSeq,
      ).length;
      const learned = records.filter((record) => record.seq <= source.lastLearnedSeq).length;

      this.#stmt(
        `INSERT INTO sessions
           (key, title, origin, workspace_id, agent_id, created_at_ms, updated_at_ms,
            metadata_json, last_consolidated_seq, last_learned_seq, next_seq)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        key,
        title,
        origin,
        options.workspaceId ?? source.workspaceId,
        options.agentId ?? source.agentId ?? null,
        source.createdAtMs,
        // Now, not the source's: a fork is something the user just did, and the
        // session list is ordered by this.
        now,
        JSON.stringify({
          ...source.metadata,
          forkedFrom: { key: sourceKey, seq: cut, atMs: now },
        }),
        consolidated,
        learned,
        records.length + 1,
      );

      // `appendMany` cannot be reused: it stamps one `now` and one `turnId`
      // across the block, and both are being preserved per row here.
      const insert = this.#stmt(
        `INSERT INTO messages (id, session_key, seq, created_at_ms, turn_id, role, payload_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const [index, record] of records.entries()) {
        insert.run(
          this.#newId(),
          key,
          index + 1,
          record.createdAtMs,
          record.turnId ?? null,
          record.message.role,
          // Re-serialised from the parsed object rather than re-validated:
          // `messages()` already parsed it on the way out.
          JSON.stringify(record.message),
        );
      }

      const session = this.getSession(key);
      if (session === undefined) {
        throw new GhostError('storage', 'Fork vanished immediately after insert', {
          details: { sessionKey: key },
        });
      }

      return { session, copied: records.length, seq: cut };
    });
  }

  /**
   * Records what a turn cost.
   *
   * An upsert rather than a plain insert: a turn that ends twice — which the
   * hub's own failure path can produce — must not throw on the primary key.
   */
  recordTurnStats(stats: TurnStatsRecord): void {
    this.#assertOpen();
    this.#stmt(
      `INSERT INTO turn_stats
         (turn_id, session_key, agent_id, provider, model, started_at_ms, ended_at_ms,
          iterations, stop_reason, prompt_tokens, completion_tokens, total_tokens,
          cached_tokens, reasoning_tokens)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(turn_id) DO UPDATE SET
         agent_id = excluded.agent_id,
         provider = excluded.provider, model = excluded.model,
         started_at_ms = excluded.started_at_ms, ended_at_ms = excluded.ended_at_ms,
         iterations = excluded.iterations, stop_reason = excluded.stop_reason,
         prompt_tokens = excluded.prompt_tokens,
         completion_tokens = excluded.completion_tokens,
         total_tokens = excluded.total_tokens, cached_tokens = excluded.cached_tokens,
         reasoning_tokens = excluded.reasoning_tokens`,
    ).run(
      stats.turnId,
      stats.sessionKey,
      stats.agentId,
      stats.provider,
      stats.model,
      stats.startedAtMs,
      stats.endedAtMs,
      stats.iterations,
      stats.stopReason,
      stats.usage.promptTokens,
      stats.usage.completionTokens,
      stats.usage.totalTokens,
      stats.usage.cachedTokens ?? null,
      stats.usage.reasoningTokens ?? null,
    );
  }

  /** A session's turns, most recent first. */
  turnStats(sessionKey: string, options: { readonly limit?: number } = {}): TurnStatsRecord[] {
    this.#assertOpen();
    const rows = this.#stmt(
      `SELECT * FROM turn_stats
        WHERE session_key = ?
        ORDER BY ended_at_ms DESC, turn_id ASC
        LIMIT ?`,
    ).all(sessionKey, options.limit ?? -1);
    return rows.map(rowToTurnStats);
  }

  /**
   * Total usage per session, for a page of keys.
   *
   * One statement for the whole page rather than one per row — the session list
   * reports this for every conversation it shows, and a query per row is the
   * difference between a listing and fifty of them. The placeholder list varies
   * with the page size, so a page of 50 and a page of 51 prepare two statements;
   * that is a handful of shapes and is not a reason to concatenate values into
   * the SQL.
   */
  sessionUsage(sessionKeys: readonly string[]): Map<string, Usage> {
    this.#assertOpen();
    const totals = new Map<string, Usage>();
    if (sessionKeys.length === 0) return totals;

    const placeholders = sessionKeys.map(() => '?').join(', ');
    const rows = this.#stmt(
      `SELECT session_key,
              SUM(prompt_tokens)     AS prompt_tokens,
              SUM(completion_tokens) AS completion_tokens,
              SUM(total_tokens)      AS total_tokens,
              SUM(cached_tokens)     AS cached_tokens,
              SUM(reasoning_tokens)  AS reasoning_tokens
         FROM turn_stats
        WHERE session_key IN (${placeholders})
        GROUP BY session_key`,
    ).all(...sessionKeys);

    for (const row of rows) {
      totals.set(readString(row, 'session_key'), readUsage(row));
    }
    return totals;
  }

  /**
   * Deletes the session, its messages, its turn stats — and its subagent runs.
   *
   * The first three are SQLite's cascade. The last one is not, and cannot be:
   * the link to a subagent's session is a key inside the metadata bag, which is
   * a JSON blob rather than a foreign key. Doing it here rather than leaving it
   * to a caller is what keeps "delete this conversation" from leaving a row per
   * delegation behind, invisible in every listing and reachable by nothing.
   *
   * One level, deliberately not recursive at the SQL layer but recursive by
   * call: a subagent's own subagents are deleted when *it* is, because its row
   * carries the same map. Depth is capped, so this terminates for the same
   * reason delegation does.
   */
  deleteSession(sessionKey: string): boolean {
    this.#assertOpen();

    return this.#transaction(() => {
      const session = this.getSession(sessionKey);
      if (session === undefined) return false;

      for (const run of Object.values(subagentRunsOf(session.metadata))) {
        // Not guarded on existence: a child that is already gone is the normal
        // case for a session deleted twice, and is not worth distinguishing.
        this.deleteSession(run.sessionKey);
      }

      return this.#stmt('DELETE FROM sessions WHERE key = ?').run(sessionKey).changes > 0;
    });
  }

  /** Idempotent, and a no-op for a connection this store did not open. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#statements.clear();
    if (this.#ownsDb) this.#db.close();
  }
}
