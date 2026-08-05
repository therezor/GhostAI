import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  isGhostError,
  systemClock,
  type Clock,
  type GhostError,
} from '@ghostai/core';

import { toToolResult, type AnyTool, type ToolContext } from '#src/define.js';
import { memoryTool } from '#src/builtin/memory.js';
import { skillTool } from '#src/builtin/skill.js';
import { createTestWorkspace, type TestWorkspace } from '#testkit/workspace.js';

let workspace: TestWorkspace;
let context: ToolContext;
let root: string;

/** Fixed, so a dated heading is a string a test can write down. */
const AUGUST_FIFTH = Date.parse('2026-08-05T09:00:00Z');

/** The real clock with the wall time pinned — `now` is all this tool reads. */
function at(ms: number): Clock {
  return { ...systemClock, now: () => ms };
}

beforeEach(() => {
  workspace = createTestWorkspace();
  context = { ...workspace.context, clock: at(AUGUST_FIFTH) };
  root = workspace.root;
});

afterEach(() => {
  workspace.dispose();
});

async function text(
  tool: AnyTool,
  args: unknown,
  ctx = context,
): Promise<string> {
  return toToolResult(await tool.run(args, ctx)).content;
}

async function failure(
  tool: AnyTool,
  args: unknown,
  ctx = context,
): Promise<GhostError> {
  const error = await tool.run(args, ctx).then(
    () => null,
    (value: unknown) => value,
  );
  if (!isGhostError(error)) {
    throw new Error(`expected a GhostError, got ${String(error)}`);
  }
  return error;
}

function memory(): string {
  return readFileSync(join(root, 'memory', 'memory.md'), 'utf8');
}

describe('memory', () => {
  it('appends under a dated heading', async () => {
    await text(memoryTool, { note: '- Prefers rem over px.' });

    expect(memory()).toBe('## Session 2026-08-05\n\n- Prefers rem over px.\n');
  });

  it('says where it went, so the model knows the next turn will carry it', async () => {
    const result = await text(memoryTool, { note: '- A fact.' });
    expect(result).toContain('memory/memory.md');
  });

  it('adds to what is there rather than replacing it', async () => {
    // The property that makes this not a worse `write_file`: two calls are two
    // notes, and the first cannot be lost by the second.
    await text(memoryTool, { note: '- The first.' });
    await text(memoryTool, { note: '- The second.' });

    expect(memory()).toContain('- The first.');
    expect(memory()).toContain('- The second.');
  });

  it('opens a new section when the day has moved on', async () => {
    await text(memoryTool, { note: '- Monday.' });
    await text(
      memoryTool,
      { note: '- Wednesday.' },
      { ...context, clock: at(Date.parse('2026-08-07T09:00:00Z')) },
    );

    expect(memory()).toContain('## Session 2026-08-05');
    expect(memory()).toContain('## Session 2026-08-07');
  });

  it('leaves prose above the first heading untouched', async () => {
    mkdirSync(join(root, 'memory'), { recursive: true });
    writeFileSync(
      join(root, 'memory', 'memory.md'),
      'Always deploy with `make release`.\n',
    );

    await text(memoryTool, { note: '- A fact.' });

    expect(memory()).toContain('Always deploy with `make release`.');
  });

  it('takes no path, so there is none to point outside the workspace', async () => {
    // The schema is strict, so the argument a caller would reach for to escape
    // the workspace is refused before `execute` runs at all. This is the whole
    // reason the tool is not a worse `write_file`.
    const error = await failure(memoryTool, {
      note: '- A fact.',
      path: '../../etc/passwd',
    });
    expect(error.kind).toBe('invalid_input');
  });

  it('refuses a note longer than the cap', async () => {
    // Memory is read on every turn, so an unbounded note is a cost paid forever.
    const error = await failure(memoryTool, { note: 'x'.repeat(2001) });
    expect(error.kind).toBe('invalid_input');
  });
});

describe('skill', () => {
  function install(name: string, body: string): void {
    const dir = join(root, 'skills', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), body);
  }

  it('returns the sheet', async () => {
    install('deploy', '---\ndescription: Ship it.\n---\n\nRun make release.\n');

    await expect(text(skillTool, { name: 'deploy' })).resolves.toContain(
      'Run make release.',
    );
  });

  it('reports a skill that is not there rather than throwing something opaque', async () => {
    const error = await failure(skillTool, { name: 'nope' });
    expect(error.message).toContain('skills/nope/SKILL.md');
  });

  it('cannot be pointed outside the workspace by its name', async () => {
    // The jail *clamps* rather than refuses, so the interesting assertion is
    // not that this errors — it is that the path it resolved stays inside, and
    // a file planted outside is unreachable through the name.
    writeFileSync(join(root, '..', 'secret.md'), 'not yours');

    const error = await failure(skillTool, { name: '../../..' });

    // Clamped to `SKILL.md` at the workspace root: every `..` was absorbed, so
    // nothing above the jail is addressable through the skill name.
    expect(error.message).not.toContain('..');
    expect(error.message).not.toContain('not yours');
  });
});
