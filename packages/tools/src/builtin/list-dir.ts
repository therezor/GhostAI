/**
 * `list_dir` — what is in a workspace directory.
 *
 * No filtering. The obvious temptation is to hide `node_modules`, `.git` and
 * dotfiles, and it is the wrong call for an agent tool: the model asked what is
 * there, and a listing that quietly omits things teaches it that the directory
 * is empty when it is not. The entry cap is the mechanism instead — it bounds
 * the output without lying about the contents, and it says how many it dropped.
 *
 * Recursion uses `readdir`'s own recursive walk, which does not follow symlinks
 * and so cannot loop. That matters more than it sounds: a workspace containing a
 * self-referential link is an ordinary mistake, and a hand-rolled walk meets it
 * by running until it exhausts the path length limit.
 */

import type { Dirent } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { z } from 'zod';

import { assertNotAborted, defineTool, type AnyTool } from '../define.js';
import { clampNote, formatBytes, fsFailure } from './shared.js';

const DEFAULT_MAX_ENTRIES = 500;

const schema = z.strictObject({
  path: z
    .string()
    .default('.')
    .describe(
      'Directory to list. Rooted at the workspace. Defaults to the root itself.',
    ),
  recursive: z
    .boolean()
    .default(false)
    .describe('Walk subdirectories as well.'),
  maxEntries: z.coerce
    .number()
    .int()
    .min(1)
    .default(DEFAULT_MAX_ENTRIES)
    .describe('Stop after this many entries.'),
});

export const listDirTool: AnyTool = defineTool({
  name: 'list_dir',
  description:
    'List the contents of a workspace directory. The workspace is the root: "/x" and "../x" both resolve inside it, never outside. Directories are marked with a trailing slash and files show their size. Nothing is hidden; use maxEntries to bound a large tree.',
  schema,
  risk: 'safe',
  annotations: {
    title: 'List directory',
    readOnlyHint: true,
    idempotentHint: true,
  },
  async execute(args, context) {
    assertNotAborted(context.signal, 'list_dir');
    const accepted = context.jail.accept(args.path);
    const resolved = accepted.path;
    const where = accepted.relative === '' ? '.' : accepted.relative;
    const note = clampNote(args.path, accepted);

    let entries: Dirent[];
    try {
      entries = await readdir(resolved, {
        withFileTypes: true,
        recursive: args.recursive,
      });
    } catch (error) {
      throw fsFailure(error, where, note);
    }

    // Directories first, then name — the order someone reading a listing
    // expects, and stable across filesystems, which `readdir` order is not.
    const sorted = entries
      .map((entry) => ({
        // `parentPath` is absolute for a recursive walk; the display name has to
        // be relative to the directory that was asked for, not to the root the
        // walk happens to have started from.
        name: relativeName(resolved, entry.parentPath, entry.name),
        isDirectory: entry.isDirectory(),
        absolute: join(entry.parentPath, entry.name),
      }))
      .sort((left, right) => {
        if (left.isDirectory !== right.isDirectory) {
          return left.isDirectory ? -1 : 1;
        }
        return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
      });

    const shown = sorted.slice(0, args.maxEntries);
    const lines: string[] = [];
    for (const entry of shown) {
      assertNotAborted(context.signal, 'list_dir');
      if (entry.isDirectory) {
        lines.push(`${entry.name}/`);
        continue;
      }
      // A `stat` per file rather than one `lstat` batch: sizes are what make a
      // listing useful for deciding whether to read something, and the cap
      // already bounds how many of these run.
      const size = await stat(entry.absolute).then(
        (stats) => formatBytes(stats.size),
        () => 'unreadable',
      );
      lines.push(`${entry.name} (${size})`);
    }

    if (lines.length === 0) return `${where} is empty.${note}`;
    const omitted = sorted.length - shown.length;
    if (omitted > 0) {
      lines.push(
        `… ${String(omitted)} more entries not shown (maxEntries=${String(args.maxEntries)}).`,
      );
    }
    if (note !== '') lines.push(`[list_dir:${note}]`);
    return lines.join('\n');
  },
});

function relativeName(root: string, parentPath: string, name: string): string {
  if (parentPath === root) return name;
  const prefix = parentPath.startsWith(root)
    ? parentPath.slice(root.length + 1)
    : parentPath;
  return join(prefix, name);
}
