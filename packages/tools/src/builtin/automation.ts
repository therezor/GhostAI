/**
 * `automation` — scheduling work the agent will do later.
 *
 * The one built-in that acts on the *future* rather than on the workspace, and
 * the one an agent does not get by default: it is absent from
 * `DEFAULT_AGENT_TOOLS`, so a new agent cannot reach it at all until an operator
 * grants it. That asymmetry is deliberate. A single approved `exec` runs once;
 * a single approved `automation` create runs forever, unattended, on a timer.
 *
 * **The model's surface is a strict subset of the operator's.** It can create,
 * list and delete — not update, not run on demand, not enable or disable. The
 * missing verb that matters is `update`: repointing an existing job's payload is
 * the one edit nobody watches happen, and an agent that could do it would be
 * able to turn "post the weather" into anything at all without the row ever
 * looking new.
 *
 * Everything this tool cannot be trusted with lives on the other side of
 * `AutomationPort`, which the composition root binds to the calling agent and
 * session: ownership, the per-agent cap, the refusal to schedule from inside a
 * scheduled run, and **which agent the scheduled turn runs as**. The tool passes
 * arguments a model wrote; it does not get to say who it is, and so it does not
 * get to say who the job will be.
 */

import { z } from 'zod';

import type {
  AutomationJob,
  AutomationSchedule,
  CreateAutomationJob,
} from '@ghostwire/protocol';

import type { AutomationOutcome, AutomationRefusal } from '../automation.js';
import {
  assertNotAborted,
  defineTool,
  type AnyTool,
  type ToolResult,
} from '../define.js';

const schema = z.strictObject({
  action: z
    .enum(['create', 'list', 'delete'])
    .describe(
      'create schedules a job, list shows the ones you made, delete removes one.',
    ),
  name: z
    .string()
    .optional()
    .describe('Short label for the job. Required to create.'),
  message: z
    .string()
    .optional()
    .describe(
      'What to ask the agent when the job fires, written as if you were typing it into a new conversation that has no history. Self-contained: spell out what a reader who was not here would need. Required to create.',
    ),
  every_minutes: z.coerce
    .number()
    .int()
    .positive()
    .optional()
    .describe('Repeat this often. Counted from the end of the previous run.'),
  cron: z
    .string()
    .optional()
    .describe(
      'A 5-field cron expression: minute hour day-of-month month day-of-week.',
    ),
  at: z
    .string()
    .optional()
    .describe(
      'ISO instant for a one-off, such as 2026-08-01T09:00:00Z. Compute it yourself.',
    ),
  delete_after_run: z
    .boolean()
    .optional()
    .describe('Remove the job once it has fired. Use for a one-off reminder.'),
  job_id: z
    .string()
    .optional()
    .describe('Which job to delete. Required to delete.'),
});

/**
 * The description does three jobs beyond saying what the tool is.
 *
 * It points at the current time already in the system prompt rather than
 * restating it, it says which clock a cron expression is read against, and it
 * says that the run starts in a *fresh session*.
 *
 * That second sentence used to warn that a zoneless cron and the prompt's clock
 * disagreed, and to tell the model to pass `tz` when it meant local. There is no
 * `tz` now: one install-wide `ui.timezone` reads every expression and renders
 * every timestamp, so the warning has become a promise. It is still worth
 * stating — a model that has been trained on the old advice will otherwise
 * convert an hour it did not need to convert.
 *
 * The third is the one whose absence looked like the model not understanding the
 * tool. A scheduled run gets its own `automation:{jobId}` session and cannot see
 * the conversation that created it, so `message: "do the thing we discussed"`
 * schedules a turn that has no idea what the thing is — and the failure lands a
 * week later, on somebody who was not there. Nothing in the tool's surface said
 * so, and a model has no way to discover it: the create succeeds, and the first
 * run is the only evidence.
 */
const DESCRIPTION = [
  'Schedule work for later, list what you have scheduled, or cancel it.',
  'To create, give a name, a message, and exactly one of: every_minutes, cron, or at.',
  'The current time is in your system prompt — compute an "at" instant from it yourself.',
  'A cron expression is read in the install timezone, which is the zone named beside the current time in your prompt; write the hour you mean on that clock and do not convert it.',
  'The job runs in a fresh conversation that cannot see this one, so write the message so it stands alone — name the files, people and facts it needs instead of referring back to what was said here.',
  'You only ever see and delete jobs you created yourself.',
].join(' ');

/** What went wrong, in words a model can act on rather than retry blindly. */
const REFUSAL_TEXT: Readonly<Record<AutomationRefusal, string>> = {
  nested:
    'Refused: this turn is itself a scheduled run, and a job may not schedule more jobs. Do the work now instead.',
  'at-capacity':
    'Refused: you already hold as many scheduled jobs as you may. Delete one before creating another.',
  'not-yours': 'Refused: no such job, or it was not one you created.',
  unschedulable: 'Refused: that schedule cannot be honoured.',
};

function refused(outcome: AutomationOutcome<unknown>): ToolResult {
  const refusal = outcome.refusal ?? 'unschedulable';
  const detail = outcome.detail === undefined ? '' : ` ${outcome.detail}`;
  return { content: `${REFUSAL_TEXT[refusal]}${detail}`, isError: true };
}

