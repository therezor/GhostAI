/**
 * `write_file` — create or replace a workspace file.
 *
 * Whole-file replacement, not append and not patch. `edit_file` is the tool for
 * a change to an existing file, and keeping the two separate is what makes the
 * approval prompt meaningful: "replace 4 kB of `src/index.ts`" and "swap one
 * string in `src/index.ts`" are different decisions, and a single tool with a
 * `mode` argument would present them as the same one.
 *
 * Parent directories are created. The path has already been through the jail, so
 * every directory created is inside the workspace by construction — and refusing
 * to create them would leave the model to call a directory tool it does not
 * have.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { z } from 'zod';

import { assertNotAborted, defineTool, type AnyTool } from '../define.js';
import { formatBytes, fsFailure } from './shared.js';

const schema = z.strictObject({
  path: z
    .string()
    .min(1)
    .describe('File to write, relative to the workspace root. Parent directories are created.'),
  content: z.string().describe('Full new contents of the file. Existing contents are replaced.'),
});

export const writeFileTool: AnyTool = defineTool({
  name: 'write_file',
  description:
    'Write a UTF-8 text file in the workspace, replacing it if it exists. Paths are relative to the workspace root. Use edit_file to change part of an existing file.',
  schema,
  risk: 'write',
  annotations: { title: 'Write file', readOnlyHint: false, idempotentHint: true },
  async execute(args, context) {
    assertNotAborted(context.signal, 'write_file');
    const resolved = context.jail.resolve(args.path);
    const bytes = Buffer.byteLength(args.content, 'utf8');

    try {
      await mkdir(dirname(resolved), { recursive: true });
      // `signal` is passed as well as checked: a large write cancelled midway is
      // better than one that completes after the turn it belonged to has ended.
      await writeFile(resolved, args.content, { encoding: 'utf8', signal: context.signal });
    } catch (error) {
      throw fsFailure(error, args.path);
    }

    return {
      content: `Wrote ${formatBytes(bytes)} to ${args.path}.`,
      details: { path: args.path, bytes },
    };
  },
});
