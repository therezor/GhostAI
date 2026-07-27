/**
 * A disposable workspace and the `ToolContext` around it.
 *
 * `realpath` on the temp directory is not optional: macOS hands out
 * `/var/folders/...`, which is a symlink to `/private/var/folders/...`, and a
 * jail that compared against the un-canonicalised form would reject every path
 * inside its own workspace — so a test suite written without it passes on Linux
 * and fails on the reviewer's laptop.
 */

import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ToolsConfig } from '@ghostai/protocol';
import { WorkspaceJail } from '@ghostai/security';

import { DEFAULT_TOOLS_CONFIG, type ToolContext } from '../define.js';

export interface TestWorkspace {
  readonly root: string;
  readonly jail: WorkspaceJail;
  readonly controller: AbortController;
  readonly context: ToolContext;
  /** A context with the same workspace and a config override. */
  with(config: Partial<ToolsConfig>): ToolContext;
  dispose(): void;
}

export function createTestWorkspace(config: Partial<ToolsConfig> = {}): TestWorkspace {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'ghostai-tools-')));
  const root = join(base, 'workspace');
  const jail = new WorkspaceJail({ root });
  const controller = new AbortController();
  const merged: ToolsConfig = { ...DEFAULT_TOOLS_CONFIG, ...config };

  const context: ToolContext = { jail, signal: controller.signal, config: merged };

  return {
    root: jail.root,
    jail,
    controller,
    context,
    with(override) {
      return { ...context, config: { ...merged, ...override } };
    },
    dispose() {
      rmSync(base, { recursive: true, force: true });
    },
  };
}
