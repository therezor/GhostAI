/**
 * The engine, driven by hand.
 *
 * Everything here runs against a manual clock and a scripted hub connection —
 * no Fastify, no runtime, no provider. That is what the structural ports in
 * `SchedulerOptions` are for, and it is the only way the six `catchUpOnBoot`
 * combinations and the timer clamp are testable at all.
 */

import { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ConfigSchema,
  type Config,
  type ConfigPatch,
  type ServerMessage,
} from '@ghostbot/protocol';
import type { ChatResult } from '@ghostbot/providers';

import { AutomationStore, type CreateJobInput } from '#src/automation-store.js';
import { HEARTBEAT_RESULT_TOOL, HEARTBEAT_TOOL } from '#src/heartbeat.js';
import type { CreateNotificationInput } from '#src/notifications.js';
import {
  MAX_ARM_MS,
  Scheduler,
  firstRunAt,
  nextRunAfter,
  type NotificationBroadcast,
  type SchedulerConnectOptions,
  type SchedulerOptions,
} from '#src/scheduler.js';

const START = 1_700_000_000_000;

const opened: DatabaseSync[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
});

afterEach(() => {
  vi.useRealTimers();
  while (opened.length > 0) opened.pop()?.close();
});

/**
 * A clock backed by vitest's fake timers.
 *
 * `manualClock` in `testkit` moves `now()` by hand but delegates `setTimeout`
 * to the real one, which is the wrong half here: the scheduler's whole
 * behaviour is what it does when a timer fires. Reading `Date.now()` keeps the
 * wall clock and the timer wheel advancing together under
 * `vi.advanceTimersByTimeAsync`.
 */
function fakeClock(): {
  now: () => number;
  monotonic: () => number;
  setTimeout: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeout: (h: ReturnType<typeof setTimeout>) => void;
  sleep: (ms: number) => Promise<void>;
} {
  return {
    now: () => Date.now(),
    monotonic: () => Date.now(),
    setTimeout: (cb, ms) => globalThis.setTimeout(cb, ms),
    clearTimeout: (h) => {
      globalThis.clearTimeout(h);
    },
    sleep: (ms) =>
      new Promise<void>((resolve) => globalThis.setTimeout(resolve, ms)),
  };
}

/** One scripted turn: what the hub sends back when a message arrives. */
type TurnScript = (
  options: SchedulerConnectOptions,
  message: unknown,
) => ServerMessage[];

function answers(text: string, stopReason = 'complete'): TurnScript {
  return () => [
    {
      type: 'turn.start',
      seq: 1,
      turnId: 't1',
      sessionKey: 'k',
    } as unknown as ServerMessage,
    {
      type: 'assistant.delta',
      seq: 2,
      turnId: 't1',
      text,
    } as unknown as ServerMessage,
    {
      type: 'turn.end',
      seq: 3,
      turnId: 't1',
      stopReason,
    } as unknown as ServerMessage,
  ];
}

interface Harness {
  scheduler: Scheduler;
  readonly jobs: AutomationStore;
  readonly runs: Array<{ options: SchedulerConnectOptions; message: unknown }>;
  readonly notifications: CreateNotificationInput[];
  readonly broadcasts: NotificationBroadcast[];
  readonly deletedSessions: string[];
  /** How many times the timer woke and asked the store what was due. */
  drains: number;
  config: Config;
}

interface HarnessOptions {
  readonly script?: TurnScript;
  readonly patch?: ConfigPatch;
  readonly chat?: SchedulerOptions['chat'];
  readonly readFile?: SchedulerOptions['readFile'];
  /** Held open rather than answering, so a run stays in flight. */
  readonly hang?: boolean;
}

function harness(options: HarnessOptions = {}): Harness {
  const database = new DatabaseSync(':memory:');
  opened.push(database);
  const clock = fakeClock();
  let counter = 0;
  const jobs = new AutomationStore({
    database,
    clock,
    newId: () => `x${String(++counter).padStart(3, '0')}`,
  });

  const runs: Array<{ options: SchedulerConnectOptions; message: unknown }> =
    [];
  const notifications: CreateNotificationInput[] = [];
  const broadcasts: NotificationBroadcast[] = [];
  const deletedSessions: string[] = [];
  const script = options.script ?? answers('done');

  // Returned as-is, never spread: the config getter below closes over this
  // object, so a copy would leave `h.config = …` invisible to the scheduler.
  const state: Harness = {
    jobs,
    runs,
    notifications,
    broadcasts,
    deletedSessions,
    drains: 0,
    config: ConfigSchema.parse(options.patch ?? {}),
    scheduler: undefined as unknown as Scheduler,
  };

  const dueJobs = jobs.dueJobs.bind(jobs);
  jobs.dueJobs = (nowMs, limit) => {
    state.drains += 1;
    return dueJobs(nowMs, limit);
  };

  const scheduler = new Scheduler({
    jobs,
    config: () => state.config,
    clock,
    newId: () => `s${String(++counter).padStart(3, '0')}`,
    connect: (connectOptions) => ({
      receive: (message) => {
        const frame = message as { type?: string };
        if (frame.type !== 'user.message') return;
        runs.push({ options: connectOptions, message });
        if (options.hang === true) return;
        for (const event of script(connectOptions, message)) {
          connectOptions.send(event);
        }
      },
      close: () => undefined,
    }),
    broadcast: (event) => broadcasts.push(event),
    raise: (input) => {
      notifications.push(input);
      return {
        id: `n${String(notifications.length)}`,
        title: input.title,
        body: input.body ?? '',
        level: input.level ?? 'info',
        createdAtMs: Date.now(),
        ...(input.sessionKey === undefined
          ? {}
          : { sessionKey: input.sessionKey }),
        ...(input.jobId === undefined ? {} : { jobId: input.jobId }),
      };
    },
    deleteSession: (key) => deletedSessions.push(key),
    ...(options.chat === undefined ? {} : { chat: options.chat }),
    ...(options.readFile === undefined ? {} : { readFile: options.readFile }),
  });

  state.scheduler = scheduler;
  return state;
}

