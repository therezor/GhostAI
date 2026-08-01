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
    // The current time is in the prompt already, and the clock printed beside
    // it *is* the zone a cron is read in — so the hour the model writes is the
    // hour it sees. Saying so is what stops a model trained on the old advice
    // from converting an offset it no longer needs to convert.
    expect(automationTool.description).toMatch(/current time is in your system prompt/iu);
    expect(automationTool.description).toMatch(/install timezone/u);
    expect(automationTool.description).toMatch(/do not convert it/u);
  });

  it('warns that the run cannot see this conversation', async () => {
    // The gap that looked like the model not understanding the tool: nothing in
    // the surface said the job gets its own session, so "do the thing we
    // discussed" scheduled a turn with no idea what the thing was — and the
    // create succeeded, so there was no signal until the run a week later.
    expect(automationTool.description).toMatch(/fresh conversation that cannot see this one/u);
    const message = automationTool.definition('builtin').parameters.properties;
    expect(JSON.stringify(message)).toMatch(/no history/u);
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

  it('maps cron onto a schedule with no zone of its own', async () => {
    const s = stub();
    await run({ action: 'create', name: 'x', message: 'go', cron: '0 9 * * *' }, s.port);
    expect(s.created[0]).toMatchObject({ schedule: { kind: 'cron', expr: '0 9 * * *' } });
    expect(s.created[0]).not.toHaveProperty('schedule.tz');
  });

  it('refuses a tz argument rather than accepting one it would ignore', async () => {
    // The parameter is gone, and the schema is strict. A model that has learned
    // to pass `tz` is told, instead of having it silently dropped and getting a
    // job on a clock it did not ask for.
    const s = stub();
    await expect(
      automationTool.run(
        { action: 'create', name: 'x', message: 'go', cron: '0 9 * * *', tz: 'UTC' },
        contextWith(s.port),
      ),
    ).rejects.toThrow();
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
    expect(result.content).toContain('disabled');
  });

  it('says when each job runs, so the model can answer what is scheduled', async () => {
    // `id — name` alone is enough to delete a job and not enough to check one.
    // A model that cannot see that its cron was read as 09:00 has no way to
    // notice it meant 21:00, and no reason not to schedule a second one.
    const result = await run(
      { action: 'list' },
      stub({
        list: () => ({
          ok: true,
          value: [
            job({ state: { ...job().state, nextRunAtMs: Date.parse('2026-08-02T09:00:00Z') } }),
          ],
        }),
      }).port,
    );
    expect(result.content).toContain('cron "0 9 * * *"');
    expect(result.content).toContain('next 2026-08-02T09:00:00Z');
  });

  it('reports a fired one-shot as unscheduled rather than as due now', async () => {
    // `nextRunAtMs: 0` is the store's "nothing more to do". Printed raw it would
    // render as 1970, which a model reads as overdue.
    const result = await run({ action: 'list' }, stub().port);
    expect(result.content).toContain('not scheduled');
    expect(result.content).not.toContain('1970');
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
