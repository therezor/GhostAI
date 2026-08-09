import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import type {
  AutomationPayload,
  AutomationSchedule,
} from '@ghostwire/protocol';

import { AutomationStore, type CreateJobInput } from '#src/automation-store.js';
import { encodeAutomationRunCursor } from '#src/cursor.js';
import { manualClock, type ManualClock } from '#testkit/clock.js';

const opened: DatabaseSync[] = [];

afterEach(() => {
  while (opened.length > 0) opened.pop()?.close();
});

function store(clock: ManualClock = manualClock()): AutomationStore {
  const database = new DatabaseSync(':memory:');
  opened.push(database);
  let counter = 0;
  return new AutomationStore({
    database,
    clock,
    newId: () => `x${String(++counter).padStart(3, '0')}`,
  });
}

const CRON: AutomationSchedule = { kind: 'cron', expr: '0 9 * * *' };
const MESSAGE: AutomationPayload = {
  kind: 'scheduled',
  message: 'check the build',
  deliver: false,
  targets: {},
};

function job(over: Partial<CreateJobInput> = {}): CreateJobInput {
  return {
    name: 'Morning',
    schedule: CRON,
    payload: MESSAGE,
    enabled: true,
    deleteAfterRun: false,
    nextRunAtMs: 1_700_000_100_000,
    ...over,
  };
}

describe('AutomationStore jobs', () => {
  it('round-trips a job through the JSON columns', () => {
    const jobs = store();
    const created = jobs.createJob(job());

    expect(created).toMatchObject({
      name: 'Morning',
      schedule: CRON,
      payload: MESSAGE,
      enabled: true,
      deleteAfterRun: false,
      state: {
        nextRunAtMs: 1_700_000_100_000,
        runCount: 0,
        lastStatus: 'pending',
      },
    });
    expect(jobs.getJob(created.id)).toEqual(created);
  });

  it('keeps each schedule kind distinguishable after a round trip', () => {
    // The reason these are JSON columns rather than a flat set of nullable
    // ones: `{kind: 'cron', atMs: 5}` must stay unrepresentable.
    const jobs = store();
    const at = jobs.createJob(job({ schedule: { kind: 'at', atMs: 42 } }));
    const every = jobs.createJob(
      job({ schedule: { kind: 'every', everyMs: 60_000 } }),
    );

    expect(jobs.getJob(at.id)?.schedule).toEqual({ kind: 'at', atMs: 42 });
    expect(jobs.getJob(every.id)?.schedule).toEqual({
      kind: 'every',
      everyMs: 60_000,
    });
  });

  it('patches only the fields named', () => {
    const jobs = store();
    const created = jobs.createJob(job());
    const updated = jobs.updateJob(created.id, { name: 'Renamed' });

    expect(updated?.name).toBe('Renamed');
    expect(updated?.schedule).toEqual(CRON);
    expect(updated?.enabled).toBe(true);
  });

  it('can disable a job without losing its schedule', () => {
    const jobs = store();
    const created = jobs.createJob(job());
    const updated = jobs.updateJob(created.id, {
      enabled: false,
      nextRunAtMs: 0,
    });

    expect(updated?.enabled).toBe(false);
    expect(updated?.state.nextRunAtMs).toBe(0);
    expect(updated?.schedule).toEqual(CRON);
  });

  it('answers undefined rather than throwing for a job that is not there', () => {
    const jobs = store();
    expect(jobs.getJob('nope')).toBeUndefined();
    expect(jobs.updateJob('nope', { name: 'x' })).toBeUndefined();
    expect(jobs.deleteJob('nope')).toBe(false);
  });
});