function job(over: Partial<CreateJobInput> = {}): CreateJobInput {
  return {
    name: 'Job',
    schedule: { kind: 'every', everyMs: 60_000 },
    payload: { kind: 'scheduled', message: 'go', deliver: false, targets: {} },
    enabled: true,
    deleteAfterRun: false,
    nextRunAtMs: START + 60_000,
    ...over,
  };
}

/** Advances timers and lets every run's promise chain settle. */
async function tick(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await vi.advanceTimersByTimeAsync(0);
}

// ---------------------------------------------------------------------------
// Schedule arithmetic
// ---------------------------------------------------------------------------

describe('nextRunAfter', () => {
  it('keeps a future one-shot and unschedules a past one', () => {
    expect(nextRunAfter({ kind: 'at', atMs: START + 1000 }, START)).toBe(
      START + 1000,
    );
    expect(nextRunAfter({ kind: 'at', atMs: START - 1000 }, START)).toBe(0);
  });

  it('adds the interval', () => {
    expect(nextRunAfter({ kind: 'every', everyMs: 5000 }, START)).toBe(
      START + 5000,
    );
  });

  it('reads a cron expression in the zone it is given', () => {
    const at = nextRunAfter(
      { kind: 'cron', expr: '0 9 * * *' },
      Date.parse('2026-01-15T08:00:00Z'),
      'UTC',
    );
    expect(new Date(at).toISOString()).toBe('2026-01-15T09:00:00.000Z');
  });

  it('defaults to UTC rather than the host zone', () => {
    // The default is UTC, and that is the point: a server's own zone moves when
    // the server does, so the same expression would fire at a different real
    // instant after a migration nobody connected to it.
    const from = Date.parse('2026-01-15T08:00:00Z');
    expect(
      new Date(
        nextRunAfter({ kind: 'cron', expr: '0 9 * * *' }, from),
      ).toISOString(),
    ).toBe('2026-01-15T09:00:00.000Z');
    // And the install's zone is honoured: 08:00 UTC is already 17:00 in Tokyo,
    // so that day's 09:00 has gone and the answer is the next one.
    expect(
      new Date(
        nextRunAfter({ kind: 'cron', expr: '0 9 * * *' }, from, 'Asia/Tokyo'),
      ).toISOString(),
    ).toBe('2026-01-16T00:00:00.000Z');
  });

  it('is 0 for a cron expression that can never match', () => {
    // Legal to write, impossible to reach. The column's 0 means "unscheduled",
    // which is the same thing to the timer as a fired one-shot.
    expect(
      nextRunAfter({ kind: 'cron', expr: '0 0 30 2 *' }, START, 'UTC'),
    ).toBe(0);
  });
});

describe('firstRunAt', () => {
  it('is 0 for a job created disabled', () => {
    expect(firstRunAt({ kind: 'every', everyMs: 1000 }, START, false)).toBe(0);
  });

  it('keeps a one-shot whose time has already passed, leaving catch-up to decide', () => {
    // Pushing it forward here would take the decision away from
    // `catchUpOnBoot`, which is the flag that owns it.
    expect(firstRunAt({ kind: 'at', atMs: START - 5000 }, START, true)).toBe(
      START - 5000,
    );
  });
});

// ---------------------------------------------------------------------------
// The timer
// ---------------------------------------------------------------------------

