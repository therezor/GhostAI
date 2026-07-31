/**
 * The Scheduled jobs page and the job editor, through the real router.
 *
 * Assertions are on what went over the wire, not on what the screen says
 * afterwards — the same rule the rest of the CRUD screens follow, and the
 * reason a page that renders correctly while sending the wrong body cannot
 * pass here.
 *
 * The in-flight wording lives in this file rather than in the e2e suite on
 * purpose: "a run is pending" is exactly the transient state `CLAUDE.md`
 * forbids asserting against a real server, and here the state can be held still
 * by simply not answering.
 */

import { RouterProvider, createMemoryHistory } from '@tanstack/react-router';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { ConfigSchema, type AutomationJob, type AutomationRun } from '@ghostai/protocol';

import { Providers } from '@/app/providers.js';
import { createAppRouter } from '@/app/router.js';
import { stubApi, testQueryClient, type RecordedRequest, type StubRoute } from '@/test/render.js';
import { STATUS } from '@/test/fixtures.js';

const CONFIG = ConfigSchema.parse({});
const SETTINGS = { config: CONFIG, credentialsPresent: {} };

const CRON_JOB: AutomationJob = {
  id: 'job-1',
  name: 'Nightly build',
  schedule: { kind: 'cron', expr: '0 9 * * *', tz: 'UTC' },
  payload: { kind: 'scheduled', message: 'check the build', deliver: false, targets: {} },
  enabled: true,
  deleteAfterRun: false,
  createdAtMs: 1,
  updatedAtMs: 1,
  state: {
    nextRunAtMs: 1_800_000_000_000,
    lastRunAtMs: 1_700_000_000_000,
    lastStatus: 'ok',
    lastError: '',
    runCount: 3,
  },
};

const RUN: AutomationRun = {
  id: 'run-1',
  jobId: 'job-1',
  startedAtMs: 1_700_000_000_000,
  finishedAtMs: 1_700_000_060_000,
  status: 'ok',
  output: 'the build is green',
  warnings: [],
};

const AGENTS = {
  agents: [
    { id: 'default', label: 'Default', model: 'llama3', provider: 'ollama' },
    { id: 'reviewer', label: 'Reviewer', model: 'llama3', provider: 'ollama' },
  ],
};

const SHELL_ROUTES: Record<string, StubRoute> = {
  '/api/auth/me': [200, { authenticated: true, authEnabled: false }],
  '/api/setup': [200, { required: false }],
  '/api/status': [200, STATUS],
  '/api/sessions': [200, { sessions: [] }],
  '/api/notifications': [200, { notifications: [], unreadCount: 0 }],
};

function mount(
  path = '/automation',
  overrides: Record<string, StubRoute> = {},
): {
  readonly user: ReturnType<typeof userEvent.setup>;
  readonly calls: RecordedRequest[];
  readonly router: ReturnType<typeof createAppRouter>;
} {
  const calls = stubApi({
    ...SHELL_ROUTES,
    '/api/settings': [200, SETTINGS],
    'PATCH /api/settings': [200, SETTINGS],
    '/api/agents': [200, AGENTS],
    '/api/automation/jobs': [200, { jobs: [CRON_JOB] }],
    '/api/automation/jobs/job-1/runs': [200, { runs: [RUN] }],
    ...overrides,
  });

  const user = userEvent.setup();
  const router = createAppRouter();
  router.update({ history: createMemoryHistory({ initialEntries: [path] }) });
  render(
    <Providers client={testQueryClient()}>
      <RouterProvider router={router} />
    </Providers>,
  );

  return { user, calls, router };
}

const writesOf = (calls: RecordedRequest[]): RecordedRequest[] =>
  calls.filter((call) => call.method !== 'GET');

