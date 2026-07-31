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
 * session: ownership, the per-agent cap, and the refusal to schedule from inside
 * a scheduled run. The tool passes arguments a model wrote; it does not get to
 * say who it is.
 */

import { z } from 'zod';

import type { AutomationSchedule, CreateAutomationJob } from '@ghostai/protocol';

import type { AutomationOutcome, AutomationRefusal } from '../automation.js';
import { assertNotAborted, defineTool, type AnyTool, type ToolResult } from '../define.js';

const schema = z.strictObject({
  action: z
    .enum(['create', 'list', 'delete'])
    .describe('create schedules a job, list shows the ones you made, delete removes one.'),
  name: z.string().optional().describe('Short label for the job. Required to create.'),
  message: z
    .string()
    .optional()
    .describe(
      'What to ask the agent when the job fires, written as if you were typing it. Required to create.',
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
    .describe('A 5-field cron expression: minute hour day-of-month month day-of-week.'),
  tz: z
    .string()
    .optional()
    .describe('IANA zone for the cron expression, such as Europe/Kyiv. See the description.'),
  at: z
    .string()
    .optional()
    .describe('ISO instant for a one-off, such as 2026-08-01T09:00:00Z. Compute it yourself.'),
  delete_after_run: z
    .boolean()
    .optional()
    .describe('Remove the job once it has fired. Use for a one-off reminder.'),
  job_id: z.string().optional().describe('Which job to delete. Required to delete.'),
});

/**
 * The description does two jobs beyond saying what the tool is.
 *
 * It points at the current time already in the system prompt rather than
 * restating it, and it says what a cron with no zone means — because the prompt
 * shows the *host* zone and a zoneless cron is read in the scheduler's, which
 * defaults to UTC. Without that sentence a model writes `0 9 * * *` meaning
 * local and the job fires at the wrong hour, silently and forever.
 */
const DESCRIPTION = [
  'Schedule work for later, list what you have scheduled, or cancel it.',
  'To create, give a name, a message, and exactly one of: every_minutes, cron, or at.',
  'The current time is in your system prompt — compute an "at" instant from it yourself.',
  'A cron expression with no tz is read in the scheduler default zone, which is usually UTC and is NOT the host zone shown in your prompt; pass tz when the time is meant locally.',
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
function toSchedule(args: z.output<typeof schema>): AutomationSchedule | string {
  const given = [args.every_minutes !== undefined, args.cron !== undefined, args.at !== undefined];
  const count = given.filter(Boolean).length;
  if (count === 0) return 'Give exactly one of every_minutes, cron or at.';
  if (count > 1) return 'Give only one of every_minutes, cron or at, not several.';

  if (args.every_minutes !== undefined) {
    return { kind: 'every', everyMs: args.every_minutes * 60_000 };
  }
  if (args.cron !== undefined) {
    const tz = args.tz?.trim() ?? '';
    return { kind: 'cron', expr: args.cron.trim(), ...(tz === '' ? {} : { tz }) };
  }

  const atMs = Date.parse(args.at ?? '');
  if (Number.isNaN(atMs)) return 'at must be an ISO instant, such as 2026-08-01T09:00:00Z.';
  return { kind: 'at', atMs };
}

/** One job as a line a model can read back and act on. */
function describe(job: { id: string; name: string; enabled: boolean }): string {
  return `${job.id} — ${job.name}${job.enabled ? '' : ' (disabled)'}`;
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
        content: 'Refused: this installation has no scheduler, so nothing can be scheduled.',
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
      if (jobId === '') return { content: 'Give job_id to delete.', isError: true };
      const removed = port.delete(jobId);
      return removed.ok ? `Deleted ${jobId}.` : refused(removed);
    }

    const name = args.name?.trim() ?? '';
    const message = args.message?.trim() ?? '';
    if (name === '') return { content: 'Give a name to create a job.', isError: true };
    if (message === '') return { content: 'Give a message to create a job.', isError: true };

    const schedule = toSchedule(args);
    if (typeof schedule === 'string') return { content: schedule, isError: true };

    const input: CreateAutomationJob = {
      name,
      schedule,
      payload: { kind: 'scheduled', message, deliver: false, targets: {} },
      enabled: true,
      deleteAfterRun: args.delete_after_run ?? schedule.kind === 'at',
    };

    const created = port.create(input);
    if (!created.ok || created.value === undefined) return refused(created);
    return `Scheduled "${created.value.name}" (${created.value.id}).`;
  },
});
