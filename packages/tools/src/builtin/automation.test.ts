/**
 * The tool, over a stub port.
 *
 * What is asserted here is argument handling and the wording a model reads
 * back — the guards themselves live on the port and are tested where they are
 * enforced. The split matters: a tool that decided any of this would be
 * deciding it from arguments a model wrote.
 */

import { afterEach, describe, expect, it } from 'vitest';

import type { AutomationJob } from '@ghostai/protocol';
import type { AutomationOutcome, AutomationPort } from '../automation.js';
import { toToolResult, type ToolContext } from '../define.js';
import { createTestWorkspace, type TestWorkspace } from '../testkit/workspace.js';
import { automationTool } from './automation.js';

let workspace: TestWorkspace | undefined;

afterEach(() => {
  workspace?.dispose();
  workspace = undefined;
});

function job(over: Partial<AutomationJob> = {}): AutomationJob {
  return {
    id: 'job-1',
    name: 'Nightly build',
    schedule: { kind: 'cron', expr: '0 9 * * *' },
    payload: { kind: 'scheduled', message: 'check', deliver: false, targets: {} },
    enabled: true,
    deleteAfterRun: false,
    createdAtMs: 0,
    updatedAtMs: 0,
    state: { nextRunAtMs: 0, lastRunAtMs: 0, lastStatus: 'pending', lastError: '', runCount: 0 },
    ...over,
  };
}

interface Stub {
  readonly port: AutomationPort;
  readonly created: unknown[];
  readonly deleted: string[];
}

function stub(over: Partial<AutomationPort> = {}): Stub {
  const created: unknown[] = [];
  const deleted: string[] = [];
  return {
    created,
    deleted,
    port: {
      create: (input) => {
        created.push(input);
        return { ok: true, value: job({ name: input.name }) };
      },
      list: () => ({ ok: true, value: [job()] }),
      delete: (id) => {
        deleted.push(id);
        return { ok: true };
      },
      ...over,
    },
  };
}

function contextWith(port?: AutomationPort): ToolContext {
  workspace = createTestWorkspace();
  return { ...workspace.context, ...(port === undefined ? {} : { automation: port }) };
}

async function run(args: unknown, port?: AutomationPort): Promise<ReturnType<typeof toToolResult>> {
  return toToolResult(await automationTool.run(args, contextWith(port)));
}

describe('the automation tool', () => {
  it('advertises the two things a model gets wrong', async () => {
    // The current time is in the prompt already, and a zoneless cron is read in
    // the scheduler's zone rather than the host's — without which a model
    // writes `0 9 * * *` meaning local and the job fires at the wrong hour.
    expect(automationTool.description).toMatch(/current time is in your system prompt/iu);
    expect(automationTool.description).toMatch(/NOT the host zone/u);
  });

  it('is in the exec band, because of what it causes rather than what it does', () => {
    expect(automationTool.definition('builtin').risk).toBe('exec');
  });

  it('refuses unknown arguments rather than stripping them', async () => {
    await expect(
      automationTool.run({ action: 'list', wat: 1 }, contextWith(stub().port)),
    ).rejects.toThrow();
  });
});

