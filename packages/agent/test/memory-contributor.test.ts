import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { estimateTokens } from '@ghostai/providers';
import { afterEach, describe, expect, it } from 'vitest';

import { MemoryContributor, renderMemory } from '#src/memory-contributor.js';
import type { StaticPromptContext } from '#src/prompt.js';

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) {
    rmSync(roots.pop() ?? '', { recursive: true, force: true });
  }
});

/** A disposable workspace, optionally holding a memory. See `memory.test.ts`. */
function workspace(memory?: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ghostai-memctx-')));
  roots.push(root);
  if (memory !== undefined) {
    mkdirSync(join(root, 'memory'), { recursive: true });
    writeFileSync(join(root, 'memory', 'memory.md'), memory);
  }
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

const BUDGET = { maxTokens: 2000 };

describe('renderMemory', () => {
  it('places nothing for an empty memory', () => {
    // Not a bare heading: `contributorSections` drops a section that trims to
    // nothing, which is how "no memory" becomes "no section".
    expect(renderMemory('', BUDGET)).toBe('');
    expect(renderMemory('   \n\n  ', BUDGET)).toBe('');
  });

  it('places nothing when the budget is zero', () => {
    // The documented way to keep memory on disk but out of the prompt, with no
    // second config key to express it.
    expect(renderMemory('Something worth knowing.', { maxTokens: 0 })).toBe('');
  });

  it('carries the heading, the instruction to write, and the text', () => {
    const section = renderMemory('- Prefers rem over px.', BUDGET);

    expect(section).toContain('## Memory');
    expect(section).toContain('`memory` tool');
    expect(section).toContain('memory/memory.md');
    expect(section).toContain('- Prefers rem over px.');
  });

  it('keeps the newest text when it has to cut', () => {
    // A memory file is written newest-last, so the tail is what a recent
    // session learned and the head is what compaction already summarised once.
    const old = `- An old fact.\n${'- filler.\n'.repeat(400)}`;
    const section = renderMemory(`${old}- The newest fact.`, {
      maxTokens: 100,
    });

    expect(section).toContain('- The newest fact.');
    expect(section).not.toContain('- An old fact.');
    expect(section).toContain('[Truncated');
  });

  it('budgets the memory, with the framing on top', () => {
    // The convention `truncateHeadTail` sets: the budget bounds the part that
    // varies, and the heading and preamble are added over it. Measured rather
    // than guessed, so rewording the preamble cannot silently loosen this.
    const framing = estimateTokens(renderMemory('.', BUDGET));
    const section = renderMemory('- filler.\n'.repeat(500), {
      maxTokens: 100,
    });

    expect(estimateTokens(section)).toBeLessThanOrEqual(100 + framing);
  });
});

describe('MemoryContributor', () => {
  it('is absent for a workspace with no memory', async () => {
    const contributor = new MemoryContributor(BUDGET);
    await expect(
      contributor.staticSection(staticContext(workspace())),
    ).resolves.toBeUndefined();
  });

  it('reads the workspace it is given, not one it remembers', async () => {
    // One AgentLoop serves sessions bound to different workspaces. A
    // contributor that cached the file it read last turn would hand one
    // workspace's memory to a concurrent turn in another.
    const contributor = new MemoryContributor(BUDGET);
    const first = workspace('- Belongs to the first.');
    const second = workspace('- Belongs to the second.');

    const one = await contributor.staticSection(staticContext(first));
    const two = await contributor.staticSection(staticContext(second));

    expect(one).toContain('- Belongs to the first.');
    expect(two).toContain('- Belongs to the second.');
    expect(two).not.toContain('first');
  });

  it('does not read the file at all when the budget is zero', async () => {
    const contributor = new MemoryContributor({ maxTokens: 0 });
    await expect(
      contributor.staticSection(staticContext(workspace('- A fact.'))),
    ).resolves.toBeUndefined();
  });

  it('is absent for a memory file that holds only whitespace', async () => {
    const contributor = new MemoryContributor(BUDGET);
    await expect(
      contributor.staticSection(staticContext(workspace('\n  \n'))),
    ).resolves.toBeUndefined();
  });
});