describe('AutomationStore scheduling', () => {
  it('reports the earliest scheduled instant', () => {
    const jobs = store();
    jobs.createJob(job({ nextRunAtMs: 5000 }));
    jobs.createJob(job({ nextRunAtMs: 2000 }));

    expect(jobs.earliestDueMs()).toBe(2000);
  });

  it('ignores disabled and unscheduled jobs when picking the next wake', () => {
    const jobs = store();
    jobs.createJob(job({ nextRunAtMs: 2000, enabled: false }));
    jobs.createJob(job({ nextRunAtMs: 0 }));
    jobs.createJob(job({ nextRunAtMs: 9000 }));

    expect(jobs.earliestDueMs()).toBe(9000);
  });

  it('has no next wake at all when nothing is scheduled', () => {
    const jobs = store();
    jobs.createJob(job({ nextRunAtMs: 0 }));
    expect(jobs.earliestDueMs()).toBeUndefined();
  });

  it('returns due jobs soonest first, bounded by the limit', () => {
    const jobs = store();
    jobs.createJob(job({ name: 'third', nextRunAtMs: 3000 }));
    jobs.createJob(job({ name: 'first', nextRunAtMs: 1000 }));
    jobs.createJob(job({ name: 'second', nextRunAtMs: 2000 }));

    expect(jobs.dueJobs(5000, 2).map((j) => j.name)).toEqual([
      'first',
      'second',
    ]);
  });

  it('does not return a job whose time has not come', () => {
    const jobs = store();
    jobs.createJob(job({ nextRunAtMs: 5000 }));
    expect(jobs.dueJobs(4999, 10)).toEqual([]);
    expect(jobs.dueJobs(5000, 10)).toHaveLength(1);
  });

  it('folds an outcome into the job state', () => {
    const clock = manualClock();
    const jobs = store(clock);
    const created = jobs.createJob(job());

    jobs.recordOutcome(created.id, { ranAtMs: 1234, status: 'ok' });
    jobs.recordOutcome(created.id, {
      ranAtMs: 5678,
      status: 'error',
      error: 'boom',
    });

    expect(jobs.getJob(created.id)?.state).toMatchObject({
      lastRunAtMs: 5678,
      lastStatus: 'error',
      lastError: 'boom',
      runCount: 2,
    });
  });
});

describe('AutomationStore and a row it cannot read', () => {
  /** Writes a job row straight past the store, the way an import or a hand edit would. */
  function corrupt(
    database: DatabaseSync,
    id: string,
    scheduleJson: string,
  ): void {
    database
      .prepare(
        `INSERT INTO automation_jobs
           (id, name, schedule_json, payload_json, enabled, delete_after_run,
            next_run_at_ms, last_run_at_ms, last_status, last_error, run_count,
            created_at_ms, updated_at_ms)
         VALUES (?, 'Broken', ?, ?, 1, 0, 1000, 0, 'pending', '', 0, 1, 1)`,
      )
      .run(id, scheduleJson, JSON.stringify(MESSAGE));
  }

  function withRawAccess(): { jobs: AutomationStore; database: DatabaseSync } {
    const database = new DatabaseSync(':memory:');
    opened.push(database);
    let counter = 0;
    const jobs = new AutomationStore({
      database,
      clock: manualClock(),
      newId: () => `x${String(++counter).padStart(3, '0')}`,
    });
    return { jobs, database };
  }

  it('leaves a bad row out of the listing instead of blanking the panel', () => {
    const { jobs, database } = withRawAccess();
    const good = jobs.createJob(job());
    corrupt(database, 'bad', JSON.stringify({ kind: 'cron', atMs: 5 }));

    expect(jobs.listJobs().map((j) => j.id)).toEqual([good.id]);
    expect(jobs.getJob('bad')).toBeUndefined();
  });

  it('disables a bad row rather than passing over it when the timer asks', () => {
    // Skipping it silently would produce a job that shows in the UI and never
    // fires. Switching it off makes it visible and inert.
    const { jobs, database } = withRawAccess();
    corrupt(database, 'bad', JSON.stringify({ kind: 'cron', atMs: 5 }));

    expect(jobs.dueJobs(2000, 10)).toEqual([]);

    const row = database
      .prepare('SELECT * FROM automation_jobs WHERE id = ?')
      .get('bad');
    expect(row?.enabled).toBe(0);
    expect(row?.next_run_at_ms).toBe(0);
    expect(row?.last_status).toBe('error');
    expect(String(row?.last_error)).toMatch(/does not parse/u);
  });

  it('treats unparseable JSON the same as a shape that does not fit', () => {
    const { jobs, database } = withRawAccess();
    corrupt(database, 'bad', 'not json at all');
    expect(jobs.listJobs()).toEqual([]);
    expect(jobs.dueJobs(2000, 10)).toEqual([]);
  });

  /**
   * The per-job `tz` an older build wrote, stripped when the store opens.
   *
   * These use a **second** store over the same database, because the migration
   * runs in the constructor: the legacy row has to exist before the store that
   * is supposed to fix it is built.
   */
  describe('a job written by a build that had per-job timezones', () => {
    function reopen(database: DatabaseSync): AutomationStore {
      let counter = 0;
      return new AutomationStore({
        database,
        clock: manualClock(),
        newId: () => `y${String(++counter).padStart(3, '0')}`,
      });
    }

    it('loads rather than taking the whole listing down with it', () => {
      // `CronScheduleSchema` is strict, so without the migration this row does
      // not parse — and `listJobs` would drop every job on an install that has
      // one, which reads as "the automation page is empty".
      const { database } = withRawAccess();
      corrupt(
        database,
        'legacy',
        JSON.stringify({ kind: 'cron', expr: '0 9 * * *', tz: 'UTC' }),
      );

      const jobs = reopen(database);
      expect(jobs.listJobs().map((j) => j.id)).toEqual(['legacy']);
      expect(jobs.getJob('legacy')?.schedule).toEqual({
        kind: 'cron',
        expr: '0 9 * * *',
      });
    });

    it('rewrites the stored blob rather than tolerating it on every read', () => {
      // A field nobody rewrites survives until someone edits that job by hand,
      // and the next reader has to know a rule written down nowhere in the row.
      const { database } = withRawAccess();
      corrupt(
        database,
        'legacy',
        JSON.stringify({ kind: 'cron', expr: '0 9 * * *', tz: 'Europe/Kyiv' }),
      );

      reopen(database);
      const row = database
        .prepare('SELECT schedule_json FROM automation_jobs WHERE id = ?')
        .get('legacy');
      expect(String(row?.schedule_json)).not.toContain('tz');
      expect(JSON.parse(String(row?.schedule_json))).toEqual({
        kind: 'cron',
        expr: '0 9 * * *',
      });
    });

    it('leaves a row whose JSON never parsed for the schema to report', () => {
      // Not this pass's defect to invent a fix for. Rewriting it would destroy
      // the evidence of whatever actually wrote it.
      const { database } = withRawAccess();
      corrupt(database, 'bad', '{"tz": not json');

      const jobs = reopen(database);
      expect(jobs.listJobs()).toEqual([]);
    });

    it('does nothing at all to a database that has no such row', () => {
      const { jobs: first, database } = withRawAccess();
      const created = first.createJob(job());

      const jobs = reopen(database);
      expect(jobs.getJob(created.id)?.schedule).toEqual(CRON);
    });
  });
});

