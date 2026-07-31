/**
 * Scheduled jobs, in a browser, against the real stack.
 *
 * The unit suites already prove the pieces: the cron parser lands on the right
 * instant, the store pages, the engine coalesces a boot backlog, the form
 * builds the right body. What only a browser can show is that they are wired to
 * each other — that a job written in the panel reaches the store with a
 * schedule the timer can honour, and that pressing "Run now" produces a real
 * turn through the real hub against the real loop.
 *
 * **Every assertion is on durable state read back through the API.** A run's
 * `pending` badge, a spinner, a toast — all of those are the transient states
 * the repo rule was written about, and the one that broke CI four runs running.
 * The durable facts here are: the job exists with the schedule it was given,
 * and a run has *settled* into a terminal status.
 */

import type { Page } from '@playwright/test';

import { expect, test } from '../fixtures.js';

interface JobView {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly schedule: { readonly kind: string; readonly expr?: string; readonly tz?: string };
  readonly payload: { readonly kind: string; readonly message?: string };
  readonly state: { readonly nextRunAtMs: number; readonly lastStatus: string };
}

interface RunView {
  readonly id: string;
  readonly status: string;
  readonly output?: string;
}

const jobsOf = async (app: Page, url: string): Promise<JobView[]> => {
  const response = await app.request.get(`${url}/api/automation/jobs`);
  return ((await response.json()) as { jobs: JobView[] }).jobs;
};

const runsOf = async (app: Page, url: string, jobId: string): Promise<RunView[]> => {
  const response = await app.request.get(`${url}/api/automation/jobs/${jobId}/runs`);
  return ((await response.json()) as { runs: RunView[] }).runs;
};

/** Seeded through the API, never the UI — the spec under test is the panel. */
async function seedJob(
  app: Page,
  url: string,
  over: Record<string, unknown> = {},
): Promise<JobView> {
  const response = await app.request.post(`${url}/api/automation/jobs`, {
    data: {
      name: 'Nightly build',
      // Far enough out that the timer cannot fire it mid-spec and make the run
      // list a moving target.
      schedule: { kind: 'cron', expr: '0 9 1 1 *', tz: 'UTC' },
      payload: { kind: 'scheduled', message: 'say hello' },
      ...over,
    },
  });
  return (await response.json()) as JobView;
}

const jobRow = (app: Page, name: string) =>
  app.getByRole('list', { name: 'Scheduled jobs' }).getByRole('listitem').filter({ hasText: name });

test('Scheduled jobs is a page, reached from the sidebar before Settings', async ({
  app,
  harness,
}) => {
  await app.goto(harness.url);

  const nav = app.getByRole('navigation');
  await nav.getByRole('link', { name: 'Scheduled jobs' }).click();

  await expect(app).toHaveURL(/\/automation$/u);
  await expect(app.getByRole('link', { name: 'New job' })).toBeVisible();
});

test('the engine settings are in Settings, and the jobs are not', async ({ app, harness }) => {
  // The split: install-wide knobs are a settings panel, the jobs an operator
  // keeps are a page. Settings → Automation must hold the first and none of
  // the second.
  await app.goto(`${harness.url}/settings?panel=automation`);

  await expect(app.getByLabel('Concurrent runs')).toBeVisible();
  await expect(app.getByRole('list', { name: 'Scheduled jobs' })).toHaveCount(0);
  await expect(app.getByRole('link', { name: 'New job' })).toHaveCount(0);
});

test('creating a job writes it to the store, from the create page', async ({ app, harness }) => {
  await app.goto(`${harness.url}/automation`);

  await app.getByRole('link', { name: 'New job' }).click();
  await expect(app).toHaveURL(/\/automation\/new$/u);

  await app.getByLabel('Name').fill('Nightly build');
  await app.getByLabel('Message').fill('check the build');
  await app.getByRole('button', { name: 'Save changes' }).click();

  // Durable: the row exists in the store, with what was typed rather than with
  // anything a dialog invented.
  await expect
    .poll(async () => (await jobsOf(app, harness.url)).map((job) => job.name))
    .toEqual(['Nightly build']);
  await expect
    .poll(async () => (await jobsOf(app, harness.url))[0]?.payload.message)
    .toBe('check the build');
});

test('an abandoned create writes nothing at all', async ({ app, harness }) => {
  // The reason create is a page rather than the dialog it replaced: that dialog
  // POSTed a job with an invented message the moment it was submitted.
  await app.goto(`${harness.url}/automation/new`);
  await app.getByLabel('Name').fill('Never finished');
  await app.getByRole('link', { name: 'Back to Automation' }).click();

  await expect(app).toHaveURL(/\/automation$/u);
  expect(await jobsOf(app, harness.url)).toHaveLength(0);
});

