/**
 * Every built-in through the shared conformance suite.
 *
 * This is the file that makes "the built-ins behave the same at their edges" a
 * checked claim. A sixth tool added without a block here is a tool nobody has
 * proved rejects an unknown argument or notices a cancelled turn.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, describe } from 'vitest';

import type { ToolContext } from '../define.js';
import { toolConformance } from '../testkit/conformance.js';
import { createTestWorkspace, type TestWorkspace } from '../testkit/workspace.js';
import { editFileTool } from './edit-file.js';
import { execTool } from './exec.js';
import { listDirTool } from './list-dir.js';
import { readFileTool } from './read-file.js';
import { writeFileTool } from './write-file.js';

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