describe('AutomationStore runs', () => {
  it('starts a run pending and finishes it with an outcome', () => {
    const clock = manualClock();
    const jobs = store(clock);
    const created = jobs.createJob(job());

    const run = jobs.startRun({
      jobId: created.id,
      sessionKey: 'automation:1',
    });
    expect(run).toMatchObject({
      status: 'pending',
      sessionKey: 'automation:1',
      warnings: [],
    });
    expect(run.finishedAtMs).toBeUndefined();

    clock.advance(5000);
    const done = jobs.finishRun(run.id, {
      status: 'ok',
      output: 'all green',
      warnings: ['deliver: true reached no channel'],
    });

    expect(done).toMatchObject({
      status: 'ok',
      output: 'all green',
      warnings: ['deliver: true reached no channel'],
      finishedAtMs: run.startedAtMs + 5000,
    });
    expect(done).not.toHaveProperty('error');
  });

  it('records a skip with its reason and no error', () => {
    const jobs = store();
    const created = jobs.createJob(job());
    const run = jobs.startRun({ jobId: created.id });

    const done = jobs.finishRun(run.id, {
      status: 'skipped',
      skipReason: 'No TASK.md',
    });
    expect(done).toMatchObject({ status: 'skipped', skipReason: 'No TASK.md' });
    expect(done).not.toHaveProperty('error');
  });

  it('pages runs newest first over a keyset cursor', () => {
    const clock = manualClock();
    const jobs = store(clock);
    const created = jobs.createJob(job());

    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      ids.push(jobs.startRun({ jobId: created.id }).id);
      clock.advance(1000);
    }

    const first = jobs.listRuns(created.id, { limit: 2 });
    expect(first.map((r) => r.id)).toEqual([ids[4], ids[3]]);

    const last = first[first.length - 1];
    const second = jobs.listRuns(created.id, {
      limit: 2,
      after: { startedAtMs: last!.startedAtMs, id: last!.id },
    });
    expect(second.map((r) => r.id)).toEqual([ids[2], ids[1]]);
  });

  it('pages runs over an offset, for a numbered pager', () => {
    const clock = manualClock();
    const jobs = store(clock);
    const created = jobs.createJob(job());

    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      ids.push(jobs.startRun({ jobId: created.id }).id);
      clock.advance(1000);
    }

    // Newest first, so page two of two is the third and fourth newest.
    expect(
      jobs.listRuns(created.id, { limit: 2, offset: 2 }).map((r) => r.id),
    ).toEqual([ids[2], ids[1]]);
    // Past the end is empty rather than a wrapped page.
    expect(jobs.listRuns(created.id, { limit: 2, offset: 10 })).toEqual([]);
  });

  it('counts every run of a job, not the page in front of it', () => {
    const jobs = store();
    const created = jobs.createJob(job());
    const other = jobs.createJob(job({ name: 'other' }));
    for (let i = 0; i < 5; i += 1) jobs.startRun({ jobId: created.id });
    jobs.startRun({ jobId: other.id });

    expect(jobs.listRuns(created.id, { limit: 2 })).toHaveLength(2);
    expect(jobs.countRuns(created.id)).toBe(5);
    // Scoped to its own job, like the listing beside it.
    expect(jobs.countRuns(other.id)).toBe(1);
    expect(jobs.countRuns('no-such-job')).toBe(0);
  });

  it('separates one job′s runs from another′s', () => {
    const jobs = store();
    const a = jobs.createJob(job({ name: 'a' }));
    const b = jobs.createJob(job({ name: 'b' }));
    jobs.startRun({ jobId: a.id });
    jobs.startRun({ jobId: b.id });

    expect(jobs.listRuns(a.id)).toHaveLength(1);
    expect(jobs.listRuns(b.id)).toHaveLength(1);
  });

  it('encodes a cursor the decoder reads back', () => {
    const jobs = store();
    const created = jobs.createJob(job());
    const run = jobs.startRun({ jobId: created.id });
    expect(
      typeof encodeAutomationRunCursor({
        startedAtMs: run.startedAtMs,
        id: run.id,
      }),
    ).toBe('string');
  });

  it('takes a job′s runs with it when the job is deleted', () => {
    const jobs = store();
    const created = jobs.createJob(job());
    const run = jobs.startRun({ jobId: created.id });

    expect(jobs.deleteJob(created.id)).toBe(true);
    expect(jobs.getRun(run.id)).toBeUndefined();
  });
});

