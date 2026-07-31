/**
 * A scheduled job as a form, and back again.
 *
 * Pure, and every field is a `string` — the house rule from `fields.ts`, and
 * this form is the case that makes it obvious: an interval typed in minutes
 * passes through `12.` and `` on the way to `12`, and neither is a number. The
 * conversion happens once, on save.
 *
 * **Cron is validated by shape here and by the server for real.** Five
 * non-empty fields is all this checks. Importing `parseCron` from
 * `@ghostai/core` would agree with the server exactly — and would drag
 * `node:sqlite` into the browser bundle, which `self-contained.test.ts` exists
 * to prevent. The server answers a 422 naming the field, the panel renders it,
 * and then shows the server's own `state.nextRunAtMs` as a date — which is
 * better feedback than a validity flag anyway, because it says *when*.
 */

import type { TFunction } from 'i18next';
import type {
  AutomationJob,
  AutomationSchedule,
  CreateAutomationJob,
  UpdateAutomationJob,
} from '@ghostai/protocol';

import { parseNumber } from '@/settings/fields.js';

/**
 * The value the timezone select uses for "whatever the scheduler is set to".
 *
 * A sentinel rather than an empty string, for the reason the agent select uses
 * one: a Radix select reads `''` as "nothing chosen" and renders a blank
 * trigger, which looks broken. The form still stores `''`, and the wire still
 * omits `tz` — this exists only between the two.
 */
export const DEFAULT_TZ_OPTION = '__scheduler_default__';

/**
 * Every zone this runtime knows, or a usable subset when it does not say.
 *
 * `Intl.supportedValuesOf` is the whole IANA list and needs no data of our own,
 * which matters: a bundled timezone table would be a copy of something the
 * platform already has and would go stale on its own schedule. The fallback
 * covers a runtime without it — the list is short and deliberately not a guess
 * at what the operator wants, since UTC is always first and always correct.
 */
export function timezoneNames(): readonly string[] {
  try {
    const supported = Intl.supportedValuesOf('timeZone');
    return supported.length > 0 ? supported : FALLBACK_ZONES;
  } catch {
    return FALLBACK_ZONES;
  }
}

const FALLBACK_ZONES: readonly string[] = [
  'UTC',
  'Europe/London',
  'Europe/Berlin',
  'Europe/Kyiv',
  'America/New_York',
  'America/Chicago',
  'America/Los_Angeles',
  'Asia/Tokyo',
  'Asia/Shanghai',
  'Asia/Kolkata',
  'Australia/Sydney',
];

/**
 * The zones a select offers, with UTC pinned to the top.
 *
 * UTC is the default for a reason — a server's own zone moves when the server
 * does — so it is the one entry that should not have to be scrolled to.
 */
export function timezoneOptions(): readonly string[] {
  const rest = timezoneNames().filter((zone) => zone !== 'UTC');
  return ['UTC', ...rest];
}

export type ScheduleKind = AutomationSchedule['kind'];
export type PayloadKind = AutomationJob['payload']['kind'];

/** Every field a string, converted once on save. */
export interface JobForm {
  readonly name: string;
  readonly enabled: boolean;
  readonly deleteAfterRun: boolean;
  readonly scheduleKind: ScheduleKind;
  /** `datetime-local` value, for an `at` schedule. */
  readonly at: string;
  /** Minutes, for an `every` schedule. Minutes rather than ms — nobody types 300000. */
  readonly everyMinutes: string;
  readonly cronExpr: string;
  readonly cronTz: string;
  readonly payloadKind: PayloadKind;
  readonly message: string;
  readonly file: string;
  readonly model: string;
  readonly agentId: string;
  readonly sessionKey: string;
  readonly deliver: boolean;
  readonly channel: string;
  readonly to: string;
}

export type JobFormResult =
  | {
      readonly ok: true;
      readonly create: CreateAutomationJob;
      readonly update: UpdateAutomationJob;
    }
  | { readonly ok: false; readonly errors: Readonly<Record<string, string>> };

const MINUTE_MS = 60_000;

