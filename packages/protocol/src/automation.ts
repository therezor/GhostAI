/**
 * Automation jobs.
 *
 * Schedules and payloads are discriminated unions rather than a `kind` field
 * beside every variant's fields defaulted to null. The flat shape makes
 * `{kind: 'cron', atMs: 5}` representable and forces a null check on `expr`
 * even where `kind` already proves it is set; here each variant carries exactly
 * its own fields and an impossible combination fails to parse.
 *
 * The variants are **strict** rather than key-stripping, which is what makes
 * that last clause true: the default `z.object` would silently drop the stray
 * `atMs` from a cron schedule, turning an importer bug or a hand-edited job into
 * a job that quietly runs on the wrong trigger. These are our own persisted
 * shapes, so an unknown key is always a defect worth surfacing.
 */

import { z } from 'zod';

/** One-shot, at an absolute epoch-ms instant. */
export const AtScheduleSchema = z.strictObject({
  kind: z.literal('at'),
  atMs: z.number().int().nonnegative(),
});

/** Fixed interval. */
export const EveryScheduleSchema = z.strictObject({
  kind: z.literal('every'),
  everyMs: z.number().int().positive(),
});

/** Standard 5-field cron, evaluated in `tz` (IANA name; host zone if absent). */
export const CronScheduleSchema = z.strictObject({
  kind: z.literal('cron'),
  expr: z.string().min(1),
  tz: z.string().optional(),
});

export const AutomationScheduleSchema = z.discriminatedUnion('kind', [
  AtScheduleSchema,
  EveryScheduleSchema,
  CronScheduleSchema,
]);
export type AutomationSchedule = z.infer<typeof AutomationScheduleSchema>;

/**
 * Where a job's output goes. Shared by both payload kinds.
 *
 * `deliver: false` still runs the turn — the result lands in the job's run
 * history and the notification centre without interrupting anyone.
 */
const deliveryFields = {
  deliver: z.boolean().default(false),
  /** Channel id, e.g. `telegram`. Required in practice when `deliver` is set. */
  channel: z.string().optional(),
  /** Channel-specific destination (chat id, user id, room). */
  to: z.string().optional(),
  /**
   * Overrides the isolated `automation:{jobId}:{runId}` session. Setting this
   * is what makes a nightly job grow an unbounded context window, so the
   * default of "fresh session per run" is deliberate.
   */
  sessionKey: z.string().optional(),
  agentId: z.string().optional(),
  /** Additional channel id → address fan-out. */
  targets: z.record(z.string(), z.string()).default({}),
};

export const AutomationDeliverySchema = z.object(deliveryFields);
export type AutomationDelivery = z.infer<typeof AutomationDeliverySchema>;

/**
 * Sends a fixed message to the agent.
 *
 * Spelled out with `strictObject` over the shared delivery fields rather than
 * `AutomationDeliverySchema.extend(...)`, because `extend` inherits the base's
 * key-stripping behaviour and the point here is to reject a `file` on a
 * scheduled payload instead of dropping it.
 */
export const ScheduledPayloadSchema = z.strictObject({
  ...deliveryFields,
  kind: z.literal('scheduled'),
  message: z.string().min(1),
});

/**
 * Reads a markdown file and lets a cheap model decide whether to act.
 *
 * The decide/run/evaluate triad is why heartbeats aren't annoying: a forced
 * `heartbeat` tool call returns `skip` or `run`, and after a run the output is
 * evaluated again for whether it's worth interrupting the user.
 */
export const HeartbeatPayloadSchema = z.strictObject({
  ...deliveryFields,
  kind: z.literal('heartbeat'),
  /** Path relative to the workspace. */
  file: z.string().min(1).default('TASK.md'),
  model: z.string().optional(),
});

export const AutomationPayloadSchema = z.discriminatedUnion('kind', [
  ScheduledPayloadSchema,
  HeartbeatPayloadSchema,
]);
export type AutomationPayload = z.infer<typeof AutomationPayloadSchema>;

export const RunStatusSchema = z.enum(['pending', 'ok', 'error', 'skipped']);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const AutomationJobStateSchema = z.object({
  /** 0 when unscheduled (disabled, or a fired one-shot). */
  nextRunAtMs: z.number().int().nonnegative().default(0),
  lastRunAtMs: z.number().int().nonnegative().default(0),
  lastStatus: RunStatusSchema.default('pending'),
  lastError: z.string().default(''),
  runCount: z.number().int().nonnegative().default(0),
});
export type AutomationJobState = z.infer<typeof AutomationJobStateSchema>;

export const AutomationJobSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  schedule: AutomationScheduleSchema,
  payload: AutomationPayloadSchema,
  state: AutomationJobStateSchema.prefault({}),
  enabled: z.boolean().default(true),
  createdAtMs: z.number().int().nonnegative().default(0),
  updatedAtMs: z.number().int().nonnegative().default(0),
  /** Self-destruct after firing — how a one-shot reminder cleans up. */
  deleteAfterRun: z.boolean().default(false),
});
export type AutomationJob = z.infer<typeof AutomationJobSchema>;

/**
 * A single execution. Persisted as real rows rather than collapsing into
 * last-run-only state, so the UI can show a history and a nightly job that
 * failed three days ago is still diagnosable.
 */
export const AutomationRunSchema = z.object({
  id: z.string().min(1),
  jobId: z.string().min(1),
  startedAtMs: z.number().int().nonnegative(),
  finishedAtMs: z.number().int().nonnegative().optional(),
  status: RunStatusSchema,
  /** Set when the heartbeat model chose `skip`. */
  skipReason: z.string().optional(),
  error: z.string().optional(),
  output: z.string().optional(),
  sessionKey: z.string().optional(),
});
export type AutomationRun = z.infer<typeof AutomationRunSchema>;

/** Job creation over REST. Server assigns `id`, timestamps and `state`. */
export const CreateAutomationJobSchema = z.object({
  name: z.string().min(1),
  schedule: AutomationScheduleSchema,
  payload: AutomationPayloadSchema,
  enabled: z.boolean().default(true),
  deleteAfterRun: z.boolean().default(false),
});
export type CreateAutomationJob = z.infer<typeof CreateAutomationJobSchema>;

export const UpdateAutomationJobSchema = z.object({
  name: z.string().min(1).optional(),
  schedule: AutomationScheduleSchema.optional(),
  payload: AutomationPayloadSchema.optional(),
  enabled: z.boolean().optional(),
  deleteAfterRun: z.boolean().optional(),
});
export type UpdateAutomationJob = z.infer<typeof UpdateAutomationJobSchema>;
