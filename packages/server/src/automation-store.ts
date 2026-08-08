/**
 * Scheduled jobs and their run history.
 *
 * Here rather than in `@ghostbot/core` for the reason the auth tables are:
 * nothing below the transport schedules anything. The agent loop has no opinion
 * about when it is called, and the one thing that does — the scheduler — sits at
 * this level beside the hub it drives turns through.
 *
 * Three decisions worth stating:
 *
 *  - **`schedule` and `payload` are JSON columns, not decomposed.** They are
 *    discriminated unions, and `automation.ts` says in as many words that the
 *    union exists so `{kind: 'cron', atMs: 5}` is not representable. Spreading
 *    them into `kind, at_ms, every_ms, expr, tz` rebuilds exactly the nullable
 *    flat shape it refuses, and nothing would then stop a hand-edited row from
 *    running on the wrong trigger. `state` *is* decomposed, because
 *    `next_run_at_ms` has to be indexable for the timer's due query.
 *
 *  - **A row whose JSON does not parse is disabled, not skipped.** Listing
 *    tolerates it — one bad row must not blank the panel, the same call
 *    `readLevel` makes next door — but `dueJobs` cannot: a schedule nobody can
 *    read is a schedule nobody can honour, and quietly passing over it produces
 *    a job that shows in the UI and never fires. It is switched off with the
 *    parse failure in `last_error`, so it is visible and inert rather than a
 *    silent hole.
 *
 *  - **Run history is trimmed per job, not globally.** A job on a five-minute
 *    interval writes about 105,000 rows a year. One shared ceiling would let
 *    that job's afternoon evict a nightly job's entire year, which is backwards:
 *    the sparse history is the one worth keeping.
 */

import type { DatabaseSync, StatementSync } from 'node:sqlite';

import {
  GhostError,
  rowReader,
  silentLogger,
  systemClock,
  type Clock,
  type Logger,
  type Row,
} from '@ghostbot/core';
import {
  AutomationPayloadSchema,
  AutomationScheduleSchema,
  RunStatusSchema,
  newUuid,
  type AutomationJob,
  type AutomationPayload,
  type AutomationRun,
  type AutomationSchedule,
  type RunStatus,
} from '@ghostbot/protocol';

import type { AutomationRunCursor } from './cursor.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS automation_jobs (
  id               TEXT    PRIMARY KEY,
  name             TEXT    NOT NULL,
  schedule_json    TEXT    NOT NULL,
  payload_json     TEXT    NOT NULL,
  enabled          INTEGER NOT NULL DEFAULT 1,
  delete_after_run INTEGER NOT NULL DEFAULT 0,
  next_run_at_ms   INTEGER NOT NULL DEFAULT 0,
  last_run_at_ms   INTEGER NOT NULL DEFAULT 0,
  last_status      TEXT    NOT NULL DEFAULT 'pending',
  last_error       TEXT    NOT NULL DEFAULT '',
  run_count        INTEGER NOT NULL DEFAULT 0,
  created_at_ms    INTEGER NOT NULL,
  updated_at_ms    INTEGER NOT NULL,
  -- Who asked for this, when it was not a person. Empty is the operator, which
  -- is the common case, so these default rather than being nullable: a job the
  -- panel made and a job whose agent has been forgotten are the same row shape.
  created_by_agent   TEXT NOT NULL DEFAULT '',
  created_by_session TEXT NOT NULL DEFAULT ''
) STRICT;