describe('AutomationStore retention', () => {
  it('keeps the newest runs and reports what it dropped', () => {
    const clock = manualClock();
    const jobs = store(clock);
    const created = jobs.createJob(job());

    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const run = jobs.startRun({
        jobId: created.id,
        sessionKey: `automation:${String(i)}`,
      });
      ids.push(run.id);
      clock.advance(1000);
    }

    const trimmed = jobs.trimRuns(created.id, 2);
    expect(trimmed.map((t) => t.id).sort()).toEqual(
      [ids[0], ids[1], ids[2]].sort(),
    );
    // The session keys come back so the caller can delete the sessions too —
    // the run row was the only thing naming them.
    expect(trimmed.map((t) => t.sessionKey).sort()).toEqual([
      'automation:0',
      'automation:1',
      'automation:2',
    ]);
    expect(jobs.listRuns(created.id).map((r) => r.id)).toEqual([
      ids[4],
      ids[3],
    ]);
  });

  it('trims per job, so a busy job does not evict a quiet one', () => {
    // The reason retention is not one global ceiling: a five-minute job's
    // afternoon would otherwise take a nightly job's whole year with it.
    const clock = manualClock();
    const jobs = store(clock);
    const busy = jobs.createJob(job({ name: 'busy' }));
    const quiet = jobs.createJob(job({ name: 'quiet' }));

    jobs.startRun({ jobId: quiet.id });
    clock.advance(1000);
    for (let i = 0; i < 5; i += 1) {
      jobs.startRun({ jobId: busy.id });
      clock.advance(1000);
    }

    jobs.trimRuns(busy.id, 2);
    expect(jobs.listRuns(busy.id)).toHaveLength(2);
    expect(jobs.listRuns(quiet.id)).toHaveLength(1);
  });

  it('does nothing when there is less history than the cap', () => {
    const jobs = store();
    const created = jobs.createJob(job());
    jobs.startRun({ jobId: created.id });

    expect(jobs.trimRuns(created.id, 200)).toEqual([]);
    expect(jobs.listRuns(created.id)).toHaveLength(1);
  });
});

describe('AutomationStore boot reconciliation', () => {
  it('closes out runs a dead process left pending', () => {
    const clock = manualClock();
    const jobs = store(clock);
    const created = jobs.createJob(job());
    const orphan = jobs.startRun({ jobId: created.id });
    const finished = jobs.startRun({ jobId: created.id });
    jobs.finishRun(finished.id, { status: 'ok' });

    clock.advance(60_000);
    expect(jobs.reconcilePending('Interrupted by a restart')).toBe(1);

    expect(jobs.getRun(orphan.id)).toMatchObject({
      status: 'error',
      error: 'Interrupted by a restart',
      finishedAtMs: orphan.startedAtMs + 60_000,
    });
    // The one that already finished is left exactly as it was.
    expect(jobs.getRun(finished.id)?.status).toBe('ok');
  });

  it('is a no-op on a clean boot', () => {
    const jobs = store();
    expect(jobs.reconcilePending('Interrupted by a restart')).toBe(0);
  });
});
