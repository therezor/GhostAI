/**
 * The form ⇄ wire conversion, as pure functions.
 *
 * Everything interesting about this form is a conversion — minutes to
 * milliseconds, a `datetime-local` string to an instant, a schedule kind to
 * which fields exist — and none of it needs a DOM to be wrong in.
 */

import { describe, expect, it } from 'vitest';

import { createWebI18n } from '@ghostai/i18n/web';
import type { AutomationJob } from '@ghostai/protocol';

import { describeSchedule, emptyJobForm, toJobForm, toJobRequest } from './job-form.js';

const t = createWebI18n('en').getFixedT(null, 'web');

function job(over: Partial<AutomationJob> = {}): AutomationJob {
  return {
    id: 'j1',
    name: 'Morning',
    schedule: { kind: 'cron', expr: '0 9 * * *', tz: 'UTC' },
    payload: { kind: 'scheduled', message: 'check the build', deliver: false, targets: {} },
    enabled: true,
    deleteAfterRun: false,
    createdAtMs: 0,
    updatedAtMs: 0,
    state: { nextRunAtMs: 0, lastRunAtMs: 0, lastStatus: 'pending', lastError: '', runCount: 0 },
    ...over,
  };
}

describe('toJobForm', () => {
  it('reads a cron schedule into its own fields', () => {
    const form = toJobForm(job());
    expect(form).toMatchObject({ scheduleKind: 'cron', cronExpr: '0 9 * * *', cronTz: 'UTC' });
  });

  it('shows an interval in minutes, which is what people type', () => {
    const form = toJobForm(job({ schedule: { kind: 'every', everyMs: 900_000 } }));
    expect(form).toMatchObject({ scheduleKind: 'every', everyMinutes: '15' });
  });

  it('reads a heartbeat payload into the file and model boxes', () => {
    const form = toJobForm(
      job({
        payload: {
          kind: 'heartbeat',
          file: 'NOTES.md',
          model: 'tiny',
          deliver: false,
          targets: {},
        },
      }),
    );
    expect(form).toMatchObject({ payloadKind: 'heartbeat', file: 'NOTES.md', model: 'tiny' });
  });

  it('leaves the boxes for the other kind at their defaults rather than blank', () => {
    // Switching kind in the editor must not land on an empty required field
    // that the operator never saw.
    const form = toJobForm(job({ schedule: { kind: 'every', everyMs: 60_000 } }));
    expect(form.cronExpr).toBe(emptyJobForm().cronExpr);
  });
});

describe('toJobRequest', () => {
  it('converts minutes to milliseconds once, on save', () => {
    const result = toJobRequest(
      { ...emptyJobForm(), name: 'x', scheduleKind: 'every', everyMinutes: '15', message: 'go' },
      t,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.create.schedule).toEqual({ kind: 'every', everyMs: 900_000 });
  });

  it('never emits a field belonging to another schedule kind', () => {
    // The schema refuses `{kind: 'cron', atMs: 5}`, and so must the form —
    // otherwise a save fails with a validation error the operator cannot see
    // the cause of.
    const result = toJobRequest(
      { ...emptyJobForm(), name: 'x', scheduleKind: 'cron', message: 'go' },
      t,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.create.schedule).sort()).toEqual(['expr', 'kind']);
  });

  it('omits an empty timezone rather than sending a blank one', () => {
    const result = toJobRequest({ ...emptyJobForm(), name: 'x', cronTz: '   ', message: 'go' }, t);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.create.schedule).not.toHaveProperty('tz');
  });

  it('refuses a cron expression that is not five fields, before the round trip', () => {
    const result = toJobRequest(
      { ...emptyJobForm(), name: 'x', cronExpr: '0 9 *', message: 'go' },
      t,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.cronExpr).toMatch(/five fields/u);
  });

  it('leaves anything past the field count to the server', () => {
    // The shape check is deliberately shallow: importing the real parser would
    // drag `node:sqlite` into the browser bundle. `99 * * * *` is five fields
    // and nonsense, and the server's 422 is what says so.
    const result = toJobRequest(
      { ...emptyJobForm(), name: 'x', cronExpr: '99 * * * *', message: 'go' },
      t,
    );
    expect(result.ok).toBe(true);
  });

  it('requires a name, a message and a task file where each applies', () => {
    const noName = toJobRequest({ ...emptyJobForm(), message: 'go' }, t);
    expect(noName.ok).toBe(false);

    const noMessage = toJobRequest({ ...emptyJobForm(), name: 'x' }, t);
    expect(noMessage.ok).toBe(false);
    if (noMessage.ok) return;
    expect(noMessage.errors.message).toBeDefined();

    const noFile = toJobRequest(
      { ...emptyJobForm(), name: 'x', payloadKind: 'heartbeat', file: ' ' },
      t,
    );
    expect(noFile.ok).toBe(false);
  });

  it('refuses delivery with no channel, rather than saving a job that cannot deliver', () => {
    const result = toJobRequest({ ...emptyJobForm(), name: 'x', message: 'go', deliver: true }, t);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.channel).toBeDefined();
  });

  it('omits every optional string it was given empty', () => {
    const result = toJobRequest({ ...emptyJobForm(), name: 'x', message: 'go' }, t);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const key of ['agentId', 'sessionKey', 'channel', 'to']) {
      expect(result.create.payload).not.toHaveProperty(key);
    }
  });

  it('round-trips a job unchanged through the form', () => {
    const original = job({ schedule: { kind: 'every', everyMs: 300_000 } });
    const result = toJobRequest(toJobForm(original), t);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.create.schedule).toEqual(original.schedule);
    expect(result.create.payload).toEqual(original.payload);
    expect(result.create.name).toBe(original.name);
  });
});

describe('describeSchedule', () => {
  it('says each kind in a way a list row can carry', () => {
    expect(describeSchedule({ kind: 'every', everyMs: 60_000 })).toBe('Every minute');
    expect(describeSchedule({ kind: 'every', everyMs: 300_000 })).toBe('Every 5 minutes');
    expect(describeSchedule({ kind: 'cron', expr: '0 9 * * *' })).toBe('0 9 * * *');
    expect(describeSchedule({ kind: 'cron', expr: '0 9 * * *', tz: 'UTC' })).toBe(
      '0 9 * * * (UTC)',
    );
    expect(describeSchedule({ kind: 'at', atMs: 0 })).toMatch(/^Once, at /u);
  });
});