-- The only index the timer needs, and partial on purpose: \`next_run_at_ms = 0\`
-- means unscheduled, which in a mature table is the majority of rows — every
-- fired one-shot and every disabled job.
CREATE INDEX IF NOT EXISTS automation_jobs_due
  ON automation_jobs(next_run_at_ms ASC, id ASC)
  WHERE enabled = 1 AND next_run_at_ms > 0;

-- A real foreign key, which \`sessions\`/\`workspaces\` could not express: those
-- are created by two different stores in an order nothing guarantees, and these
-- two are created together, here. \`PRAGMA foreign_keys\` is already ON for this
-- connection -- \`SessionStore\` sets it and \`messages\` relies on it.
CREATE TABLE IF NOT EXISTS automation_runs (
  id             TEXT    PRIMARY KEY,
  job_id         TEXT    NOT NULL REFERENCES automation_jobs(id) ON DELETE CASCADE,
  started_at_ms  INTEGER NOT NULL,
  finished_at_ms INTEGER,
  status         TEXT    NOT NULL,
  skip_reason    TEXT,
  error          TEXT,
  output         TEXT,
  warnings_json  TEXT    NOT NULL DEFAULT '[]',
  session_key    TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS automation_runs_job
  ON automation_runs(job_id, started_at_ms DESC, id ASC);
`;

interface AutomationStoreOptions {
  /** Shared with `SessionStore`, `AuthStore` and `NotificationStore`: one WAL. */
  readonly database: DatabaseSync;
  readonly clock?: Clock;
  readonly newId?: () => string;
  readonly logger?: Logger;
}

/** What the scheduler knows at creation time that the REST body does not. */
export interface CreateJobInput {
  readonly name: string;
  readonly schedule: AutomationSchedule;
  readonly payload: AutomationPayload;
  readonly enabled: boolean;
  readonly deleteAfterRun: boolean;
  /** 0 when the job is disabled or its schedule has no next occurrence. */
  readonly nextRunAtMs: number;
  /** Absent means the operator made it through the panel. */
  readonly createdBy?: {
    readonly agentId: string;
    readonly sessionKey: string;
  };
}

/**
 * Optionals are written `?: T | undefined` rather than a bare `?:`.
 *
 * Against `exactOptionalPropertyTypes`, and deliberately: the REST layer spreads
 * `UpdateAutomationJob` straight in, and a Zod `.optional()` produces exactly
 * that shape. A bare `?:` would force the route to destructure and rebuild,
 * which is how a field added later gets silently dropped.
 */
interface UpdateJobInput {
  readonly name?: string | undefined;
  readonly schedule?: AutomationSchedule | undefined;
  readonly payload?: AutomationPayload | undefined;
  readonly enabled?: boolean | undefined;
  readonly deleteAfterRun?: boolean | undefined;
  readonly nextRunAtMs?: number | undefined;
}

interface ListRunsOptions {
  readonly limit?: number;
  /**
   * For a numbered pager, where `after` is for a sequential reader.
   *
   * The two are alternatives and never combined: `after` addresses a position in
   * the sort order, `offset` counts rows from the top, and applying both asks
   * for a page relative to a page. `automation.runs` refuses the combination
   * with a 400 rather than letting one silently win.
   */
  readonly offset?: number;
  readonly after?: AutomationRunCursor;
}

interface StartRunInput {
  readonly jobId: string;
  readonly sessionKey?: string;
}

interface FinishRunInput {
  readonly status: RunStatus;
  readonly output?: string;
  readonly error?: string;
  readonly skipReason?: string;
  readonly warnings?: readonly string[];
}

/** What a trimmed run took with it, so its session can be cleaned up too. */
interface TrimmedRun {
  readonly id: string;
  readonly sessionKey: string | undefined;
}

const read = rowReader('automation');

/**
 * A status written by an older build becomes `pending` rather than failing the
 * read — the same trade `readLevel` makes next door, for the same reason.
 */
function readStatus(row: Row, column: string): RunStatus {
  const parsed = RunStatusSchema.safeParse(read.string(row, column));
  return parsed.success ? parsed.data : 'pending';
}

function readWarnings(row: Row): string[] {
  const raw = read.optionalString(row, 'warnings_json');
  if (raw === undefined) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((v): v is string => typeof v === 'string')
      : [];
  } catch {
    return [];
  }
}