describe('Scheduler timer', () => {
  it('runs a job when its time comes', async () => {
    const h = harness();
    h.jobs.createJob(job());
    h.scheduler.start();

    expect(h.runs).toHaveLength(0);
    await tick(60_000);
    expect(h.runs).toHaveLength(1);
    await h.scheduler.stop();
  });

  it('rearms from completion, so a slow run does not build a backlog', async () => {
    const h = harness();
    h.jobs.createJob(job({ schedule: { kind: 'every', everyMs: 60_000 } }));
    h.scheduler.start();

    await tick(60_000);
    expect(h.runs).toHaveLength(1);
    // Next time is computed from when the run finished, not from when it was due.
    await tick(59_000);
    expect(h.runs).toHaveLength(1);
    await tick(2000);
    expect(h.runs).toHaveLength(2);
    await h.scheduler.stop();
  });

  it('clamps a hop so a distant job does not overflow setTimeout and fire at once', async () => {
    // Past 2^31-1 ms `setTimeout` fires immediately. Unclamped, a job three
    // months out would run now, and then again, and again.
    const h = harness();
    const farFuture = START + 90 * 24 * 60 * 60 * 1000;
    h.jobs.createJob(
      job({
        schedule: { kind: 'at', atMs: farFuture },
        nextRunAtMs: farFuture,
      }),
    );
    h.scheduler.start();

    await tick(MAX_ARM_MS);
    expect(h.runs).toHaveLength(0);
    await tick(MAX_ARM_MS * 3);
    expect(h.runs).toHaveLength(0);

    await tick(90 * 24 * 60 * 60 * 1000);
    expect(h.runs).toHaveLength(1);
    await h.scheduler.stop();
  });

  it('arms no timer at all when nothing is scheduled', async () => {
    const h = harness();
    h.jobs.createJob(job({ nextRunAtMs: 0 }));
    h.scheduler.start();

    await tick(MAX_ARM_MS);
    expect(h.runs).toHaveLength(0);
    await h.scheduler.stop();
  });

  it('does not run a disabled job', async () => {
    const h = harness();
    h.jobs.createJob(job({ enabled: false, nextRunAtMs: 0 }));
    h.scheduler.start();

    await tick(120_000);
    expect(h.runs).toHaveLength(0);
    await h.scheduler.stop();
  });

  it('runs nothing at all when the scheduler is switched off in settings', async () => {
    const h = harness({ patch: { scheduler: { enabled: false } } });
    h.jobs.createJob(job());
    h.scheduler.start();

    await tick(120_000);
    expect(h.runs).toHaveLength(0);
    expect(h.scheduler.enabled).toBe(false);
    await h.scheduler.stop();
  });

  it('picks up a new job on refresh without waiting for a restart', async () => {
    const h = harness();
    h.scheduler.start();
    h.jobs.createJob(job({ nextRunAtMs: START + 1000 }));
    h.scheduler.refresh();

    await tick(1000);
    expect(h.runs).toHaveLength(1);
    await h.scheduler.stop();
  });
});

// ---------------------------------------------------------------------------
// The install timezone
// ---------------------------------------------------------------------------

describe('Scheduler and a change of timezone', () => {
  /** A cron job whose next run the scheduler will have settled against the zone. */
  function cronJob(): CreateJobInput {
    return job({
      schedule: { kind: 'cron', expr: '0 9 * * *' },
      nextRunAtMs: START + 60_000,
    });
  }

  it('reschedules an existing cron job when `ui.timezone` moves', async () => {
    // The behaviour the whole design turns on, and the one worth pinning: a
    // cron expression is a wall-clock time, so its stored instant is only valid
    // against the zone it was computed in. `settings.patch` calls `refresh()`,
    // which is where this happens — otherwise the panel's answer would only
    // become true after each job happened to fire once more.
    const h = harness();
    const created = h.jobs.createJob(cronJob());
    h.scheduler.start();
    const before = h.jobs.getJob(created.id)?.state.nextRunAtMs;

    h.config = ConfigSchema.parse({ ui: { timezone: 'Asia/Tokyo' } });
    h.scheduler.refresh();

    expect(h.jobs.getJob(created.id)?.state.nextRunAtMs).not.toBe(before);
    await h.scheduler.stop();
  });

  it('leaves an interval job alone, because it has no wall clock in it', async () => {
    // Recomputing it would push the next run a full interval into the future on
    // every unrelated save, which is a job that quietly never runs.
    const h = harness();
    const created = h.jobs.createJob(
      job({ schedule: { kind: 'every', everyMs: 60_000 } }),
    );
    h.scheduler.start();
    const before = h.jobs.getJob(created.id)?.state.nextRunAtMs;

    h.config = ConfigSchema.parse({ ui: { timezone: 'Asia/Tokyo' } });
    h.scheduler.refresh();

    expect(h.jobs.getJob(created.id)?.state.nextRunAtMs).toBe(before);
    await h.scheduler.stop();
  });

  it('does not touch a cron job when a refresh changes something else', async () => {
    // `refresh()` runs after every create, update and delete. Rescanning every
    // job on each of those is work with no answer to give.
    const h = harness();
    const created = h.jobs.createJob(cronJob());
    h.scheduler.start();
    const before = h.jobs.getJob(created.id)?.state.nextRunAtMs;

    h.config = ConfigSchema.parse({ scheduler: { concurrency: 4 } });
    h.scheduler.refresh();

    expect(h.jobs.getJob(created.id)?.state.nextRunAtMs).toBe(before);
    await h.scheduler.stop();
  });

  it('leaves a disabled cron job unscheduled rather than waking it', async () => {
    const h = harness();
    const created = h.jobs.createJob({
      ...cronJob(),
      enabled: false,
      nextRunAtMs: 0,
    });
    h.scheduler.start();

    h.config = ConfigSchema.parse({ ui: { timezone: 'Asia/Tokyo' } });
    h.scheduler.refresh();

    expect(h.jobs.getJob(created.id)?.state.nextRunAtMs).toBe(0);
    await h.scheduler.stop();
  });
});

// ---------------------------------------------------------------------------
// Concurrency
// ---------------------------------------------------------------------------

