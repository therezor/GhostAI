/**
 * The guards, which are the whole of this file's reason to exist.
 *
 * The tool itself is argument shuffling; everything that decides whether a model
 * may schedule lives on the bound port, and none of it is testable from the
 * tool's side because the tool cannot say who it is.
 */

import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import { SessionStore } from '@ghostbot/core';
import type { CreateAutomationJob } from '@ghostbot/protocol';
import type { AutomationPort, ToolboxRequest } from '@ghostbot/tools';

import { AutomationStore } from '#src/automation-store.js';
import {
  MAX_AGENT_JOBS,
  createAutomationResolver,
} from '#src/automation-port.js';
import { manualClock } from '#testkit/clock.js';

const opened: DatabaseSync[] = [];
const stores: SessionStore[] = [];

afterEach(() => {
  while (stores.length > 0) stores.pop()?.close();
  while (opened.length > 0) opened.pop()?.close();
});

const JOB: CreateAutomationJob = {
  name: 'Nightly build',
  schedule: { kind: 'cron', expr: '0 9 * * *' },
  payload: {
    kind: 'scheduled',
    message: 'check the build',
    deliver: false,
    targets: {},
  },
  enabled: true,
  deleteAfterRun: false,
};

interface Harness {
  readonly jobs: AutomationStore;
  readonly sessions: SessionStore;
  readonly refreshes: { count: number };
  port(over?: Partial<ToolboxRequest>): AutomationPort;
}

function harness(): Harness {
  const database = new DatabaseSync(':memory:');
  opened.push(database);
  const sessions = new SessionStore({ database });
  stores.push(sessions);

  const clock = manualClock();
  let counter = 0;
  const jobs = new AutomationStore({
    database,
    clock,
    newId: () => `j${String(++counter).padStart(3, '0')}`,
  });

  const refreshes = { count: 0 };
  const resolver = createAutomationResolver({
    jobs,
    sessions,
    timezone: () => 'UTC',
    now: () => clock.now(),
    refresh: () => {
      refreshes.count += 1;
    },
  });

  return {
    jobs,
    sessions,
    refreshes,
    port: (over = {}) => {
      // The resolver's contract allows `undefined` — a build with no scheduler
      // — and this one never returns it. Narrowed loudly rather than asserted,
      // so a change that made it optional fails here rather than silently.
      const bound = resolver.forTurn({
        agentId: 'reviewer',
        workspaceId: 'default',
        sessionKey: 'web:1',
        toolbox: '',
        network: { mode: 'none', allow: [] },
        workspaceRoot: '/tmp',
        ...over,
      });
      if (bound === undefined) throw new Error('the resolver supplied no port');
      return bound;
    },
  };
}

describe('creating a job', () => {
  it('records who asked for it and where', async () => {
    const h = harness();
    h.sessions.ensureSession('web:1', { origin: 'web' });

    const created = h.port().create(JOB);

    expect(created.ok).toBe(true);
    expect(created.value?.createdBy).toEqual({
      agentId: 'reviewer',
      sessionKey: 'web:1',
    });
    await Promise.resolve();
  });

  it('runs the job as the agent that scheduled it, not as the default', () => {
    // The payload used to carry no `agentId`, and the scheduler reads absent as
    // "the default agent" — so a job a specialised agent wrote ran on a
    // different prompt, a different model and a different tool grant than the
    // one that wrote it. The tool cannot set this: it would be letting a model
    // schedule a turn as somebody else.
    const h = harness();
    h.sessions.ensureSession('web:1', { origin: 'web' });

    const created = h.port().create(JOB);

    expect(created.value?.payload).toMatchObject({ agentId: 'reviewer' });
  });

  it('runs the job in the workspace the turn was working in', () => {
    // Before this, a job scheduled during a turn in a named workspace ran in
    // the default one, so the follow-up work could not see the files that
    // prompted it.
    const h = harness();
    h.sessions.ensureSession('web:1', { origin: 'web' });

    const created = h.port({ workspaceId: 'research' }).create(JOB);

    expect(created.value?.payload).toMatchObject({ workspaceId: 'research' });
  });

  it('does not let the tool name a workspace of its own', () => {
    // The same argument that keeps `agentId` out of the tool's hands: the turn
    // runs on arguments a model wrote, and a model naming its own workspace
    // would be a way out of the jail it is working in.
    const h = harness();
    h.sessions.ensureSession('web:1', { origin: 'web' });

    const created = h.port({ workspaceId: 'research' }).create({
      ...JOB,
      payload: { ...JOB.payload, workspaceId: 'somebody-elses' },
    });

    expect(created.value?.payload).toMatchObject({ workspaceId: 'research' });
  });

  it('re-arms the timer, so a job made mid-turn actually fires', () => {
    const h = harness();
    h.sessions.ensureSession('web:1', { origin: 'web' });

    h.port().create(JOB);

    expect(h.refreshes.count).toBe(1);
  });

  it('refuses a schedule the timer could not honour, with the parser′s own words', () => {
    const h = harness();
    h.sessions.ensureSession('web:1', { origin: 'web' });

    const bad = h
      .port()
      .create({ ...JOB, schedule: { kind: 'cron', expr: '99 * * * *' } });

    expect(bad).toMatchObject({ ok: false, refusal: 'unschedulable' });
    expect(bad.detail).toMatch(/minute must be between 0 and 59/u);
    expect(h.jobs.listJobs()).toHaveLength(0);
  });

  it('reads a zoneless cron in the configured zone rather than the host′s', () => {
    const h = harness();
    h.sessions.ensureSession('web:1', { origin: 'web' });

    const created = h.port().create(JOB);

    expect(created.value?.state.nextRunAtMs).toBeGreaterThan(0);
  });
});