describe('the sidebar', () => {
  it('carries Scheduled jobs, before Settings', async () => {
    const { router } = mount('/');
    const nav = await screen.findByRole('navigation');
    const labels = within(nav)
      .getAllByRole('link')
      .map((link) => link.textContent);

    const jobs = labels.findIndex((label) => label.includes('Scheduled jobs'));
    const settings = labels.findIndex((label) => label.includes('Settings'));
    expect(jobs).toBeGreaterThanOrEqual(0);
    expect(jobs).toBeLessThan(settings);
    expect(router.state.location.pathname).toBe('/');
  });
});

describe('the Scheduled jobs page', () => {
  it('shows a job with its schedule, its last outcome and when it runs next', async () => {
    mount();
    const row = within(await screen.findByRole('list', { name: 'Scheduled jobs' })).getByRole(
      'listitem',
    );

    expect(row).toHaveTextContent('Nightly build');
    expect(row).toHaveTextContent('0 9 * * * (UTC)');
    // A word, not a colour: the one encoding some readers do not receive.
    expect(row).toHaveTextContent('Succeeded');
    expect(row).toHaveTextContent('Enabled');
  });

  it('filters the list without asking the server again', async () => {
    const { user, calls } = mount();
    await screen.findByRole('list', { name: 'Scheduled jobs' });
    const before = calls.length;

    await user.type(await screen.findByLabelText('Filter jobs'), 'nothing');

    expect(await screen.findByText(/No job matches/u)).toBeInTheDocument();
    expect(calls).toHaveLength(before);
  });

  it('says so plainly when there are no jobs at all', async () => {
    mount('/automation', { '/api/automation/jobs': [200, { jobs: [] }] });
    expect(await screen.findByText('No scheduled jobs yet.')).toBeInTheDocument();
  });

  it('surfaces a load failure rather than rendering an empty list', async () => {
    mount('/automation', {
      '/api/automation/jobs': [500, { error: { code: 'internal', message: 'boom' } }],
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load automation');
  });

  it('opens the create page rather than a dialog', async () => {
    const { user, router } = mount();

    await user.click(await screen.findByRole('link', { name: 'New job' }));

    expect(router.state.location.pathname).toBe('/automation/new');
  });

  it('duplicates a job switched off, whatever the original was', async () => {
    // Two jobs on one schedule is almost never what a duplicate is for, and the
    // copy firing alongside its source is the surprising half.
    const { user, calls } = mount('/automation', {
      'POST /api/automation/jobs': [201, { ...CRON_JOB, id: 'job-2' }],
    });

    await user.click(await screen.findByRole('button', { name: 'Actions for Nightly build' }));
    await user.click(screen.getByRole('menuitem', { name: 'Duplicate' }));

    await waitFor(() => {
      expect(writesOf(calls)).toHaveLength(1);
    });
    const body = writesOf(calls)[0]?.body as AutomationJob;
    expect(body.name).toBe('Nightly build copy');
    expect(body.enabled).toBe(false);
    expect(body.schedule).toEqual(CRON_JOB.schedule);
  });

  it('toggles a job without asking, because switching it back is one click', async () => {
    const { user, calls } = mount('/automation', {
      'PATCH /api/automation/jobs/job-1': [200, CRON_JOB],
    });

    await user.click(await screen.findByRole('button', { name: 'Actions for Nightly build' }));
    await user.click(screen.getByRole('menuitem', { name: 'Disable' }));

    await waitFor(() => {
      expect(writesOf(calls)).toHaveLength(1);
    });
    expect(writesOf(calls)[0]).toMatchObject({
      method: 'PATCH',
      path: '/api/automation/jobs/job-1',
      body: { enabled: false },
    });
  });

  it('asks before deleting, and sends nothing until it is confirmed', async () => {
    const { user, calls } = mount('/automation', {
      'DELETE /api/automation/jobs/job-1': [204, null],
    });

    await user.click(await screen.findByRole('button', { name: 'Actions for Nightly build' }));
    await user.click(screen.getByRole('menuitem', { name: 'Delete' }));
    expect(writesOf(calls)).toHaveLength(0);

    await user.click(await screen.findByRole('button', { name: 'Delete', hidden: false }));
    await waitFor(() => {
      expect(writesOf(calls).some((call) => call.method === 'DELETE')).toBe(true);
    });
  });

  it('starts a run on demand', async () => {
    const { user, calls } = mount('/automation', {
      'POST /api/automation/jobs/job-1/run': [202, CRON_JOB],
    });

    await user.click(await screen.findByRole('button', { name: 'Actions for Nightly build' }));
    await user.click(screen.getByRole('menuitem', { name: 'Run now' }));

    await waitFor(() => {
      expect(writesOf(calls)).toHaveLength(1);
    });
    expect(writesOf(calls)[0]?.path).toBe('/api/automation/jobs/job-1/run');
  });
});

describe('the create page', () => {
  it('is the same form as the editor, seeded empty', async () => {
    mount('/automation/new');

    // Every field the editor has.
    expect(await screen.findByLabelText('Name')).toHaveValue('');
    expect(screen.getByLabelText('Cron expression')).toBeInTheDocument();
    expect(screen.getByLabelText('Agent')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeInTheDocument();
  });

  it('writes nothing until Save', async () => {
    // The whole reason this is a route rather than the dialog it replaced: the
    // dialog POSTed a job with an invented message the moment it was submitted,
    // so abandoning the form left that row behind.
    const { user, calls } = mount('/automation/new');

    await user.type(await screen.findByLabelText('Name'), 'Half-written');
    await user.click(screen.getByRole('link', { name: 'Back to Automation' }));

    expect(writesOf(calls)).toHaveLength(0);
  });

  it('has no Run now and no run history, because there is no job yet', async () => {
    mount('/automation/new');

    await screen.findByLabelText('Name');
    expect(screen.queryByRole('button', { name: 'Run now' })).not.toBeInTheDocument();
    expect(screen.queryByText('Runs')).not.toBeInTheDocument();
  });

  it('POSTs on Save and lands on the job it made', async () => {
    const { user, calls, router } = mount('/automation/new', {
      'POST /api/automation/jobs': [201, CRON_JOB],
    });

    await user.type(await screen.findByLabelText('Name'), 'Nightly build');
    await user.type(screen.getByLabelText('Message'), 'check the build');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => {
      expect(writesOf(calls)).toHaveLength(1);
    });
    expect(writesOf(calls)[0]).toMatchObject({ method: 'POST', path: '/api/automation/jobs' });
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/automation/job-1');
    });
  });

  it('refuses an incomplete form without sending anything', async () => {
    // A name but no message. `SaveBar` keeps Save disabled until something has
    // been typed, so an untouched form cannot reach validation at all — which
    // is why this types one field and leaves the other.
    const { user, calls } = mount('/automation/new');

    await user.type(await screen.findByLabelText('Name'), 'Half-written');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(await screen.findAllByRole('alert')).not.toHaveLength(0);
    expect(writesOf(calls)).toHaveLength(0);
  });
});