describe('create', () => {
  it('maps every_minutes onto the interval schedule', async () => {
    const s = stub();
    await run({ action: 'create', name: 'x', message: 'go', every_minutes: 15 }, s.port);
    expect(s.created[0]).toMatchObject({ schedule: { kind: 'every', everyMs: 900_000 } });
  });

  it('maps cron and its zone', async () => {
    const s = stub();
    await run({ action: 'create', name: 'x', message: 'go', cron: '0 9 * * *', tz: 'UTC' }, s.port);
    expect(s.created[0]).toMatchObject({
      schedule: { kind: 'cron', expr: '0 9 * * *', tz: 'UTC' },
    });
  });

  it('omits an empty zone rather than sending a blank one', async () => {
    const s = stub();
    await run({ action: 'create', name: 'x', message: 'go', cron: '0 9 * * *', tz: '  ' }, s.port);
    expect(s.created[0]).not.toHaveProperty('schedule.tz');
  });

  it('maps an ISO instant onto a one-shot, which self-destructs by default', async () => {
    const s = stub();
    await run({ action: 'create', name: 'x', message: 'go', at: '2026-08-01T09:00:00Z' }, s.port);
    expect(s.created[0]).toMatchObject({
      schedule: { kind: 'at', atMs: Date.parse('2026-08-01T09:00:00Z') },
      deleteAfterRun: true,
    });
  });

  it('refuses two schedules rather than picking one', async () => {
    // Choosing silently is how a job ends up on a schedule nobody wrote.
    const s = stub();
    const result = await run(
      { action: 'create', name: 'x', message: 'go', every_minutes: 5, cron: '0 9 * * *' },
      s.port,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/only one/u);
    expect(s.created).toHaveLength(0);
  });

  it('refuses none at all', async () => {
    const s = stub();
    const result = await run({ action: 'create', name: 'x', message: 'go' }, s.port);
    expect(result.isError).toBe(true);
    expect(s.created).toHaveLength(0);
  });

  it('refuses an at that is not an instant', async () => {
    const s = stub();
    const result = await run(
      { action: 'create', name: 'x', message: 'go', at: 'tomorrow' },
      s.port,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/ISO instant/u);
  });

  it('requires a name and a message', async () => {
    const s = stub();
    expect((await run({ action: 'create', message: 'go', every_minutes: 5 }, s.port)).isError).toBe(
      true,
    );
    expect((await run({ action: 'create', name: 'x', every_minutes: 5 }, s.port)).isError).toBe(
      true,
    );
    expect(s.created).toHaveLength(0);
  });

  it('coerces a stringified number, because models emit them', async () => {
    const s = stub();
    await run({ action: 'create', name: 'x', message: 'go', every_minutes: '15' }, s.port);
    expect(s.created[0]).toMatchObject({ schedule: { kind: 'every', everyMs: 900_000 } });
  });
});

describe('refusals a model has to be able to act on', () => {
  const refusing = (outcome: AutomationOutcome<never>): AutomationPort => ({
    create: () => outcome,
    list: () => outcome,
    delete: () => outcome,
  });

  it('tells a scheduled run to do the work rather than schedule it', async () => {
    const result = await run(
      { action: 'create', name: 'x', message: 'go', every_minutes: 5 },
      refusing({ ok: false, refusal: 'nested' }),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/Do the work now instead/u);
  });

  it('tells an agent at capacity to delete one first', async () => {
    const result = await run(
      { action: 'create', name: 'x', message: 'go', every_minutes: 5 },
      refusing({ ok: false, refusal: 'at-capacity' }),
    );
    expect(result.content).toMatch(/Delete one before creating another/u);
  });

  it('passes the validator′s own sentence through', async () => {
    const result = await run(
      { action: 'create', name: 'x', message: 'go', cron: '99 * * * *' },
      refusing({ ok: false, refusal: 'unschedulable', detail: 'minute must be between 0 and 59.' }),
    );
    expect(result.content).toMatch(/minute must be between 0 and 59/u);
  });

  it('says so when the install has no scheduler at all, rather than pretending', async () => {
    const result = await run({ action: 'create', name: 'x', message: 'go', every_minutes: 5 });
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/no scheduler/u);
  });
});

describe('list and delete', () => {
  it('reads back jobs in a form a model can then delete by id', async () => {
    const result = await run({ action: 'list' }, stub().port);
    expect(result.content).toContain('job-1');
    expect(result.content).toContain('Nightly build');
  });

  it('says plainly when there are none', async () => {
    const result = await run(
      { action: 'list' },
      stub({ list: () => ({ ok: true, value: [] }) }).port,
    );
    expect(result.content).toBe('You have no scheduled jobs.');
    expect(result.isError).toBeUndefined();
  });

  it('marks a disabled job, so the model does not report it as live', async () => {
    const result = await run(
      { action: 'list' },
      stub({ list: () => ({ ok: true, value: [job({ enabled: false })] }) }).port,
    );
    expect(result.content).toContain('(disabled)');
  });

  it('deletes by id', async () => {
    const s = stub();
    const result = await run({ action: 'delete', job_id: 'job-1' }, s.port);
    expect(s.deleted).toEqual(['job-1']);
    expect(result.isError).toBeUndefined();
  });

  it('requires an id to delete', async () => {
    const s = stub();
    expect((await run({ action: 'delete' }, s.port)).isError).toBe(true);
    expect(s.deleted).toHaveLength(0);
  });
});