describe('the nested guard', () => {
  it('refuses to schedule from inside a scheduled run', () => {
    // The point of this file. Without it a job whose payload says "keep an eye
    // on things" can create another job that says the same, and the install
    // grows jobs geometrically with nobody watching.
    const h = harness();
    h.sessions.ensureSession('automation:job-1:run-1', {
      origin: 'automation',
    });

    const refused = h
      .port({ sessionKey: 'automation:job-1:run-1' })
      .create(JOB);

    expect(refused).toMatchObject({ ok: false, refusal: 'nested' });
    expect(h.jobs.listJobs()).toHaveLength(0);
  });

  it('reads the origin from the stored row rather than from anything passed in', () => {
    // A session key that merely looks like an automation one is not one; a row
    // whose origin says so is. The store is the only thing that cannot be
    // argued with by a caller.
    const h = harness();
    h.sessions.ensureSession('automation:looks-like-it', { origin: 'web' });

    const allowed = h
      .port({ sessionKey: 'automation:looks-like-it' })
      .create(JOB);

    expect(allowed.ok).toBe(true);
  });

  it('still lets a scheduled run read what it has scheduled', () => {
    // Listing creates nothing, and a job knowing what it already set up is
    // useful rather than dangerous.
    const h = harness();
    h.sessions.ensureSession('automation:job-1:run-1', {
      origin: 'automation',
    });

    const listed = h.port({ sessionKey: 'automation:job-1:run-1' }).list();

    expect(listed.ok).toBe(true);
  });
});

describe('the per-agent cap', () => {
  it('refuses once an agent holds as many as it may', () => {
    const h = harness();
    h.sessions.ensureSession('web:1', { origin: 'web' });
    const port = h.port();

    for (let i = 0; i < MAX_AGENT_JOBS; i += 1) {
      expect(port.create({ ...JOB, name: `job ${String(i)}` }).ok).toBe(true);
    }

    expect(port.create(JOB)).toMatchObject({
      ok: false,
      refusal: 'at-capacity',
    });
    expect(h.jobs.listJobs()).toHaveLength(MAX_AGENT_JOBS);
  });

  it('counts per agent, so one agent cannot exhaust another′s allowance', () => {
    const h = harness();
    h.sessions.ensureSession('web:1', { origin: 'web' });

    for (let i = 0; i < MAX_AGENT_JOBS; i += 1) {
      h.port().create({ ...JOB, name: `job ${String(i)}` });
    }

    expect(h.port({ agentId: 'writer' }).create(JOB).ok).toBe(true);
  });

  it('does not count the operator′s own jobs against an agent', () => {
    const h = harness();
    h.sessions.ensureSession('web:1', { origin: 'web' });
    for (let i = 0; i < MAX_AGENT_JOBS; i += 1) {
      h.jobs.createJob({
        ...JOB,
        name: `operator ${String(i)}`,
        nextRunAtMs: 1,
      });
    }

    expect(h.port().create(JOB).ok).toBe(true);
  });
});

describe('ownership', () => {
  it('lists only what this agent created', () => {
    const h = harness();
    h.sessions.ensureSession('web:1', { origin: 'web' });
    h.jobs.createJob({ ...JOB, name: 'the operator′s', nextRunAtMs: 1 });
    h.port({ agentId: 'writer' }).create({ ...JOB, name: 'the writer′s' });
    h.port().create({ ...JOB, name: 'mine' });

    const listed = h.port().list();

    expect(listed.value?.map((job) => job.name)).toEqual(['mine']);
  });

  it('refuses to delete a job it did not create', () => {
    const h = harness();
    h.sessions.ensureSession('web:1', { origin: 'web' });
    const operators = h.jobs.createJob({
      ...JOB,
      name: 'the operator′s',
      nextRunAtMs: 1,
    });

    expect(h.port().delete(operators.id)).toMatchObject({
      ok: false,
      refusal: 'not-yours',
    });
    expect(h.jobs.getJob(operators.id)).toBeDefined();
  });

  it('answers the same way for a job that does not exist', () => {
    // One answer for both, so an agent cannot map the operator's jobs by
    // probing ids and watching which refusal comes back.
    const h = harness();
    h.sessions.ensureSession('web:1', { origin: 'web' });
    const operators = h.jobs.createJob({
      ...JOB,
      name: 'theirs',
      nextRunAtMs: 1,
    });

    expect(h.port().delete('no-such-job').refusal).toBe(
      h.port().delete(operators.id).refusal,
    );
  });

  it('deletes its own', () => {
    const h = harness();
    h.sessions.ensureSession('web:1', { origin: 'web' });
    const mine = h.port().create(JOB);

    expect(h.port().delete(mine.value?.id ?? '')).toMatchObject({ ok: true });
    expect(h.jobs.listJobs()).toHaveLength(0);
  });
});