describe('the job editor', () => {
  it('opens on a job and shows the fields its schedule kind has', async () => {
    mount('/automation/job-1');

    expect(await screen.findByLabelText('Cron expression')).toHaveValue('0 9 * * *');
    // The other kinds' boxes are absent, not disabled: two controls describing
    // one thing is a state the schema itself refuses.
    expect(screen.queryByLabelText('Every (minutes)')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Runs at')).not.toBeInTheDocument();
  });

  it('offers the real agents rather than a free-text box', async () => {
    mount('/automation/job-1');
    const agent = await screen.findByLabelText('Agent');

    expect(agent).toHaveTextContent('Default agent');
    await userEvent.setup().click(agent);
    expect(await screen.findByRole('option', { name: 'Reviewer' })).toBeInTheDocument();
  });

  it('shows a bound agent that no longer exists rather than reading as the default', async () => {
    // The binding is still stored, and hiding it would make the editor lie
    // about what will run.
    mount('/automation/job-1', {
      '/api/automation/jobs': [
        200,
        {
          jobs: [
            {
              ...CRON_JOB,
              payload: { ...CRON_JOB.payload, agentId: 'departed' },
            },
          ],
        },
      ],
    });

    expect(await screen.findByLabelText('Agent')).toHaveTextContent('no longer exists');
  });

  it('offers the scheduler default as the timezone, not a blank box', async () => {
    mount('/automation/job-1', {
      '/api/automation/jobs': [
        200,
        { jobs: [{ ...CRON_JOB, schedule: { kind: 'cron', expr: '0 9 * * *' } }] },
      ],
    });

    expect(await screen.findByLabelText('Timezone')).toHaveTextContent('Scheduler default');
  });

  it('says so on a stale link rather than showing an empty form', async () => {
    mount('/automation/gone');
    expect(await screen.findByRole('alert')).toHaveTextContent('There is no job called');
  });

  it('sends only what the operator changed', async () => {
    const { user, calls } = mount('/automation/job-1', {
      'PATCH /api/automation/jobs/job-1': [200, CRON_JOB],
    });

    const expr = await screen.findByLabelText('Cron expression');
    await user.clear(expr);
    await user.type(expr, '30 6 * * 1-5');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => {
      expect(writesOf(calls)).toHaveLength(1);
    });
    expect((writesOf(calls)[0]?.body as AutomationJob).schedule).toEqual({
      kind: 'cron',
      expr: '30 6 * * 1-5',
      tz: 'UTC',
    });
  });

  it('renders the server′s validation message against the field', async () => {
    // The shape check here is five fields; everything past that is the server's
    // answer, and its sentence is the whole value of the response.
    const { user, calls } = mount('/automation/job-1', {
      'PATCH /api/automation/jobs/job-1': [
        422,
        { error: { code: 'bad_request', message: 'minute must be between 0 and 59' } },
      ],
    });

    const expr = await screen.findByLabelText('Cron expression');
    await user.clear(expr);
    await user.type(expr, '99 * * * *');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => {
      expect(writesOf(calls)).toHaveLength(1);
    });
    expect(await screen.findByText(/minute must be between 0 and 59/u)).toBeInTheDocument();
  });

  it('shows a run′s outcome and its output', async () => {
    mount('/automation/job-1');
    expect(await screen.findByText('the build is green')).toBeInTheDocument();
  });

  it('shows a warning as a caveat rather than as a failure', async () => {
    // A run that asked for delivery on an install with no channel succeeded.
    // Rendering it as an error would say a working job is broken.
    mount('/automation/job-1', {
      '/api/automation/jobs/job-1/runs': [
        200,
        { runs: [{ ...RUN, warnings: ['no channel is wired yet'] }] },
      ],
    });

    expect(await screen.findByText(/no channel is wired yet/u)).toBeInTheDocument();
    expect(screen.getAllByText('Succeeded').length).toBeGreaterThan(0);
  });

  it('holds the in-flight wording still, which e2e cannot', async () => {
    mount('/automation/job-1', {
      '/api/automation/jobs/job-1/runs': [
        200,
        { runs: [{ id: 'r2', jobId: 'job-1', startedAtMs: 1, status: 'pending', warnings: [] }] },
      ],
    });
    expect(await screen.findByText('Pending')).toBeInTheDocument();
  });

  it('switches which payload fields exist when the kind changes', async () => {
    const { user } = mount('/automation/job-1');

    expect(await screen.findByLabelText('Message')).toBeInTheDocument();
    await user.click(screen.getByRole('combobox', { name: 'What it does' }));
    await user.click(await screen.findByRole('option', { name: 'Read a task file and decide' }));

    expect(await screen.findByLabelText('Task file')).toBeInTheDocument();
    expect(screen.queryByLabelText('Message')).not.toBeInTheDocument();
  });
});