/** `datetime-local` wants local wall-clock with no zone, to the minute. */
export function toLocalInput(epochMs: number): string {
  const date = new Date(epochMs);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function emptyJobForm(): JobForm {
  return {
    name: '',
    enabled: true,
    deleteAfterRun: false,
    scheduleKind: 'cron',
    at: toLocalInput(Date.now() + 60 * MINUTE_MS),
    everyMinutes: '60',
    cronExpr: '0 9 * * *',
    cronTz: '',
    payloadKind: 'scheduled',
    message: '',
    file: 'TASK.md',
    model: '',
    agentId: '',
    sessionKey: '',
    deliver: false,
    channel: '',
    to: '',
  };
}

export function toJobForm(job: AutomationJob): JobForm {
  const empty = emptyJobForm();
  const { schedule, payload } = job;

  return {
    ...empty,
    name: job.name,
    enabled: job.enabled,
    deleteAfterRun: job.deleteAfterRun,
    scheduleKind: schedule.kind,
    ...(schedule.kind === 'at' ? { at: toLocalInput(schedule.atMs) } : {}),
    ...(schedule.kind === 'every' ? { everyMinutes: String(schedule.everyMs / MINUTE_MS) } : {}),
    ...(schedule.kind === 'cron' ? { cronExpr: schedule.expr, cronTz: schedule.tz ?? '' } : {}),
    payloadKind: payload.kind,
    ...(payload.kind === 'scheduled' ? { message: payload.message } : {}),
    ...(payload.kind === 'heartbeat' ? { file: payload.file, model: payload.model ?? '' } : {}),
    agentId: payload.agentId ?? '',
    sessionKey: payload.sessionKey ?? '',
    deliver: payload.deliver,
    channel: payload.channel ?? '',
    to: payload.to ?? '',
  };
}

function buildSchedule(
  form: JobForm,
  t: TFunction,
):
  | { readonly ok: true; readonly schedule: AutomationSchedule }
  | { readonly ok: false; readonly errors: Record<string, string> } {
  if (form.scheduleKind === 'at') {
    const atMs = Date.parse(form.at);
    if (Number.isNaN(atMs)) {
      return { ok: false, errors: { at: t('settings.fields.required') } };
    }
    return { ok: true, schedule: { kind: 'at', atMs } };
  }

  if (form.scheduleKind === 'every') {
    const minutes = parseNumber(form.everyMinutes, t, { min: 1, integer: true });
    if (!minutes.ok) return { ok: false, errors: { everyMinutes: minutes.error } };
    return { ok: true, schedule: { kind: 'every', everyMs: minutes.value * MINUTE_MS } };
  }

  const expr = form.cronExpr.trim();
  // Shape only — see the header. The server owns the real answer.
  const fields = expr.split(/\s+/u).filter(Boolean);
  if (fields.length !== 5) {
    return { ok: false, errors: { cronExpr: 'A cron expression has five fields.' } };
  }
  const tz = form.cronTz.trim();
  return { ok: true, schedule: { kind: 'cron', expr, ...(tz === '' ? {} : { tz }) } };
}

/**
 * The form as the two request bodies it can become.
 *
 * Both at once, because they are the same object minus what the server assigns
 * — building them separately is how a field gets added to create and forgotten
 * on update.
 */
export function toJobRequest(form: JobForm, t: TFunction): JobFormResult {
  const errors: Record<string, string> = {};

  const name = form.name.trim();
  if (name === '') errors.name = t('settings.fields.required');

  const schedule = buildSchedule(form, t);
  if (!schedule.ok) Object.assign(errors, schedule.errors);

  if (form.payloadKind === 'scheduled' && form.message.trim() === '') {
    errors.message = t('settings.fields.required');
  }
  if (form.payloadKind === 'heartbeat' && form.file.trim() === '') {
    errors.file = t('settings.fields.required');
  }
  // A delivery with nowhere to go is a job that looks configured and is not.
  if (form.deliver && form.channel.trim() === '') {
    errors.channel = t('settings.fields.required');
  }

  if (Object.keys(errors).length > 0 || !schedule.ok) return { ok: false, errors };

  const optional = {
    ...(form.agentId.trim() === '' ? {} : { agentId: form.agentId.trim() }),
    ...(form.sessionKey.trim() === '' ? {} : { sessionKey: form.sessionKey.trim() }),
    ...(form.channel.trim() === '' ? {} : { channel: form.channel.trim() }),
    ...(form.to.trim() === '' ? {} : { to: form.to.trim() }),
  };

  const payload: AutomationJob['payload'] =
    form.payloadKind === 'scheduled'
      ? {
          kind: 'scheduled',
          message: form.message.trim(),
          deliver: form.deliver,
          targets: {},
          ...optional,
        }
      : {
          kind: 'heartbeat',
          file: form.file.trim(),
          deliver: form.deliver,
          targets: {},
          ...(form.model.trim() === '' ? {} : { model: form.model.trim() }),
          ...optional,
        };

  const body = {
    name,
    schedule: schedule.schedule,
    payload,
    enabled: form.enabled,
    deleteAfterRun: form.deleteAfterRun,
  };

  return { ok: true, create: body, update: body };
}

/** A schedule as one line, for the list. */
export function describeSchedule(schedule: AutomationSchedule): string {
  switch (schedule.kind) {
    case 'at':
      return `Once, at ${new Date(schedule.atMs).toLocaleString()}`;
    case 'every': {
      const minutes = schedule.everyMs / MINUTE_MS;
      return minutes === 1 ? 'Every minute' : `Every ${String(minutes)} minutes`;
    }
    case 'cron':
      return schedule.tz === undefined ? schedule.expr : `${schedule.expr} (${schedule.tz})`;
  }
}