function rowToRun(row: Row): AutomationRun {
  const finishedAtMs = read.optionalInt(row, 'finished_at_ms');
  const skipReason = read.optionalString(row, 'skip_reason');
  const error = read.optionalString(row, 'error');
  const output = read.optionalString(row, 'output');
  const sessionKey = read.optionalString(row, 'session_key');
  return {
    id: read.string(row, 'id'),
    jobId: read.string(row, 'job_id'),
    startedAtMs: read.int(row, 'started_at_ms'),
    status: readStatus(row, 'status'),
    warnings: readWarnings(row),
    ...(finishedAtMs === undefined ? {} : { finishedAtMs }),
    ...(skipReason === undefined ? {} : { skipReason }),
    ...(error === undefined ? {} : { error }),
    ...(output === undefined ? {} : { output }),
    ...(sessionKey === undefined ? {} : { sessionKey }),
  };
}

/** The parse failure a bad row produces, or `null` when it is fine. */
function jobParseError(row: Row): string | null {
  const schedule = AutomationScheduleSchema.safeParse(
    safeJson(read.string(row, 'schedule_json')),
  );
  if (!schedule.success) {
    return `schedule: ${schedule.error.issues[0]?.message ?? 'unparseable'}`;
  }
  const payload = AutomationPayloadSchema.safeParse(
    safeJson(read.string(row, 'payload_json')),
  );
  if (!payload.success) {
    return `payload: ${payload.error.issues[0]?.message ?? 'unparseable'}`;
  }
  return null;
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/** The attribution, or nothing at all when the operator made it. */
function createdByOf(row: Row): Pick<AutomationJob, 'createdBy'> {
  const agentId = read.optionalString(row, 'created_by_agent') ?? '';
  const sessionKey = read.optionalString(row, 'created_by_session') ?? '';
  return agentId === '' ? {} : { createdBy: { agentId, sessionKey } };
}

function rowToJob(row: Row): AutomationJob {
  return {
    id: read.string(row, 'id'),
    name: read.string(row, 'name'),
    schedule: AutomationScheduleSchema.parse(
      safeJson(read.string(row, 'schedule_json')),
    ),
    payload: AutomationPayloadSchema.parse(
      safeJson(read.string(row, 'payload_json')),
    ),
    enabled: read.int(row, 'enabled') === 1,
    deleteAfterRun: read.int(row, 'delete_after_run') === 1,
    ...createdByOf(row),
    createdAtMs: read.int(row, 'created_at_ms'),
    updatedAtMs: read.int(row, 'updated_at_ms'),
    state: {
      nextRunAtMs: read.int(row, 'next_run_at_ms'),
      lastRunAtMs: read.int(row, 'last_run_at_ms'),
      lastStatus: readStatus(row, 'last_status'),
      lastError: read.string(row, 'last_error'),
      runCount: read.int(row, 'run_count'),
    },
  };
}

export class AutomationStore {
  private readonly db: DatabaseSync;
  private readonly clock: Clock;
  private readonly newId: () => string;
  private readonly logger: Logger;
  private readonly statements = new Map<string, StatementSync>();

  constructor(options: AutomationStoreOptions) {
    this.db = options.database;
    this.clock = options.clock ?? systemClock;
    this.newId = options.newId ?? newUuid;
    this.logger = options.logger ?? silentLogger;
    // Connection-level and idempotent. `SessionStore` already sets it on the
    // shared connection, but this store's cascade is the only thing standing
    // between deleting a job and orphaning its entire run history — so it does
    // not inherit that guarantee from a construction order nothing enforces.
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec(SCHEMA);
    this.addMissingColumns();
    this.dropLegacyScheduleTz();
  }

  /**
   * Strips the per-job `tz` an older build wrote into `schedule_json`.
   *
   * Not cosmetic, and not deferrable. `CronScheduleSchema` is a `strictObject`,
   * so a row still carrying `tz` does not parse with the key ignored — it fails
   * outright, and `listJobs` throws for *every* job because one of them is old.
   * The panel would show an empty automation page on an install that has jobs.
   *
   * Rewriting rather than tolerating on read, because a blob nobody rewrites is
   * a blob that keeps the stale field until someone edits that job by hand — and
   * the next reader of the row has to know a rule that is written down nowhere
   * in it.
   *
   * The log line is the point of the `zones` set. A job written `0 9 * * *` in
   * `Europe/Kyiv` now fires at 09:00 in the install's zone, which is a different
   * instant; an operator who is told which zones were dropped can go and check
   * the jobs that moved. Silence here would be the same change made invisibly.
   */
  private dropLegacyScheduleTz(): void {
    const rows = this.db
      .prepare(
        `SELECT id, schedule_json FROM automation_jobs WHERE schedule_json LIKE '%"tz"%'`,
      )
      .all();
    if (rows.length === 0) return;

    const update = this.stmt(
      'UPDATE automation_jobs SET schedule_json = ? WHERE id = ?',
    );
    const zones = new Set<string>();
    let changed = 0;

    for (const row of rows) {
      const id = read.string(row, 'id');
      const raw = read.string(row, 'schedule_json');
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        // Unreadable JSON is a different defect and not one this pass invented.
        // Leaving it is what lets the schema report it against the job it is on.
        continue;
      }
      if (typeof parsed !== 'object' || parsed === null || !('tz' in parsed)) {
        continue;
      }

      const { tz, ...rest } = parsed as Record<string, unknown>;
      if (typeof tz === 'string' && tz !== '') zones.add(tz);
      update.run(JSON.stringify(rest), id);
      changed += 1;
    }

    if (changed > 0) {
      this.logger.warn(
        { jobs: changed, zones: [...zones].sort((a, b) => a.localeCompare(b)) },
        'dropped per-job automation timezones; these jobs now use the install timezone (ui.timezone) and may fire at a different instant',
      );
    }
  }

  /**
   * Adds columns to a table an older build already created.
   *
   * `CREATE TABLE IF NOT EXISTS` does nothing to a table that exists, so a
   * column added after the fact is invisible to anyone whose database predates
   * it — and every read here would then throw `storage`.
   *
   * Deliberately not a migration framework. This repo has never needed one:
   * every other table has been created whole, and `session-store.ts` says the
   * ledger it mentions is only for altering tables that already exist. This is
   * that case, once, for two columns, and a versioned ledger for it would be a
   * mechanism with a single caller.
   */
  private addMissingColumns(): void {
    const present = new Set(
      this.db
        .prepare('PRAGMA table_info(automation_jobs)')
        .all()
        .map((row) => read.optionalString(row, 'name') ?? ''),
    );

    for (const [column, ddl] of [
      [
        'created_by_agent',
        "ALTER TABLE automation_jobs ADD COLUMN created_by_agent TEXT NOT NULL DEFAULT ''",
      ],
      [
        'created_by_session',
        "ALTER TABLE automation_jobs ADD COLUMN created_by_session TEXT NOT NULL DEFAULT ''",
      ],
    ] as const) {
      if (!present.has(column)) this.db.exec(ddl);
    }
  }

  private stmt(sql: string): StatementSync {
    const cached = this.statements.get(sql);
    if (cached !== undefined) return cached;
    const prepared = this.db.prepare(sql);
    this.statements.set(sql, prepared);
    return prepared;
  }

  /** Parses a row, or logs and returns undefined. Never throws on bad JSON. */
  private tolerate(row: Row): AutomationJob | undefined {
    const problem = jobParseError(row);
    if (problem === null) return rowToJob(row);
    this.logger.warn(
      { jobId: read.optionalString(row, 'id'), problem },
      'Skipping an automation job whose stored shape does not parse',
    );
    return undefined;
  }

  // -------------------------------------------------------------------------
  // Jobs
  // -------------------------------------------------------------------------

  createJob(input: CreateJobInput): AutomationJob {
    const now = this.clock.now();
    const id = this.newId();
    this.stmt(
      `INSERT INTO automation_jobs
         (id, name, schedule_json, payload_json, enabled, delete_after_run,
          next_run_at_ms, last_run_at_ms, last_status, last_error, run_count,
          created_at_ms, updated_at_ms, created_by_agent, created_by_session)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'pending', '', 0, ?, ?, ?, ?)`,
    ).run(
      id,
      input.name,
      JSON.stringify(input.schedule),
      JSON.stringify(input.payload),
      input.enabled ? 1 : 0,
      input.deleteAfterRun ? 1 : 0,
      input.nextRunAtMs,
      now,
      now,
      input.createdBy?.agentId ?? '',
      input.createdBy?.sessionKey ?? '',
    );

    const created = this.getJob(id);
    if (created === undefined) {
      throw new GhostError(
        'storage',
        'Automation job vanished immediately after insert',
        {
          details: { id },
        },
      );
    }
    return created;
  }

  getJob(id: string): AutomationJob | undefined {
    const row = this.stmt('SELECT * FROM automation_jobs WHERE id = ?').get(id);
    return row === undefined ? undefined : this.tolerate(row);
  }

  /**
   * Every job, newest first.
   *
   * Unpaged, which is what `AutomationJobListResponseSchema` describes: the
   * panel edits a handful of jobs and a cursor the protocol does not mention
   * would be a second contract. The day one is needed, the response schema is
   * where it goes.
   */
  listJobs(): AutomationJob[] {
    const rows = this.stmt(
      'SELECT * FROM automation_jobs ORDER BY created_at_ms DESC, id ASC',
    ).all();
    return rows
      .map((row) => this.tolerate(row))
      .filter((job): job is AutomationJob => job !== undefined);
  }

  updateJob(id: string, patch: UpdateJobInput): AutomationJob | undefined {
    const existing = this.stmt(
      'SELECT * FROM automation_jobs WHERE id = ?',
    ).get(id);
    if (existing === undefined) return undefined;

    this.stmt(
      `UPDATE automation_jobs
          SET name           = COALESCE(?, name),
              schedule_json  = COALESCE(?, schedule_json),
              payload_json   = COALESCE(?, payload_json),
              enabled        = COALESCE(?, enabled),
              delete_after_run = COALESCE(?, delete_after_run),
              next_run_at_ms = COALESCE(?, next_run_at_ms),
              updated_at_ms  = ?
        WHERE id = ?`,
    ).run(
      patch.name ?? null,
      patch.schedule === undefined ? null : JSON.stringify(patch.schedule),
      patch.payload === undefined ? null : JSON.stringify(patch.payload),
      patch.enabled === undefined ? null : patch.enabled ? 1 : 0,
      patch.deleteAfterRun === undefined ? null : patch.deleteAfterRun ? 1 : 0,
      patch.nextRunAtMs ?? null,
      this.clock.now(),
      id,
    );

    return this.getJob(id);
  }

  deleteJob(id: string): boolean {
    return (
      Number(
        this.stmt('DELETE FROM automation_jobs WHERE id = ?').run(id).changes,
      ) > 0
    );
  }

  /**
   * How many jobs one agent has made.
   *
   * A count rather than `listJobsBy(...).length`, because the only caller is a
   * cap check on a path a model drives — and a model in a loop would otherwise
   * parse and discard every job in the table on every attempt.
   */
  countJobsBy(agentId: string): number {
    const row = this.stmt(
      'SELECT COUNT(*) AS n FROM automation_jobs WHERE created_by_agent = ?',
    ).get(agentId);
    return row === undefined ? 0 : read.int(row, 'n');
  }

  // -------------------------------------------------------------------------
  // Scheduling
  // -------------------------------------------------------------------------

  /** When the timer should next wake, or undefined when nothing is scheduled. */
  earliestDueMs(): number | undefined {
    const row = this.stmt(
      `SELECT MIN(next_run_at_ms) AS at FROM automation_jobs
        WHERE enabled = 1 AND next_run_at_ms > 0`,
    ).get();
    if (row === undefined) return undefined;
    return read.optionalInt(row, 'at');
  }

  /**
   * Jobs due at or before `nowMs`, soonest first.
   *
   * A row that does not parse is switched off here rather than passed over —
   * see the header. It is the one read path where tolerating a bad row would
   * produce something worse than an error: a job that exists, shows in the
   * panel, and silently never runs.
   */
  dueJobs(nowMs: number, limit: number): AutomationJob[] {
    if (limit <= 0) return [];
    const rows = this.stmt(
      `SELECT * FROM automation_jobs
        WHERE enabled = 1 AND next_run_at_ms > 0 AND next_run_at_ms <= ?
        ORDER BY next_run_at_ms ASC, id ASC
        LIMIT ?`,
    ).all(nowMs, limit);

    const due: AutomationJob[] = [];
    for (const row of rows) {
      const problem = jobParseError(row);
      if (problem === null) {
        due.push(rowToJob(row));
        continue;
      }
      const id = read.string(row, 'id');
      this.logger.error(
        { jobId: id, problem },
        'Disabling an automation job that does not parse',
      );
      this.stmt(
        `UPDATE automation_jobs
            SET enabled = 0, next_run_at_ms = 0, last_status = 'error',
                last_error = ?, updated_at_ms = ?
          WHERE id = ?`,
      ).run(
        `This job's stored shape does not parse (${problem}).`,
        this.clock.now(),
        id,
      );
    }
    return due;
  }

  /** Every enabled job whose time passed while the process was down. */
  missedJobs(nowMs: number): AutomationJob[] {
    return this.dueJobs(nowMs, Number.MAX_SAFE_INTEGER);
  }

  setNextRun(id: string, nextRunAtMs: number): void {
    this.stmt(
      'UPDATE automation_jobs SET next_run_at_ms = ?, updated_at_ms = ? WHERE id = ?',
    ).run(nextRunAtMs, this.clock.now(), id);
  }

  /** Folds one finished run into the job's `state`. */
  recordOutcome(
    id: string,
    outcome: {
      readonly ranAtMs: number;
      readonly status: RunStatus;
      readonly error?: string;
    },
  ): void {
    this.stmt(
      `UPDATE automation_jobs
          SET last_run_at_ms = ?, last_status = ?, last_error = ?,
              run_count = run_count + 1, updated_at_ms = ?
        WHERE id = ?`,
    ).run(
      outcome.ranAtMs,
      outcome.status,
      outcome.error ?? '',
      this.clock.now(),
      id,
    );
  }

  // -------------------------------------------------------------------------
  // Runs
  // -------------------------------------------------------------------------

  startRun(input: StartRunInput): AutomationRun {
    const run: AutomationRun = {
      id: this.newId(),
      jobId: input.jobId,
      startedAtMs: this.clock.now(),
      status: 'pending',
      warnings: [],
      ...(input.sessionKey === undefined
        ? {}
        : { sessionKey: input.sessionKey }),
    };

    this.stmt(
      `INSERT INTO automation_runs
         (id, job_id, started_at_ms, finished_at_ms, status, skip_reason, error, output, warnings_json, session_key)
       VALUES (?, ?, ?, NULL, 'pending', NULL, NULL, NULL, '[]', ?)`,
    ).run(run.id, run.jobId, run.startedAtMs, run.sessionKey ?? null);

    return run;
  }

  finishRun(runId: string, input: FinishRunInput): AutomationRun | undefined {
    this.stmt(
      `UPDATE automation_runs
          SET finished_at_ms = ?, status = ?, skip_reason = ?, error = ?,
              output = ?, warnings_json = ?
        WHERE id = ?`,
    ).run(
      this.clock.now(),
      input.status,
      input.skipReason ?? null,
      input.error ?? null,
      input.output ?? null,
      JSON.stringify(input.warnings ?? []),
      runId,
    );
    return this.getRun(runId);
  }

  getRun(id: string): AutomationRun | undefined {
    const row = this.stmt('SELECT * FROM automation_runs WHERE id = ?').get(id);
    return row === undefined ? undefined : rowToRun(row);
  }

  /**
   * A page of one job's runs, newest first.
   *
   * The predicate is the sort order written as a comparison, the same shape
   * `NotificationStore.list` uses. Two runs starting in one millisecond is the
   * normal case when the boot sweep dispatches a backlog.
   */
  listRuns(jobId: string, options: ListRunsOptions = {}): AutomationRun[] {
    const { limit = 50, offset = 0, after } = options;
    const rows = this.stmt(
      `SELECT * FROM automation_runs
        WHERE job_id = ?
          AND (? IS NULL
               OR started_at_ms < ?
               OR (started_at_ms = ? AND id > ?))
        ORDER BY started_at_ms DESC, id ASC
        LIMIT ? OFFSET ?`,
    ).all(
      jobId,
      after?.startedAtMs ?? null,
      after?.startedAtMs ?? null,
      after?.startedAtMs ?? null,
      after?.id ?? null,
      limit,
      offset,
    );
    return rows.map(rowToRun);
  }

  /**
   * How many runs one job has kept.
   *
   * What a numbered pager needs and a cursor does not — "Page 3 of 12" cannot be
   * derived from a page of rows. `SessionStore` builds its filter through a
   * shared helper so its count and its page cannot disagree; there is nothing to
   * share here, because a run listing filters on `job_id` and nothing else.
   *
   * The total is bounded rather than open-ended: `trimRuns` holds each job to
   * its retention knob, so this counts a capped table however long the job has
   * been running.
   */
  countRuns(jobId: string): number {
    const row = this.stmt(
      'SELECT COUNT(*) AS n FROM automation_runs WHERE job_id = ?',
    ).get(jobId);
    return row === undefined ? 0 : read.int(row, 'n');
  }

  /**
   * Drops everything past the newest `keep` runs of one job.
   *
   * Returns what went, because a trimmed run's session is now unreachable — the
   * run row was the only thing naming it — and the caller deletes it so the
   * sessions table stays bounded by the same knob.
   */
  trimRuns(jobId: string, keep: number): TrimmedRun[] {
    const doomed = this.stmt(
      `SELECT id, session_key FROM automation_runs
        WHERE job_id = ?
          AND id NOT IN (SELECT id FROM automation_runs
                          WHERE job_id = ?
                          ORDER BY started_at_ms DESC, id ASC
                          LIMIT ?)`,
    ).all(jobId, jobId, keep);

    if (doomed.length === 0) return [];

    const trimmed = doomed.map((row) => ({
      id: read.string(row, 'id'),
      sessionKey: read.optionalString(row, 'session_key'),
    }));

    const remove = this.stmt('DELETE FROM automation_runs WHERE id = ?');
    for (const run of trimmed) remove.run(run.id);
    return trimmed;
  }

  /**
   * Closes out runs left `pending` by a process that died mid-turn.
   *
   * Called once at boot. Without it a hard kill leaves a row that the panel
   * renders as still running, forever — and the run it describes has no
   * process behind it.
   */
  reconcilePending(message: string): number {
    return Number(
      this.stmt(
        `UPDATE automation_runs
            SET status = 'error', error = ?, finished_at_ms = ?
          WHERE status = 'pending'`,
      ).run(message, this.clock.now()).changes,
    );
  }
}