test('editing the schedule saves it and the engine recomputes when it fires', async ({
  app,
  harness,
}) => {
  const seeded = await seedJob(app, harness.url);
  await app.goto(`${harness.url}/automation/${seeded.id}`);

  await app.getByLabel('Cron expression').fill('30 6 * * 1-5');
  await app.getByRole('button', { name: 'Save changes' }).click();

  await expect
    .poll(async () => (await jobsOf(app, harness.url))[0]?.schedule.expr)
    .toBe('30 6 * * 1-5');
  // The engine's own answer, which is what proves the parser ran server-side
  // rather than the string simply being stored.
  await expect
    .poll(async () => (await jobsOf(app, harness.url))[0]?.state.nextRunAtMs)
    .toBeGreaterThan(0);
});

test('a cron expression the server cannot honour is refused, and the job is unchanged', async ({
  app,
  harness,
}) => {
  const seeded = await seedJob(app, harness.url);
  await app.goto(`${harness.url}/automation/${seeded.id}`);

  // Five fields, so the panel's shape check passes it — and nonsense, so the
  // server's parser is the thing that refuses.
  await app.getByLabel('Cron expression').fill('99 * * * *');
  await app.getByRole('button', { name: 'Save changes' }).click();

  // The durable fact, and the only one asserted here: the refusal left the
  // stored schedule alone. The error *message* is a toast — it fades, and it is
  // announced in a live region as well as drawn, so matching its text picks up
  // two nodes and fails under load in a way it does not alone. That wording is
  // covered in `automation-panel.test.tsx`, where the state holds still.
  await expect
    .poll(async () => (await jobsOf(app, harness.url))[0]?.schedule.expr)
    .toBe('0 9 1 1 *');
});

test('running a job on demand produces a real turn that settles', async ({ app, harness }) => {
  const seeded = await seedJob(app, harness.url);
  await app.goto(`${harness.url}/automation`);

  await jobRow(app, 'Nightly build')
    .getByRole('button', { name: /Actions for/u })
    .click();
  await app.getByRole('menuitem', { name: 'Run now' }).click();

  // The durable end state, never the `pending` it passes through: the run row
  // reaching a terminal status is what says the hub, the loop and the store
  // were all actually wired to each other.
  await expect
    .poll(async () => (await runsOf(app, harness.url, seeded.id))[0]?.status, { timeout: 15_000 })
    .toBe('ok');
  await expect
    .poll(async () => (await runsOf(app, harness.url, seeded.id))[0]?.output)
    .not.toBe('');
  // And the job's own state carries the outcome, which is what the list shows.
  await expect.poll(async () => (await jobsOf(app, harness.url))[0]?.state.lastStatus).toBe('ok');
});

test('a run leaves a session that is reachable but not in the sidebar', async ({
  app,
  harness,
}) => {
  // ~105,000 sessions a year from one five-minute job is why they are excluded
  // from the unscoped listing — and they still have to be openable afterwards.
  const seeded = await seedJob(app, harness.url);
  await app.request.post(`${harness.url}/api/automation/jobs/${seeded.id}/run`);

  await expect
    .poll(async () => (await runsOf(app, harness.url, seeded.id))[0]?.status, { timeout: 15_000 })
    .toBe('ok');

  const unscoped = await app.request.get(`${harness.url}/api/sessions`);
  const listed = ((await unscoped.json()) as { sessions: { origin: string }[] }).sessions;
  expect(listed.some((session) => session.origin === 'automation')).toBe(false);

  const scoped = await app.request.get(`${harness.url}/api/sessions?origin=automation`);
  const automation = ((await scoped.json()) as { sessions: unknown[] }).sessions;
  expect(automation.length).toBeGreaterThan(0);
});

test('deleting a job takes its history with it', async ({ app, harness }) => {
  const seeded = await seedJob(app, harness.url);
  await app.goto(`${harness.url}/automation`);

  await jobRow(app, 'Nightly build')
    .getByRole('button', { name: /Actions for/u })
    .click();
  await app.getByRole('menuitem', { name: 'Delete' }).click();
  await app.getByRole('button', { name: 'Delete' }).last().click();

  await expect.poll(async () => (await jobsOf(app, harness.url)).length).toBe(0);
  const runs = await app.request.get(`${harness.url}/api/automation/jobs/${seeded.id}/runs`);
  expect(runs.status()).toBe(404);
});

test('the scheduler settings save and take effect without a restart', async ({ app, harness }) => {
  await app.goto(`${harness.url}/settings?panel=automation`);

  await app.getByLabel('Concurrent runs').fill('4');
  await app.getByRole('button', { name: 'Save changes' }).click();

  await expect
    .poll(async () => {
      const response = await app.request.get(`${harness.url}/api/settings`);
      const body = (await response.json()) as {
        config: { scheduler: { concurrency: number } };
      };
      return body.config.scheduler.concurrency;
    })
    .toBe(4);
});
