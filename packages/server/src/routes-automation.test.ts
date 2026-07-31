/**
 * The automation routes, over a real store and a stand-in engine.
 *
 * No timer runs here. `SchedulerPort` is narrow enough that a test supplies a
 * two-method object, which is the whole reason `RouteDeps` holds the port
 * rather than the class.
 */

import { afterEach, describe, expect, it } from 'vitest';

import type {
  AutomationJob,
  AutomationJobListResponse,
  AutomationRun,
  AutomationRunListResponse,
} from '@ghostai/protocol';

import type { SchedulerPort } from './scheduler.js';
import { startTestServer, type TestServer } from './testkit/server.js';

const running: TestServer[] = [];

afterEach(async () => {
  while (running.length > 0) await running.pop()?.close();
});

interface FakeScheduler extends SchedulerPort {
  readonly ran: string[];
  readonly refreshes: { count: number };
}

function fakeScheduler(over: Partial<SchedulerPort> = {}): FakeScheduler {
  const ran: string[] = [];
  const refreshes = { count: 0 };
  return {
    ran,
    refreshes,
    enabled: true,
    runNow: (jobId) => {
      ran.push(jobId);
      return {
        id: `run-${jobId}`,
        jobId,
        startedAtMs: 1,
        status: 'pending',
        warnings: [],
      } satisfies AutomationRun;
    },
    refresh: () => {
      refreshes.count += 1;
    },
    ...over,
  };
}

async function start(options: Parameters<typeof startTestServer>[0] = {}): Promise<TestServer> {
  const started = await startTestServer(options);
  running.push(started);
  return started;
}

const CRON_BODY = {
  name: 'Morning',
  schedule: { kind: 'cron', expr: '0 9 * * *', tz: 'UTC' },
  payload: { kind: 'scheduled', message: 'check the build' },
};

