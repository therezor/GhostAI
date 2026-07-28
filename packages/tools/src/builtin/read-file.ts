/**
 * `read_file` — the workspace read.
 *
 * Two constraints shape it, and both are about what happens on the *large* file
 * rather than the ordinary one:
 *
 *  - **The read is bounded before it happens.** `readFile` on a 2 GB log
 *    allocates 2 GB and then the registry truncates it to 8 000 characters. The
 *    handler opens the file and reads at most a UTF-8 worst case of the output
 *    budget, so the memory cost is bounded by the budget rather than by whatever
 *    the model happened to point at.
 *
 *  - **Binary content is refused, not dumped.** A model given a few thousand
 *    bytes of a `.png` learns nothing and pays for the tokens twice — once in
 *    the tool result and again in every subsequent turn of history. The NUL-byte
 *    test is the cheap, reliable half of binary detection and is exactly the
 *    case that matters here.
 *
 * `offset`/`limit` are lines rather than bytes because that is the unit the
 * model reasons in, and because a byte range can split a codepoint.
 */

import { open } from 'node:fs/promises';

import { GhostError } from '@ghostai/core';
import { z } from 'zod';

import { assertNotAborted, defineTool, type AnyTool } from '../define.js';
import { clampNote, fsFailure } from './shared.js';

/** UTF-8's worst case, so the byte budget can never cut short the char budget. */
const BYTES_PER_CHAR = 4;

const schema = z.strictObject({
  path: z.string().min(1).describe('File to read. Rooted at the workspace.'),
  offset: z.coerce
    .number()
    .int()
    .min(1)
    .optional()
    .describe('1-based line number to start from. Omit to start at the beginning.'),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .optional()
    .describe('Maximum number of lines to return. Omit to read to the end.'),
});

export const readFileTool: AnyTool = defineTool({
  name: 'read_file',
  description:
    'Read a UTF-8 text file from the workspace. The workspace is the root: "/x" and "../x" both resolve inside it, never outside. Use offset/limit to page through a large file.',
  schema,
  risk: 'safe',
  annotations: { title: 'Read file', readOnlyHint: true, idempotentHint: true },
  async execute(args, context) {
    assertNotAborted(context.signal, 'read_file');
    const accepted = context.jail.accept(args.path);
    const resolved = accepted.path;
    // Report where the read actually happened, not what was asked for: they
    // differ whenever the path was clamped, and naming the request would teach
    // the model that `/etc/hosts` is a path this workspace has.
    const where = accepted.relative;
    const note = clampNote(args.path, accepted);
    const budget = context.config.maxOutputChars * BYTES_PER_CHAR;

    const handle = await open(resolved, 'r').catch((error: unknown) => {
      throw fsFailure(error, where, note);
    });
    try {
      const stats = await handle.stat();
      if (stats.isDirectory()) {
        throw new GhostError(
          'invalid_input',
          `${where} is a directory. Use list_dir instead.`,
          {
            details: { path: where },
          },
        );
      }
      if (stats.size === 0) return `${where} is empty.`;

      // One byte past the budget is enough to know the file was longer without
      // reading any more of it than the answer needs.
      const wanted = Math.min(stats.size, budget + 1);
      const buffer = Buffer.allocUnsafe(wanted);
      const { bytesRead } = await handle.read(buffer, 0, wanted, 0);
      const bytes = buffer.subarray(0, bytesRead);

      if (bytes.includes(0)) {
        throw new GhostError(
          'invalid_input',
          `${where} looks like a binary file (${String(stats.size)} bytes) and was not read.`,
          { details: { path: where, size: stats.size } },
        );
      }

      const clipped = bytesRead > budget;
      let text = bytes.subarray(0, clipped ? budget : bytesRead).toString('utf8');

      if (args.offset !== undefined || args.limit !== undefined) {
        const lines = text.split('\n');
        const from = (args.offset ?? 1) - 1;
        const to = args.limit === undefined ? lines.length : from + args.limit;
        if (from >= lines.length) {
          return `${where} has ${String(lines.length)} lines; offset ${String(args.offset ?? 1)} is past the end.`;
        }
        text = lines.slice(from, to).join('\n');
      }

      assertNotAborted(context.signal, 'read_file');
      const clip = clipped
        ? `\n\n[read_file: showing the first ${String(budget)} of ${String(stats.size)} bytes. Use offset/limit for the rest.]`
        : '';
      // A successful read of a clamped path needs the note as much as a failed
      // one: content came back, and without this the model believes it is
      // holding the host's file.
      return `${text}${clip}${note === '' ? '' : `\n\n[read_file:${note}]`}`;
    } finally {
      await handle.close();
    }
  },
});