describe('Scheduler concurrency', () => {
  it('runs at most `concurrency` jobs at once', async () => {
    const h = harness({ hang: true, patch: { scheduler: { concurrency: 2 } } });
    for (let i = 0; i < 4; i += 1) {
      h.jobs.createJob(job({ name: `j${String(i)}` }));
    }
    h.scheduler.start();

    await tick(60_000);
    expect(h.runs).toHaveLength(2);
    await h.scheduler.stop();
  });

  it('never starts a second run of the same job', async () => {
    // The rule that makes "rearm from completion" coherent: a job whose run
    // outlasts its own interval is left due rather than started twice.
    const h = harness({ hang: true });
    h.jobs.createJob(
      job({
        schedule: { kind: 'every', everyMs: 1000 },
        nextRunAtMs: START + 1000,
      }),
    );
    h.scheduler.start();

    await tick(10_000);
    expect(h.runs).toHaveLength(1);
    await h.scheduler.stop();
  });

  it('does not spin the timer while every slot is taken', async () => {
    // Work stays *due* while the limit is saturated, so the delay to "the
    // earliest due job" is zero for as long as the slots are full. Re-arming at
    // zero would burn the event loop for the whole length of a slow run.
    const h = harness({ hang: true, patch: { scheduler: { concurrency: 1 } } });
    for (let i = 0; i < 3; i += 1) {
      h.jobs.createJob(job({ name: `j${String(i)}` }));
    }
    h.scheduler.start();
    await tick(60_000);
    expect(h.runs).toHaveLength(1);

    const before = h.drains;
    await tick(60_000);
    // A minute of being saturated costs about a wake a second, not a wake per
    // event-loop turn. Without the floor this is unbounded.
    expect(h.drains - before).toBeLessThanOrEqual(65);
    expect(h.runs).toHaveLength(1);
    await h.scheduler.stop();
  });

  it('reads the concurrency limit live, so a settings save moves the next drain', async () => {
    const h = harness({ hang: true, patch: { scheduler: { concurrency: 1 } } });
    for (let i = 0; i < 3; i += 1) {
      h.jobs.createJob(job({ name: `j${String(i)}` }));
    }
    h.scheduler.start();

    await tick(60_000);
    expect(h.runs).toHaveLength(1);

    h.config = ConfigSchema.parse({ scheduler: { concurrency: 3 } });
    h.scheduler.refresh();
    await tick(60_000);
    expect(h.runs.length).toBeGreaterThan(1);
    await h.scheduler.stop();
  });
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

describe('Scheduler boot reconciliation', () => {
  it('closes out a run a dead process left pending', () => {
    const h = harness();
    const created = h.jobs.createJob(job({ nextRunAtMs: 0 }));
    const orphan = h.jobs.startRun({ jobId: created.id });

    h.scheduler.start();

    expect(h.jobs.getRun(orphan.id)).toMatchObject({
      status: 'error',
      error: 'Interrupted by a restart.',
    });
  });
});

describe('Scheduler catch-up', () => {
  const past = START - 10 * 60_000;

  it('runs a missed one-shot once when catch-up is on', async () => {
    const h = harness();
    h.jobs.createJob(
      job({ schedule: { kind: 'at', atMs: past }, nextRunAtMs: past }),
    );
    h.scheduler.start();
    await tick(0);

    expect(h.runs).toHaveLength(1);
    await tick(600_000);
    expect(h.runs).toHaveLength(1);
    await h.scheduler.stop();
  });

  it('coalesces many missed interval occurrences into a single run', async () => {
    // Ten minutes down on a one-minute interval is ten missed ticks. Running
    // ten times at boot is the failure this rule exists to prevent.
    const h = harness();
    h.jobs.createJob(
      job({ schedule: { kind: 'every', everyMs: 60_000 }, nextRunAtMs: past }),
    );
    h.scheduler.start();
    await tick(0);

    expect(h.runs).toHaveLength(1);
    await h.scheduler.stop();
  });

  it('coalesces missed cron occurrences the same way', async () => {
    const h = harness();
    h.jobs.createJob(
      job({ schedule: { kind: 'cron', expr: '* * * * *' }, nextRunAtMs: past }),
    );
    h.scheduler.start();
    await tick(0);

    expect(h.runs).toHaveLength(1);
    await h.scheduler.stop();
  });

  it('says so on the run, rather than letting a boot run look scheduled', async () => {
    const h = harness();
    h.jobs.createJob(
      job({ schedule: { kind: 'every', everyMs: 60_000 }, nextRunAtMs: past }),
    );
    h.scheduler.start();
    await tick(0);

    const [run] = h.jobs.listRuns(h.jobs.listJobs()[0]!.id);
    expect(run?.warnings.join(' ')).toMatch(
      /passed while the server was down/u,
    );
    await h.scheduler.stop();
  });

  it('records a missed one-shot as skipped when catch-up is off', async () => {
    const h = harness({ patch: { scheduler: { catchUpOnBoot: false } } });
    const created = h.jobs.createJob(
      job({ schedule: { kind: 'at', atMs: past }, nextRunAtMs: past }),
    );
    h.scheduler.start();
    await tick(0);

    expect(h.runs).toHaveLength(0);
    expect(h.jobs.listRuns(created.id)[0]).toMatchObject({
      status: 'skipped',
      skipReason: 'Missed while the server was down.',
    });
    expect(h.jobs.getJob(created.id)?.state.nextRunAtMs).toBe(0);
    await h.scheduler.stop();
  });

  it('keeps a missed self-destructing one-shot, because it never ran', async () => {
    // Deleting it would be a reminder that vanished without the operator ever
    // learning it was missed.
    const h = harness({ patch: { scheduler: { catchUpOnBoot: false } } });
    const created = h.jobs.createJob(
      job({
        schedule: { kind: 'at', atMs: past },
        nextRunAtMs: past,
        deleteAfterRun: true,
      }),
    );
    h.scheduler.start();
    await tick(0);

    expect(h.jobs.getJob(created.id)).toBeDefined();
    expect(h.jobs.getJob(created.id)?.state.lastStatus).toBe('skipped');
    await h.scheduler.stop();
  });

  it('just rearms a missed interval job when catch-up is off', async () => {
    const h = harness({ patch: { scheduler: { catchUpOnBoot: false } } });
    const created = h.jobs.createJob(
      job({ schedule: { kind: 'every', everyMs: 60_000 }, nextRunAtMs: past }),
    );
    h.scheduler.start();
    await tick(0);

    expect(h.runs).toHaveLength(0);
    expect(h.jobs.getJob(created.id)?.state.nextRunAtMs).toBe(START + 60_000);
    await h.scheduler.stop();
  });

  it('just rearms a missed cron job when catch-up is off', async () => {
    const h = harness({ patch: { scheduler: { catchUpOnBoot: false } } });
    const created = h.jobs.createJob(
      job({ schedule: { kind: 'cron', expr: '* * * * *' }, nextRunAtMs: past }),
    );
    h.scheduler.start();
    await tick(0);

    expect(h.runs).toHaveLength(0);
    expect(h.jobs.getJob(created.id)?.state.nextRunAtMs).toBeGreaterThan(START);
    await h.scheduler.stop();
  });
});

// ---------------------------------------------------------------------------
// One run's lifecycle
// ---------------------------------------------------------------------------

describe('Scheduler run lifecycle', () => {
  it('records the answer and notifies', async () => {
    const h = harness({ script: answers('the build is green') });
    const created = h.jobs.createJob(job());
    h.scheduler.start();
    await tick(60_000);

    expect(h.jobs.listRuns(created.id)[0]).toMatchObject({
      status: 'ok',
      output: 'the build is green',
    });
    expect(h.jobs.getJob(created.id)?.state).toMatchObject({
      lastStatus: 'ok',
      runCount: 1,
    });
    expect(h.notifications).toHaveLength(1);
    expect(h.broadcasts[0]).toMatchObject({
      type: 'notification',
      jobId: created.id,
    });
    await h.scheduler.stop();
  });

  it('sends the turn with the automation origin, so the session is not labelled web', async () => {
    const h = harness();
    h.jobs.createJob(job());
    h.scheduler.start();
    await tick(60_000);

    // The channel is the `origin` column, which is what queries filter on and
    // what the UI shows. The key itself is a plain id and says nothing.
    expect(h.runs[0]?.options.channel).toBe('automation');
    expect(h.runs[0]?.options.sessionKey).toBeTruthy();
    // It no longer spells out the job: that is `automation_runs.job_id`, where
    // it is indexed rather than embedded in a string nothing ever parsed.
    expect(h.runs[0]?.options.sessionKey).not.toContain(':');
  });

  it('says nobody is on the end of the connection it opens', async () => {
    // The turn goes through the hub, so the run has a connection attached to
    // its session like a browser tab does. Left unmarked, that made
    // `hub.watchers()` report 1 for every scheduled run — so the approval gate
    // read an unattended turn as a watched one and never raised the
    // notification that is the only way an operator learns a run is waiting.
    const h = harness();
    h.jobs.createJob(job());
    h.scheduler.start();
    await tick(60_000);

    expect(h.runs[0]?.options.unattended).toBe(true);
    await h.scheduler.stop();
  });

  it('uses the operator′s session key when one is pinned', async () => {
    const h = harness();
    h.jobs.createJob(
      job({
        payload: {
          kind: 'scheduled',
          message: 'go',
          deliver: false,
          targets: {},
          sessionKey: 'heartbeat:default',
        },
      }),
    );
    h.scheduler.start();
    await tick(60_000);

    expect(h.runs[0]?.options.sessionKey).toBe('heartbeat:default');
    await h.scheduler.stop();
  });

  it('carries the run id as the client message id, so a redelivery is not a second turn', async () => {
    const h = harness();
    const created = h.jobs.createJob(job());
    h.scheduler.start();
    await tick(60_000);

    const run = h.jobs.listRuns(created.id)[0];
    expect(
      (h.runs[0]?.message as { clientMessageId?: string }).clientMessageId,
    ).toBe(run?.id);
    await h.scheduler.stop();
  });

  it('records a turn that ended badly as an error and notifies about it', async () => {
    const h = harness({ script: answers('partial', 'error') });
    const created = h.jobs.createJob(job());
    h.scheduler.start();
    await tick(60_000);

    expect(h.jobs.listRuns(created.id)[0]).toMatchObject({ status: 'error' });
    expect(h.notifications[0]).toMatchObject({ level: 'error' });
    await h.scheduler.stop();
  });

  it('treats hitting the iteration cap as a warning, not a failure', async () => {
    // The turn did work and produced an answer; it ran out of tool budget
    // saying so. Calling that a failure would tell the operator a job broke.
    const h = harness({ script: answers('most of it', 'max_iterations') });
    const created = h.jobs.createJob(job());
    h.scheduler.start();
    await tick(60_000);

    const run = h.jobs.listRuns(created.id)[0];
    expect(run?.status).toBe('ok');
    expect(run?.warnings.join(' ')).toMatch(/iteration cap/u);
    await h.scheduler.stop();
  });

  it('records a hub refusal as an error rather than hanging', async () => {
    const h = harness({
      script: () => [
        {
          type: 'error',
          code: 'not_configured',
          message: 'No model',
          retryable: false,
        },
      ],
    });
    const created = h.jobs.createJob(job());
    h.scheduler.start();
    await tick(60_000);

    expect(h.jobs.listRuns(created.id)[0]).toMatchObject({
      status: 'error',
      error: 'No model',
    });
    await h.scheduler.stop();
  });

  it('warns rather than silently swallowing a delivery nothing can carry', async () => {
    const h = harness();
    const created = h.jobs.createJob(
      job({
        payload: {
          kind: 'scheduled',
          message: 'go',
          deliver: true,
          targets: {},
        },
      }),
    );
    h.scheduler.start();
    await tick(60_000);

    const run = h.jobs.listRuns(created.id)[0];
    expect(run?.status).toBe('ok');
    expect(run?.warnings.join(' ')).toMatch(/no channel is wired yet/u);
    await h.scheduler.stop();
  });

  it('deletes a self-destructing one-shot after it fires', async () => {
    const h = harness();
    const created = h.jobs.createJob(
      job({
        schedule: { kind: 'at', atMs: START + 1000 },
        nextRunAtMs: START + 1000,
        deleteAfterRun: true,
      }),
    );
    h.scheduler.start();
    await tick(1000);

    expect(h.jobs.getJob(created.id)).toBeUndefined();
    await h.scheduler.stop();
  });

  it('unschedules a one-shot that is not self-destructing', async () => {
    const h = harness();
    const created = h.jobs.createJob(
      job({
        schedule: { kind: 'at', atMs: START + 1000 },
        nextRunAtMs: START + 1000,
      }),
    );
    h.scheduler.start();
    await tick(600_000);

    expect(h.runs).toHaveLength(1);
    expect(h.jobs.getJob(created.id)?.state.nextRunAtMs).toBe(0);
    await h.scheduler.stop();
  });

  it('trims history and deletes the sessions it minted, but not one the operator pinned', async () => {
    const h = harness({ patch: { scheduler: { runRetention: 1 } } });
    const created = h.jobs.createJob(
      job({
        schedule: { kind: 'every', everyMs: 1000 },
        nextRunAtMs: START + 1000,
      }),
    );
    h.scheduler.start();
    await tick(1000);
    await tick(1000);

    expect(h.jobs.listRuns(created.id)).toHaveLength(1);
    expect(h.deletedSessions.length).toBeGreaterThan(0);
    expect(h.deletedSessions.every((key) => key !== '')).toBe(true);
    await h.scheduler.stop();
  });
});

describe('Scheduler runNow', () => {
  it('returns a pending row rather than waiting out the turn', () => {
    const h = harness({ hang: true });
    const created = h.jobs.createJob(job({ nextRunAtMs: 0 }));
    h.scheduler.start();

    const run = h.scheduler.runNow(created.id);
    expect(run.status).toBe('pending');
    expect(h.runs).toHaveLength(1);
  });

  it('refuses an unknown job', () => {
    const h = harness();
    h.scheduler.start();
    expect(() => h.scheduler.runNow('nope')).toThrow(/No automation job/u);
  });

  it('runs a disabled job on demand without putting it back on the timer', async () => {
    // On-demand is the one caller that reaches a job the drain would never
    // pick up, so it is the only place this can happen. Writing a next-run time
    // left a row badged Disabled showing a "Next run" beside it, and a stale
    // time waiting to be inherited whenever it was switched back on.
    const h = harness();
    const created = h.jobs.createJob(job({ enabled: false, nextRunAtMs: 0 }));
    h.scheduler.start();

    h.scheduler.runNow(created.id);
    await tick(1000);

    // It really ran — this is a manual override, not a refusal.
    expect(h.runs).toHaveLength(1);
    expect(h.jobs.listRuns(created.id)[0]?.status).toBe('ok');
    // And it is still unscheduled, exactly as it was.
    expect(h.jobs.getJob(created.id)?.state.nextRunAtMs).toBe(0);
    expect(h.jobs.getJob(created.id)?.enabled).toBe(false);
    await h.scheduler.stop();
  });

  it('refuses to start a second run of a job already running', () => {
    const h = harness({ hang: true });
    const created = h.jobs.createJob(job({ nextRunAtMs: 0 }));
    h.scheduler.start();

    h.scheduler.runNow(created.id);
    expect(() => h.scheduler.runNow(created.id)).toThrow(/already running/u);
  });
});

describe('Scheduler stop', () => {
  it('aborts a run in flight and records why', async () => {
    const h = harness({ hang: true });
    const created = h.jobs.createJob(job());
    h.scheduler.start();
    await tick(60_000);
    expect(h.jobs.listRuns(created.id)[0]?.status).toBe('pending');

    await h.scheduler.stop();

    expect(h.jobs.listRuns(created.id)[0]).toMatchObject({
      status: 'error',
      error: 'Interrupted by shutdown.',
    });
  });

  it('stops the timer, so nothing runs afterwards', async () => {
    const h = harness();
    h.jobs.createJob(job());
    h.scheduler.start();
    await h.scheduler.stop();

    await tick(600_000);
    expect(h.runs).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Heartbeat
// ---------------------------------------------------------------------------

function completion(name: string, argumentsJson: string): ChatResult {
  return {
    message: {
      role: 'assistant',
      content: [],
      toolCalls: [{ id: 'c0', name, argumentsJson }],
    },
    finishReason: 'tool_calls',
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    model: 'cheap',
  };
}

function heartbeatJob(over: Partial<CreateJobInput> = {}): CreateJobInput {
  return job({
    payload: {
      kind: 'heartbeat',
      file: 'TASK.md',
      deliver: false,
      targets: {},
    },
    ...over,
  });
}

describe('Scheduler heartbeat', () => {
  it('skips without running a turn when the model says skip', async () => {
    const h = harness({
      readFile: () => Promise.resolve('Ship it on Friday'),
      chat: (input) =>
        Promise.resolve(
          completion(
            input.tools[0]?.name ?? '',
            JSON.stringify({ action: 'skip', reason: 'Not until Friday.' }),
          ),
        ),
    });
    const created = h.jobs.createJob(heartbeatJob());
    h.scheduler.start();
    await tick(60_000);

    expect(h.runs).toHaveLength(0);
    expect(h.jobs.listRuns(created.id)[0]).toMatchObject({
      status: 'skipped',
      skipReason: 'Not until Friday.',
    });
    await h.scheduler.stop();
  });

  it('runs a turn and then asks whether it was worth a notification', async () => {
    const h = harness({
      script: answers('I fixed it'),
      readFile: () => Promise.resolve('Fix the build'),
      chat: (input) =>
        Promise.resolve(
          input.tools[0]?.name === HEARTBEAT_TOOL.name
            ? completion(
                HEARTBEAT_TOOL.name,
                JSON.stringify({
                  action: 'run',
                  reason: 'Due.',
                  instruction: 'Fix the build',
                }),
              )
            : completion(
                HEARTBEAT_RESULT_TOOL.name,
                JSON.stringify({
                  notify: true,
                  title: 'Build fixed',
                  summary: 'One test.',
                }),
              ),
        ),
    });
    const created = h.jobs.createJob(heartbeatJob());
    h.scheduler.start();
    await tick(60_000);

    expect(h.runs).toHaveLength(1);
    expect(h.jobs.listRuns(created.id)[0]).toMatchObject({
      status: 'ok',
      output: 'I fixed it',
    });
    expect(h.notifications[0]).toMatchObject({
      title: 'Build fixed',
      body: 'One test.',
    });
    await h.scheduler.stop();
  });

  it('records the run but raises no notification when the result is not worth one', async () => {
    // The whole reason heartbeats are tolerable: work happened, nobody was
    // interrupted, and the history still says what was done.
    const h = harness({
      script: answers('nothing much'),
      readFile: () => Promise.resolve('Check things'),
      chat: (input) =>
        Promise.resolve(
          input.tools[0]?.name === HEARTBEAT_TOOL.name
            ? completion(
                HEARTBEAT_TOOL.name,
                JSON.stringify({
                  action: 'run',
                  reason: 'Due.',
                  instruction: 'Check',
                }),
              )
            : completion(
                HEARTBEAT_RESULT_TOOL.name,
                JSON.stringify({ notify: false, title: 'Routine' }),
              ),
        ),
    });
    const created = h.jobs.createJob(heartbeatJob());
    h.scheduler.start();
    await tick(60_000);

    expect(h.jobs.listRuns(created.id)[0]?.status).toBe('ok');
    expect(h.notifications).toHaveLength(0);
    expect(h.broadcasts).toHaveLength(0);
    await h.scheduler.stop();
  });

  it('notifies about a failed run even though the evaluator would veto it', async () => {
    // The evaluate step never gets to suppress a failure. A job that has quietly
    // not worked for a week is worse than a spurious toast — so the run that
    // errored is not even offered to the model that decides about notifying.
    let evaluated = 0;
    const h = harness({
      script: answers('half of it', 'error'),
      readFile: () => Promise.resolve('Fix the build'),
      chat: (input) => {
        if (input.tools[0]?.name === HEARTBEAT_TOOL.name) {
          return Promise.resolve(
            completion(
              HEARTBEAT_TOOL.name,
              JSON.stringify({
                action: 'run',
                reason: 'Due.',
                instruction: 'Fix it',
              }),
            ),
          );
        }
        evaluated += 1;
        return Promise.resolve(
          completion(
            HEARTBEAT_RESULT_TOOL.name,
            JSON.stringify({ notify: false, title: 'Quiet' }),
          ),
        );
      },
    });
    const created = h.jobs.createJob(heartbeatJob());
    h.scheduler.start();
    await tick(60_000);

    expect(evaluated).toBe(0);
    expect(h.jobs.listRuns(created.id)[0]?.status).toBe('error');
    expect(h.notifications).toHaveLength(1);
    expect(h.notifications[0]).toMatchObject({
      level: 'error',
      jobId: created.id,
    });
    await h.scheduler.stop();
  });

  it('skips with no provider call at all when the task file is missing', async () => {
    // The common case on a fresh install. It must cost nothing.
    let asked = 0;
    const h = harness({
      readFile: () =>
        Promise.reject(
          new (class extends Error {
            readonly kind = 'not_found';
          })('no such file'),
        ),
      chat: () => {
        asked += 1;
        return Promise.resolve(completion(HEARTBEAT_TOOL.name, '{}'));
      },
    });
    const created = h.jobs.createJob(heartbeatJob());
    h.scheduler.start();
    await tick(60_000);

    expect(asked).toBe(0);
    expect(h.jobs.listRuns(created.id)[0]).toMatchObject({
      status: 'skipped',
      skipReason: 'No TASK.md in the workspace.',
    });
    await h.scheduler.stop();
  });

  it('skips an empty task file without paying for a decision', async () => {
    let asked = 0;
    const h = harness({
      readFile: () => Promise.resolve('   \n  '),
      chat: () => {
        asked += 1;
        return Promise.resolve(completion(HEARTBEAT_TOOL.name, '{}'));
      },
    });
    const created = h.jobs.createJob(heartbeatJob());
    h.scheduler.start();
    await tick(60_000);

    expect(asked).toBe(0);
    expect(h.jobs.listRuns(created.id)[0]?.skipReason).toBe(
      'TASK.md is empty.',
    );
    await h.scheduler.stop();
  });

  it('never starts a turn on a decision it could not read', async () => {
    const h = harness({
      readFile: () => Promise.resolve('do something'),
      chat: () => Promise.resolve(completion(HEARTBEAT_TOOL.name, '{not json')),
    });
    const created = h.jobs.createJob(heartbeatJob());
    h.scheduler.start();
    await tick(60_000);

    expect(h.runs).toHaveLength(0);
    expect(h.jobs.listRuns(created.id)[0]?.status).toBe('skipped');
    await h.scheduler.stop();
  });

  it('errors rather than always running when the build has no provider access', async () => {
    const h = harness();
    const created = h.jobs.createJob(heartbeatJob());
    h.scheduler.start();
    await tick(60_000);

    expect(h.runs).toHaveLength(0);
    expect(h.jobs.listRuns(created.id)[0]).toMatchObject({ status: 'error' });
    await h.scheduler.stop();
  });

  it('passes the cheaper model through to the decision', async () => {
    const seen: Array<string | undefined> = [];
    const h = harness({
      readFile: () => Promise.resolve('x'),
      chat: (input) => {
        seen.push(input.model);
        return Promise.resolve(
          completion(
            HEARTBEAT_TOOL.name,
            JSON.stringify({ action: 'skip', reason: 'no' }),
          ),
        );
      },
    });
    h.jobs.createJob(
      heartbeatJob({
        payload: {
          kind: 'heartbeat',
          file: 'TASK.md',
          model: 'tiny',
          deliver: false,
          targets: {},
        },
      }),
    );
    h.scheduler.start();
    await tick(60_000);

    expect(seen[0]).toBe('tiny');
    await h.scheduler.stop();
  });
});

describe('a job′s workspace', () => {
  it('opens the run′s connection in the workspace the job names', async () => {
    const h = harness({ script: answers('done') });
    h.jobs.createJob(
      job({
        payload: {
          kind: 'scheduled',
          message: 'go',
          workspaceId: 'research',
          deliver: false,
          targets: {},
        },
      }),
    );
    h.scheduler.start();
    await tick(60_000);

    expect(h.runs[0]?.options.workspaceId).toBe('research');
    await h.scheduler.stop();
  });

  it('passes no workspace for a job that names none, so the default applies', async () => {
    const h = harness({ script: answers('done') });
    h.jobs.createJob(job());
    h.scheduler.start();
    await tick(60_000);

    expect(h.runs[0]?.options.workspaceId).toBeUndefined();
    await h.scheduler.stop();
  });

  it('reads the heartbeat′s task file from the job′s own workspace', async () => {
    // The bug this closes: `TASK.md` was always read through the default
    // workspace's jail, so a heartbeat in a named workspace skipped forever on
    // a file it could not see.
    const seen: Array<{ workspaceId: string; path: string }> = [];
    const h = harness({
      readFile: (input) => {
        seen.push({ workspaceId: input.workspaceId, path: input.path });
        return Promise.resolve('Fix the build');
      },
      chat: (input) =>
        Promise.resolve(
          completion(
            input.tools[0]?.name ?? '',
            JSON.stringify({ action: 'skip', reason: 'not now' }),
          ),
        ),
    });
    h.jobs.createJob(
      heartbeatJob({
        payload: {
          kind: 'heartbeat',
          file: 'TASK.md',
          workspaceId: 'research',
          deliver: false,
          targets: {},
        },
      }),
    );
    h.scheduler.start();
    await tick(60_000);

    expect(seen[0]).toEqual({ workspaceId: 'research', path: 'TASK.md' });
    await h.scheduler.stop();
  });

  it('reads the task file from the default workspace when the job names none', async () => {
    const seen: string[] = [];
    const h = harness({
      readFile: (input) => {
        seen.push(input.workspaceId);
        return Promise.resolve('Fix the build');
      },
      chat: (input) =>
        Promise.resolve(
          completion(
            input.tools[0]?.name ?? '',
            JSON.stringify({ action: 'skip', reason: 'not now' }),
          ),
        ),
    });
    h.jobs.createJob(heartbeatJob());
    h.scheduler.start();
    await tick(60_000);

    expect(seen[0]).toBe('default');
    await h.scheduler.stop();
  });
});
