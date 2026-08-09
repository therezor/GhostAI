import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  isGhostError,
  systemClock,
  type Clock,
  type GhostError,
} from '@ghostwire/core';

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

function stored(name: string): string {
  return readFileSync(join(root, 'memory', `${name}.md`), 'utf8');
}

function index(): string {
  return readFileSync(join(root, 'memory', 'MEMORY.md'), 'utf8');
}

function names(): string[] {
  return readdirSync(join(root, 'memory')).sort();
}

const NOTE = {
  name: 'ui-stack-preferences',
  description: 'no shadcn/ui; Tailwind in rem, not px',
  type: 'user',
  body: 'The user wants an explicit design token layer.',
};

describe('memory', () => {
  it('writes one file per fact, with its frontmatter', async () => {
    await text(memoryTool, NOTE);

    expect(stored('ui-stack-preferences')).toBe(
      [
        '---',
        'name: ui-stack-preferences',
        'description: no shadcn/ui; Tailwind in rem, not px',
        'metadata:',
        '  type: user',
        '---',
        '',
        'The user wants an explicit design token layer.',
        '',
      ].join('\n'),
    );
  });

  it('says where it went, so the model knows the next turn will carry it', async () => {
    const result = await text(memoryTool, NOTE);
    expect(result).toContain('memory/ui-stack-preferences.md');
    expect(result).toContain('Recorded');
  });

  it('indexes it, so the next prompt names it', async () => {
    await text(memoryTool, NOTE);
    expect(index()).toContain('(ui-stack-preferences.md)');
  });

  it('keeps two differently-named facts apart', async () => {
    await text(memoryTool, NOTE);
    await text(memoryTool, { ...NOTE, name: 'run-full-ci-gate' });

    expect(names()).toEqual([
      'MEMORY.md',
      'run-full-ci-gate.md',
      'ui-stack-preferences.md',
    ]);
  });

  it('replaces a fact written under a name it already used', async () => {
    // The whole of how a model corrects itself. Two contradictory memories with
    // nothing to say which is current is the failure this prevents.
    await text(memoryTool, { ...NOTE, body: 'The old answer.' });
    const second = await text(memoryTool, { ...NOTE, body: 'The new answer.' });

    expect(second).toContain('Replaced');
    expect(stored('ui-stack-preferences')).toContain('The new answer.');
    expect(stored('ui-stack-preferences')).not.toContain('The old answer.');
  });

  it('slugs a name a model typed as prose, and reports the one it used', async () => {
    const result = await text(memoryTool, {
      ...NOTE,
      name: 'Build Conventions',
    });

    expect(result).toContain('memory/build-conventions.md');
    expect(result).toContain('named `build-conventions`');
  });

  it('cannot be pointed outside the workspace by its name', async () => {
    // The guarantee taking no `path` used to give for free. A name is not a
    // path, but it does reach a filename, so the slug is what restores it.
    await text(memoryTool, { ...NOTE, name: '../../etc/passwd' });

    expect(names()).toEqual(['MEMORY.md', 'etc-passwd.md']);
  });

  it('reports a name with nothing usable in it rather than throwing', async () => {
    const result = toToolResult(
      await memoryTool.run({ ...NOTE, name: '???' }, context),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('Names are letters, digits and hyphens');
  });

  it('takes no path, so there is none to point outside the workspace', async () => {
    // The schema is strict, so the argument a caller would reach for to escape
    // the workspace is refused before `execute` runs at all.
    const error = await failure(memoryTool, {
      ...NOTE,
      path: '../../etc/passwd',
    });
    expect(error.kind).toBe('invalid_input');
  });

  it('refuses a kind outside the four', async () => {
    const error = await failure(memoryTool, { ...NOTE, type: 'whatever' });
    expect(error.kind).toBe('invalid_input');
  });

  it('refuses a body longer than the cap', async () => {
    // The format says one fact per file, and two thousand characters is already
    // several.
    const error = await failure(memoryTool, {
      ...NOTE,
      body: 'x'.repeat(2001),
    });
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