/**
 * The three schedule shapes, as exactly one.
 *
 * Refused rather than resolved by precedence when a model sends two: picking
 * one silently is how a job ends up on a schedule nobody wrote, and the model
 * can simply be told to choose.
 */
function toSchedule(
  args: z.output<typeof schema>,
): AutomationSchedule | string {
  const given = [
    args.every_minutes !== undefined,
    args.cron !== undefined,
    args.at !== undefined,
  ];
  const count = given.filter(Boolean).length;
  if (count === 0) return 'Give exactly one of every_minutes, cron or at.';
  if (count > 1) {
    return 'Give only one of every_minutes, cron or at, not several.';
  }

  if (args.every_minutes !== undefined) {
    return { kind: 'every', everyMs: args.every_minutes * 60_000 };
  }
  if (args.cron !== undefined) {
    return { kind: 'cron', expr: args.cron.trim() };
  }

  const atMs = Date.parse(args.at ?? '');
  if (Number.isNaN(atMs)) {
    return 'at must be an ISO instant, such as 2026-08-01T09:00:00Z.';
  }
  return { kind: 'at', atMs };
}

/**
 * A schedule in the words the model wrote it in.
 *
 * No timezone anywhere, and that is not an omission. An `every` is a duration, a
 * cron is echoed back verbatim as the operator's zone will read it, and an
 * instant is ISO — which is unambiguous on its own. The tool has no zone to
 * render in and should not grow one: the model's prompt already names the
 * install's, beside a current time in both forms.
 */
function scheduleOf(schedule: AutomationSchedule): string {
  if (schedule.kind === 'every') {
    return `every ${String(schedule.everyMs / 60_000)} min`;
  }
  if (schedule.kind === 'cron') return `cron "${schedule.expr}"`;
  return `once at ${isoOf(schedule.atMs)}`;
}

/** An instant the model can compare against the clock in its own prompt. */
function isoOf(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * One job as a line a model can read back and act on.
 *
 * The schedule and the next run are on it because without them this tool has no
 * feedback loop. It used to print `id — name`, which is enough to delete a job
 * and not enough to answer "what is scheduled?", to notice that a cron was read
 * differently than it was meant, or to see that a one-shot has already fired.
 * A model that cannot check its own work re-creates it instead.
 */
function detailOf(job: AutomationJob): string {
  const next =
    job.state.nextRunAtMs === 0
      ? 'not scheduled'
      : `next ${isoOf(job.state.nextRunAtMs)}`;
  return `${scheduleOf(job.schedule)} · ${next}${job.enabled ? '' : ' · disabled'}`;
}

function describe(job: AutomationJob): string {
  return `${job.id} — ${job.name} · ${detailOf(job)}`;
}

export const automationTool: AnyTool = defineTool({
  name: 'automation',
  description: DESCRIPTION,
  schema,
  // The band, not the act. Creating a job runs nothing itself; what it grants is
  // an agent turn happening later without anyone watching, which is a larger
  // grant than one command, not a smaller one.
  risk: 'exec',
  annotations: { title: 'Scheduled jobs' },
  execute(args, context) {
    assertNotAborted(context.signal, 'automation');

    const port = context.automation;
    if (port === undefined) {
      return {
        content:
          'Refused: this installation has no scheduler, so nothing can be scheduled.',
        isError: true,
      };
    }

    if (args.action === 'list') {
      const listed = port.list();
      if (!listed.ok) return refused(listed);
      const jobs = listed.value ?? [];
      return jobs.length === 0
        ? 'You have no scheduled jobs.'
        : `Your scheduled jobs:\n${jobs.map(describe).join('\n')}`;
    }

    if (args.action === 'delete') {
      const jobId = args.job_id?.trim() ?? '';
      if (jobId === '') {
        return { content: 'Give job_id to delete.', isError: true };
      }
      const removed = port.delete(jobId);
      return removed.ok ? `Deleted ${jobId}.` : refused(removed);
    }

    const name = args.name?.trim() ?? '';
    const message = args.message?.trim() ?? '';
    if (name === '') {
      return { content: 'Give a name to create a job.', isError: true };
    }
    if (message === '') {
      return { content: 'Give a message to create a job.', isError: true };
    }

    const schedule = toSchedule(args);
    if (typeof schedule === 'string') {
      return { content: schedule, isError: true };
    }

    const input: CreateAutomationJob = {
      name,
      schedule,
      payload: { kind: 'scheduled', message, deliver: false, targets: {} },
      enabled: true,
      deleteAfterRun: args.delete_after_run ?? schedule.kind === 'at',
    };

    const created = port.create(input);
    if (!created.ok || created.value === undefined) return refused(created);
    // The resolved first run, not an echo of the arguments. A cron the model
    // meant as 9am local and the scheduler read as something else is only
    // visible here, on the one line the model reads before telling the user it
    // is done — and it is the difference between a wrong job it can fix in the
    // same turn and one that surprises somebody a week later.
    return `Scheduled "${created.value.name}" (${created.value.id}) · ${detailOf(created.value)}`;
  },
});