describe('automation jobs CRUD', () => {
  it('creates a job, answering 201 with the row and its computed next run', async () => {
    const test = await start();
    const response = await test.server.app.inject({
      method: 'POST',
      url: '/api/automation/jobs',
      headers: test.headers,
      payload: CRON_BODY,
    });

    expect(response.statusCode).toBe(201);
    const job = response.json<AutomationJob>();
    expect(job).toMatchObject({ name: 'Morning', enabled: true });
    expect(job.id).not.toBe('');
    // Computed by the same function the timer uses, so a schedule that saves is
    // one the engine can honour.
    expect(job.state.nextRunAtMs).toBeGreaterThan(0);
  });

  it('lists what it created', async () => {
    const test = await start();
    await test.server.app.inject({
      method: 'POST',
      url: '/api/automation/jobs',
      headers: test.headers,
      payload: CRON_BODY,
    });

    const response = await test.server.app.inject({
      method: 'GET',
      url: '/api/automation/jobs',
      headers: test.headers,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<AutomationJobListResponse>().jobs.map((j) => j.name)).toEqual(['Morning']);
  });

  it('reads one job back by id, so a deep link resolves', async () => {
    const test = await start();
    const created = (
      await test.server.app.inject({
        method: 'POST',
        url: '/api/automation/jobs',
        headers: test.headers,
        payload: CRON_BODY,
      })
    ).json<AutomationJob>();

    const response = await test.server.app.inject({
      method: 'GET',
      url: `/api/automation/jobs/${created.id}`,
      headers: test.headers,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<AutomationJob>().id).toBe(created.id);
  });

  it('patches only what the body names', async () => {
    const test = await start();
    const created = (
      await test.server.app.inject({
        method: 'POST',
        url: '/api/automation/jobs',
        headers: test.headers,
        payload: CRON_BODY,
      })
    ).json<AutomationJob>();

    const response = await test.server.app.inject({
      method: 'PATCH',
      url: `/api/automation/jobs/${created.id}`,
      headers: test.headers,
      payload: { name: 'Renamed' },
    });

    expect(response.statusCode).toBe(200);
    const updated = response.json<AutomationJob>();
    expect(updated.name).toBe('Renamed');
    expect(updated.schedule).toEqual(created.schedule);
    // Untouched: the schedule did not move, so neither did the next run.
    expect(updated.state.nextRunAtMs).toBe(created.state.nextRunAtMs);
  });

  it('recomputes the next run when the schedule changes', async () => {
    // Leaving the old instant behind is how a job edited to run at 9am keeps
    // firing at 3am until someone restarts the server.
    const test = await start();
    const created = (
      await test.server.app.inject({
        method: 'POST',
        url: '/api/automation/jobs',
        headers: test.headers,
        payload: CRON_BODY,
      })
    ).json<AutomationJob>();

    const response = await test.server.app.inject({
      method: 'PATCH',
      url: `/api/automation/jobs/${created.id}`,
      headers: test.headers,
      payload: { schedule: { kind: 'every', everyMs: 60_000 } },
    });

    expect(response.json<AutomationJob>().state.nextRunAtMs).not.toBe(created.state.nextRunAtMs);
  });

  it('unschedules a job that is switched off, and reschedules one switched on', async () => {
    const test = await start();
    const created = (
      await test.server.app.inject({
        method: 'POST',
        url: '/api/automation/jobs',
        headers: test.headers,
        payload: CRON_BODY,
      })
    ).json<AutomationJob>();

    const off = await test.server.app.inject({
      method: 'PATCH',
      url: `/api/automation/jobs/${created.id}`,
      headers: test.headers,
      payload: { enabled: false },
    });
    expect(off.json<AutomationJob>().state.nextRunAtMs).toBe(0);

    const on = await test.server.app.inject({
      method: 'PATCH',
      url: `/api/automation/jobs/${created.id}`,
      headers: test.headers,
      payload: { enabled: true },
    });
    expect(on.json<AutomationJob>().state.nextRunAtMs).toBeGreaterThan(0);
  });

  it('deletes a job with 204', async () => {
    const test = await start();
    const created = (
      await test.server.app.inject({
        method: 'POST',
        url: '/api/automation/jobs',
        headers: test.headers,
        payload: CRON_BODY,
      })
    ).json<AutomationJob>();

    const response = await test.server.app.inject({
      method: 'DELETE',
      url: `/api/automation/jobs/${created.id}`,
      headers: test.headers,
    });
    expect(response.statusCode).toBe(204);

    const after = await test.server.app.inject({
      method: 'GET',
      url: `/api/automation/jobs/${created.id}`,
      headers: test.headers,
    });
    expect(after.statusCode).toBe(404);
  });

  it('404s every route that names a job which is not there', async () => {
    const test = await start({ scheduler: fakeScheduler() });
    for (const [method, url] of [
      ['GET', '/api/automation/jobs/nope'],
      ['PATCH', '/api/automation/jobs/nope'],
      ['DELETE', '/api/automation/jobs/nope'],
      ['POST', '/api/automation/jobs/nope/run'],
      ['GET', '/api/automation/jobs/nope/runs'],
    ] as const) {
      const response = await test.server.app.inject({
        method,
        url,
        headers: test.headers,
        ...(method === 'PATCH' ? { payload: { name: 'x' } } : {}),
      });
      expect(response.statusCode, `${method} ${url}`).toBe(404);
    }
  });
});

describe('automation validation', () => {
  it('answers 422 naming the field for a cron expression it cannot honour', async () => {
    // `parseCron` throws `GhostError('config')`, whose default mapping is a 500
    // — right for "this install is broken", wrong for "the operator typed it".
    const test = await start();
    const response = await test.server.app.inject({
      method: 'POST',
      url: '/api/automation/jobs',
      headers: test.headers,
      payload: { ...CRON_BODY, schedule: { kind: 'cron', expr: 'not a cron' } },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json<{ error: { details?: Record<string, unknown> } }>().error.details).toEqual(
      expect.objectContaining({ '/schedule': expect.stringContaining('cron') as unknown }),
    );
  });

  it('answers 422 for an unknown timezone, at save rather than at first fire', async () => {
    const test = await start();
    const response = await test.server.app.inject({
      method: 'POST',
      url: '/api/automation/jobs',
      headers: test.headers,
      payload: { ...CRON_BODY, schedule: { kind: 'cron', expr: '0 9 * * *', tz: 'Mars/Base' } },
    });
    expect(response.statusCode).toBe(422);
  });

  it('refuses a schedule carrying a field from a different kind', async () => {
    // The discriminated union's whole point, enforced at the edge.
    const test = await start();
    const response = await test.server.app.inject({
      method: 'POST',
      url: '/api/automation/jobs',
      headers: test.headers,
      payload: { ...CRON_BODY, schedule: { kind: 'cron', expr: '0 9 * * *', atMs: 5 } },
    });
    // 422 rather than 400: the body was well-formed JSON that failed its
    // schema, which is what the repo's `unprocessable` is for.
    expect(response.statusCode).toBe(422);
  });

  it('refuses a patch whose new schedule does not parse, leaving the job alone', async () => {
    const test = await start();
    const created = (
      await test.server.app.inject({
        method: 'POST',
        url: '/api/automation/jobs',
        headers: test.headers,
        payload: CRON_BODY,
      })
    ).json<AutomationJob>();

    const response = await test.server.app.inject({
      method: 'PATCH',
      url: `/api/automation/jobs/${created.id}`,
      headers: test.headers,
      payload: { schedule: { kind: 'cron', expr: '99 * * * *' } },
    });
    expect(response.statusCode).toBe(422);

    const after = await test.server.app.inject({
      method: 'GET',
      url: `/api/automation/jobs/${created.id}`,
      headers: test.headers,
    });
    expect(after.json<AutomationJob>().schedule).toEqual(created.schedule);
  });
});

describe('automation run on demand', () => {
  async function withJob(scheduler?: SchedulerPort): Promise<{
    test: TestServer;
    job: AutomationJob;
  }> {
    const test = await start(scheduler === undefined ? {} : { scheduler });
    const job = (
      await test.server.app.inject({
        method: 'POST',
        url: '/api/automation/jobs',
        headers: test.headers,
        payload: CRON_BODY,
      })
    ).json<AutomationJob>();
    return { test, job };
  }

  it('answers 202 with the pending row rather than waiting out the turn', async () => {
    // A turn takes minutes. Awaiting it here would hold a browser request open
    // past every timeout between the two.
    const scheduler = fakeScheduler();
    const { test, job } = await withJob(scheduler);

    const response = await test.server.app.inject({
      method: 'POST',
      url: `/api/automation/jobs/${job.id}/run`,
      headers: test.headers,
    });

    expect(response.statusCode).toBe(202);
    expect(response.json<AutomationRun>().status).toBe('pending');
    expect(scheduler.ran).toEqual([job.id]);
  });

  it('refuses when this build has no engine at all', async () => {
    const { test, job } = await withJob();
    const response = await test.server.app.inject({
      method: 'POST',
      url: `/api/automation/jobs/${job.id}/run`,
      headers: test.headers,
    });
    expect(response.statusCode).toBe(404);
  });

  it('refuses with 422 when the scheduler is switched off, not 404', async () => {
    // The route exists and so does the job. The operator turned the engine off,
    // and saying which is what lets them turn it back on.
    const { test, job } = await withJob(fakeScheduler({ enabled: false }));
    const response = await test.server.app.inject({
      method: 'POST',
      url: `/api/automation/jobs/${job.id}/run`,
      headers: test.headers,
    });
    expect(response.statusCode).toBe(422);
    expect(response.json<{ error: { message: string } }>().error.message).toMatch(/disabled/u);
  });

  it('answers 409 when the job is already running', async () => {
    const { test, job } = await withJob(
      fakeScheduler({
        runNow: () => {
          throw Object.assign(new Error('"Morning" is already running.'), { kind: 'conflict' });
        },
      }),
    );
    const response = await test.server.app.inject({
      method: 'POST',
      url: `/api/automation/jobs/${job.id}/run`,
      headers: test.headers,
    });
    expect(response.statusCode).toBe(409);
  });
});

describe('automation run history', () => {
  it('pages newest first over a keyset cursor', async () => {
    const test = await start();
    const job = (
      await test.server.app.inject({
        method: 'POST',
        url: '/api/automation/jobs',
        headers: test.headers,
        payload: CRON_BODY,
      })
    ).json<AutomationJob>();

    // Straight into the store: these are rows the engine writes, and there is
    // no route that fabricates one.
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      ids.push(test.automation.startRun({ jobId: job.id }).id);
    }

    const first = await test.server.app.inject({
      method: 'GET',
      url: `/api/automation/jobs/${job.id}/runs?limit=2`,
      headers: test.headers,
    });
    expect(first.statusCode).toBe(200);
    const page = first.json<AutomationRunListResponse>();
    expect(page.runs).toHaveLength(2);
    expect(page.nextCursor).toBeDefined();

    const second = await test.server.app.inject({
      method: 'GET',
      url: `/api/automation/jobs/${job.id}/runs?limit=2&cursor=${encodeURIComponent(page.nextCursor ?? '')}`,
      headers: test.headers,
    });
    const rest = second.json<AutomationRunListResponse>();
    expect(rest.runs).toHaveLength(1);
    expect(rest.nextCursor).toBeUndefined();
    expect([...page.runs, ...rest.runs].map((r) => r.id).sort()).toEqual([...ids].sort());
  });

  it('refuses a cursor this server did not issue', async () => {
    const test = await start();
    const job = (
      await test.server.app.inject({
        method: 'POST',
        url: '/api/automation/jobs',
        headers: test.headers,
        payload: CRON_BODY,
      })
    ).json<AutomationJob>();

    const response = await test.server.app.inject({
      method: 'GET',
      url: `/api/automation/jobs/${job.id}/runs?cursor=not-a-cursor`,
      headers: test.headers,
    });
    expect(response.statusCode).toBe(400);
  });

  it('carries a run′s warnings through, so a caveat is visible without being a failure', async () => {
    const test = await start();
    const job = (
      await test.server.app.inject({
        method: 'POST',
        url: '/api/automation/jobs',
        headers: test.headers,
        payload: CRON_BODY,
      })
    ).json<AutomationJob>();

    const run = test.automation.startRun({ jobId: job.id });
    test.automation.finishRun(run.id, { status: 'ok', warnings: ['no channel is wired yet'] });

    const response = await test.server.app.inject({
      method: 'GET',
      url: `/api/automation/jobs/${job.id}/runs`,
      headers: test.headers,
    });
    expect(response.json<AutomationRunListResponse>().runs[0]).toMatchObject({
      status: 'ok',
      warnings: ['no channel is wired yet'],
    });
  });
});

describe('automation and the engine', () => {
  it('tells the scheduler to re-read after every write', async () => {
    // Without this a job created in the panel does not run until a restart.
    const scheduler = fakeScheduler();
    const test = await start({ scheduler });

    const job = (
      await test.server.app.inject({
        method: 'POST',
        url: '/api/automation/jobs',
        headers: test.headers,
        payload: CRON_BODY,
      })
    ).json<AutomationJob>();
    expect(scheduler.refreshes.count).toBe(1);

    await test.server.app.inject({
      method: 'PATCH',
      url: `/api/automation/jobs/${job.id}`,
      headers: test.headers,
      payload: { name: 'x' },
    });
    expect(scheduler.refreshes.count).toBe(2);

    await test.server.app.inject({
      method: 'DELETE',
      url: `/api/automation/jobs/${job.id}`,
      headers: test.headers,
    });
    expect(scheduler.refreshes.count).toBe(3);
  });

  it('re-reads after a settings save, so switching the engine on takes effect', async () => {
    const scheduler = fakeScheduler();
    const test = await start({ scheduler });

    await test.server.app.inject({
      method: 'PATCH',
      url: '/api/settings',
      headers: test.headers,
      payload: { scheduler: { concurrency: 4 } },
    });

    expect(scheduler.refreshes.count).toBe(1);
  });

  it('still serves the CRUD surface with no engine, so jobs can be authored first', async () => {
    const test = await start();
    const response = await test.server.app.inject({
      method: 'POST',
      url: '/api/automation/jobs',
      headers: test.headers,
      payload: CRON_BODY,
    });
    expect(response.statusCode).toBe(201);
  });
});

describe('automation auth', () => {
  it('refuses every route without a credential', async () => {
    const test = await start();
    for (const [method, url] of [
      ['GET', '/api/automation/jobs'],
      ['POST', '/api/automation/jobs'],
      ['GET', '/api/automation/jobs/x'],
      ['PATCH', '/api/automation/jobs/x'],
      ['DELETE', '/api/automation/jobs/x'],
      ['POST', '/api/automation/jobs/x/run'],
      ['GET', '/api/automation/jobs/x/runs'],
    ] as const) {
      const response = await test.server.app.inject({ method, url });
      expect(response.statusCode, `${method} ${url}`).toBe(401);
    }
  });
});
