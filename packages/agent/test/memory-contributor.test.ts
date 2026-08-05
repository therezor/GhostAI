import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { saveMemory, type Memory } from '@ghostai/core';
import { afterEach, describe, expect, it } from 'vitest';

import {
  MemoryContributor,
  renderMemorySection,
} from '#src/memory-contributor.js';
import type { StaticPromptContext } from '#src/prompt.js';

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) {
    rmSync(roots.pop() ?? '', { recursive: true, force: true });
  }
});

/** A disposable workspace. See `@ghostai/core`'s `memory.test.ts`. */
function workspace(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ghostai-memctx-')));
  roots.push(root);
  return root;
}

function staticContext(workspaceRoot: string): StaticPromptContext {
  return {
    workspaceRoot,
    workspaceId: 'default',
    sessionKey: 'session-1',
    agentId: 'default',
    channel: 'web',
  };
}

function memory(overrides: Partial<Memory> = {}): Memory {
  const name = overrides.name ?? 'ui-stack-preferences';
  return {
    name,
    description: 'no shadcn/ui; Tailwind in rem, not px',
    type: 'user',
    body: 'The user wants an explicit design token layer.',
    path: `memory/${name}.md`,
    ...overrides,
  };
}

const BUDGET = { maxTokens: 2000 };

describe('renderMemorySection', () => {
  it('places nothing when there is nothing to index', () => {
    // Not a bare heading: `contributorSections` drops a section that trims to
    // nothing, which is how "no memory" becomes "no section".
    expect(renderMemorySection([], BUDGET)).toBe('');
  });

  it('places nothing when the budget is zero', () => {
    // The documented way to keep memory on disk but out of the prompt, with no
    // second config key to express it.
    expect(renderMemorySection([memory()], { maxTokens: 0 })).toBe('');
  });

  it('places nothing for a template that is a single space', () => {
    // The contract the five section templates keep: empty inherits the built-in
    // and a space deletes the section, because empty already means "inherit".
    expect(renderMemorySection([memory()], { ...BUDGET, template: ' ' })).toBe(
      '',
    );
  });

  it('carries the heading, the instruction to open a file, and the index', () => {
    const section = renderMemorySection([memory()], BUDGET);

    expect(section).toContain('## Memory');
    expect(section).toContain('read_file');
    expect(section).toContain('`memory` tool');
    expect(section).toContain(
      '- `memory/ui-stack-preferences.md` (user) — no shadcn/ui; Tailwind in rem, not px',
    );
  });

  it('advertises the file rather than carrying its body', () => {
    // The whole shape of the change: an index costs a line per memory, where
    // inlining re-sent everything ever learned on every request.
    const section = renderMemorySection([memory()], BUDGET);

    expect(section).not.toContain('explicit design token layer');
  });

  it('uses an operator template verbatim, filling its placeholders', () => {
    const section = renderMemorySection([memory({ name: 'alpha' })], {
      ...BUDGET,
      template: 'Notes in {{path}} — {{count}} of them.\n\n{{index}}',
    });

    expect(section).toBe(
      'Notes in memory — 1 of them.\n\n- `memory/alpha.md` (user) — no shadcn/ui; Tailwind in rem, not px',
    );
  });

  it('leaves an unknown placeholder verbatim rather than blanking the line', () => {
    // `renderPromptTemplate`'s guarantee, asserted here because this template is
    // a seventh caller of it and an operator's typo should be visible.
    const section = renderMemorySection([memory()], {
      ...BUDGET,
      template: 'Kept in {{pth}}.\n\n{{index}}',
    });

    expect(section).toContain('{{pth}}');
  });

  it('drops whole lines over budget, and says how many', () => {
    // Whole lines, because an index line missing its second half names a file
    // the model cannot open — worse than a memory it was never told about.
    const many = Array.from({ length: 40 }, (unused, n) =>
      memory({ name: `memory-number-${String(n).padStart(3, '0')}` }),
    );

    const section = renderMemorySection(many, { maxTokens: 60 });
    const lines = section
      .split('\n')
      .filter((line) => line.startsWith('- `memory/'));

    expect(lines.length).toBeGreaterThan(0);
    expect(lines.length).toBeLessThan(40);
    for (const line of lines) expect(line).toContain('.md`');
    expect(section).toContain('more not shown');
    expect(section).toContain('`memory/MEMORY.md`');
  });

  it('counts what survived the cut, not what was asked for', () => {
    // A template saying "you have 40 memories" beside 12 lines is a lie the
    // renderer told.
    const many = Array.from({ length: 40 }, (unused, n) =>
      memory({ name: `memory-number-${String(n).padStart(3, '0')}` }),
    );

    const section = renderMemorySection(many, {
      maxTokens: 60,
      template: '{{count}}\n\n{{index}}',
    });
    const shown = Number(section.split('\n')[0]);
    const lines = section
      .split('\n')
      .filter((line) => line.startsWith('- `memory/'));

    expect(shown).toBe(lines.length);
    expect(shown).toBeLessThan(40);
  });
});

describe('MemoryContributor', () => {
  it('places nothing for a workspace with no memories', async () => {
    const contributor = new MemoryContributor({ maxTokens: 2000 });

    await expect(
      contributor.staticSection(staticContext(workspace())),
    ).resolves.toBeUndefined();
  });

  it('reads the workspace it is given, not one it read before', async () => {
    // One `AgentLoop` serves every session on an agent, and those sessions can
    // be bound to different workspaces. Caching on the instance would hand one
    // workspace's memory to a concurrent turn in another.
    const first = workspace();
    const second = workspace();
    await saveMemory(first, {
      name: 'first-thing',
      description: 'about the first',
      type: 'project',
      body: 'A.',
    });
    await saveMemory(second, {
      name: 'second-thing',
      description: 'about the second',
      type: 'project',
      body: 'B.',
    });

    const contributor = new MemoryContributor({ maxTokens: 2000 });
    const a = await contributor.staticSection(staticContext(first));
    const b = await contributor.staticSection(staticContext(second));

    expect(a).toContain('first-thing');
    expect(a).not.toContain('second-thing');
    expect(b).toContain('second-thing');
    expect(b).not.toContain('first-thing');
  });

  it('does not read the folder at all when the budget is zero', async () => {
    // Scanning a directory to then discard it is work with no output.
    const root = workspace();
    await saveMemory(root, {
      name: 'something',
      description: 'a thing',
      type: 'project',
      body: 'A.',
    });

    const contributor = new MemoryContributor({ maxTokens: 0 });
    await expect(
      contributor.staticSection(staticContext(root)),
    ).resolves.toBeUndefined();
  });

  it('renders through the stored template on the agent', async () => {
    const root = workspace();
    await saveMemory(root, {
      name: 'a-thing',
      description: 'a thing',
      type: 'project',
      body: 'A.',
    });

    const contributor = new MemoryContributor({
      maxTokens: 2000,
      template: '## What I know\n\n{{index}}',
    });

    const section = await contributor.staticSection(staticContext(root));
    expect(section).toContain('## What I know');
    expect(section).not.toContain('## Memory');
  });
});
