/**
 * Every built-in through the shared conformance suite.
 *
 * This is the file that makes "the built-ins behave the same at their edges" a
 * checked claim. A sixth tool added without a block here is a tool nobody has
 * proved rejects an unknown argument or notices a cancelled turn.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { BUILTIN_TOOL_NAMES, DEFAULT_AGENT_TOOLS } from '@ghostai/protocol';

import type { ToolContext } from '#src/define.js';
import { toolConformance } from '#testkit/conformance.js';
import { createTestWorkspace, type TestWorkspace } from '#testkit/workspace.js';
import { BUILTIN_TOOLS } from '#src/builtin/index.js';
import { editFileTool } from '#src/builtin/edit-file.js';
import { execTool } from '#src/builtin/exec.js';
import { listDirTool } from '#src/builtin/list-dir.js';
import { readFileTool } from '#src/builtin/read-file.js';
import { writeFileTool } from '#src/builtin/write-file.js';

const open: TestWorkspace[] = [];

/** A context factory that seeds a fresh workspace and cleans up afterwards. */
function seeded(setup: (root: string) => void): () => ToolContext {
  return () => {
    const workspace = createTestWorkspace();
    open.push(workspace);
    setup(workspace.root);
    return workspace.context;
  };
}

afterAll(() => {
  for (const workspace of open) workspace.dispose();
});

const withNotes = seeded((root) => {
  writeFileSync(join(root, 'notes.md'), '# Notes\nthe quick brown fox\n');
  writeFileSync(join(root, 'big.txt'), 'lorem ipsum dolor sit amet\n'.repeat(400));
});

describe('built-in conformance', () => {
  toolConformance({
    tool: readFileTool,
    context: withNotes,
    validArgs: { path: 'notes.md' },
    largeOutputArgs: { path: 'big.txt' },
  });

  toolConformance({
    tool: writeFileTool,
    context: seeded(() => undefined),
    validArgs: { path: 'out/report.txt', content: 'hello' },
  });

  toolConformance({
    tool: editFileTool,
    context: withNotes,
    validArgs: { path: 'notes.md', oldText: 'quick', newText: 'slow' },
  });

  toolConformance({
    tool: listDirTool,
    context: seeded((root) => {
      mkdirSync(join(root, 'src'));
      for (let index = 0; index < 60; index += 1) {
        writeFileSync(join(root, `fixture-${String(index).padStart(3, '0')}.txt`), 'x');
      }
    }),
    validArgs: { path: '.' },
    largeOutputArgs: { path: '.' },
  });

  toolConformance({
    tool: execTool,
    context: seeded(() => undefined),
    validArgs: { argv: [process.execPath, '-e', 'process.stdout.write("ok")'] },
    largeOutputArgs: {
      argv: [process.execPath, '-e', 'process.stdout.write("x".repeat(5000))'],
    },
  });
});

/**
 * Two packages below this one hold the built-in *names* without the tools:
 * `@ghostai/protocol` publishes the list, `@ghostai/security` refuses a toolbox
 * that shadows one, and `DEFAULT_AGENT_TOOLS` seeds a new agent from it. This
 * file is the only place both the names and the implementations are visible, so
 * it is the only place the drift can be caught — and drift is silent otherwise:
 * a sixth built-in would simply never be enabled on any agent anyone created.
 */
describe('the built-in set, as packages below it assume it', () => {
  const names = BUILTIN_TOOLS.map((tool) => tool.name).sort();

  it('matches the name list protocol publishes', () => {
    expect([...BUILTIN_TOOL_NAMES].sort()).toEqual(names);
  });

  it('is what a new agent is seeded with, save for the one deliberate omission', () => {
    expect(Object.keys(DEFAULT_AGENT_TOOLS).sort()).toEqual(
      names.filter((name) => name !== 'automation'),
    );
  });

  it('does not give a new agent the ability to schedule', () => {
    // The one built-in absent from the seed, and it is not an oversight. Every
    // other tool acts once, when called; `automation` causes a turn to happen
    // later, unattended, on a timer — so it is granted per agent by an operator
    // who chose to, rather than inherited by everything that gets created.
    expect(DEFAULT_AGENT_TOOLS).not.toHaveProperty('automation');
    expect(BUILTIN_TOOL_NAMES).toContain('automation');
  });

  it('seeds each tool at the permission its risk band implies', () => {
    for (const tool of BUILTIN_TOOLS) {
      const seeded = DEFAULT_AGENT_TOOLS[tool.name];
      if (seeded === undefined) continue; // covered above
      const risk = tool.definition('builtin').risk;
      expect(seeded).toBe(risk === 'safe' || risk === 'write' ? 'allow' : 'ask');
    }
  });
});
