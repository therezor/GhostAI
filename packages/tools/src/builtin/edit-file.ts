/**
 * `edit_file` — replace an exact string in a workspace file.
 *
 * String replacement rather than a diff or a line range, for one reason: a
 * unique literal is the only edit address a model can produce that stays
 * correct between the read and the write. Line numbers go stale the moment
 * anything else touches the file, and a unified diff asks the model to get
 * hunk arithmetic right — which it does not, reliably, and a wrong hunk applies
 * cleanly to the wrong place.
 *
 * The uniqueness rule is what makes that safe. `oldText` occurring twice is
 * ambiguous, and picking the first is a coin flip that silently edits the wrong
 * call site; the tool refuses and tells the model to include more surrounding
 * context. `replaceAll` is available when the model means every occurrence, and
 * saying so is a different claim from not having noticed.
 */

import { readFile, writeFile } from 'node:fs/promises';

import { GhostError } from '@ghostbot/core';
import { z } from 'zod';

import { assertNotAborted, defineTool, type AnyTool } from '../define.js';
import { clampNote, fsFailure } from './shared.js';

const schema = z.strictObject({
  path: z.string().min(1).describe('File to edit. Rooted at the workspace.'),
  oldText: z
    .string()
    .min(1)
    .describe(
      'Exact text to replace, including whitespace. Must occur exactly once unless replaceAll is true.',
    ),
  newText: z
    .string()
    .describe('Replacement text. Use an empty string to delete.'),
  // Deliberately not `z.coerce.boolean()`, which is `Boolean(value)` and so
  // turns the string `"false"` into `true`. On a flag that decides between one
  // replacement and every replacement, a coercion that inverts the model's
  // stated intent is far worse than rejecting a string it should not have sent.
  replaceAll: z
    .boolean()
    .default(false)
    .describe('Replace every occurrence instead of requiring exactly one.'),
});

export const editFileTool: AnyTool = defineTool({
  name: 'edit_file',
  description:
    'Replace an exact string in an existing workspace file. The workspace is the root: "/x" and "../x" both resolve inside it, never outside. oldText must appear exactly once unless replaceAll is set, so read the file first and include enough surrounding context to be unambiguous.',
  schema,
  risk: 'write',
  annotations: {
    title: 'Edit file',
    readOnlyHint: false,
    idempotentHint: false,
  },
  async execute(args, context) {
    assertNotAborted(context.signal, 'edit_file');
    if (args.oldText === args.newText) {
      throw new GhostError(
        'invalid_input',
        'oldText and newText are identical; nothing to do.',
        {
          details: { path: args.path },
        },
      );
    }
    const accepted = context.jail.accept(args.path);
    const resolved = accepted.path;
    const where = accepted.relative;
    const note = clampNote(args.path, accepted);

    let original: string;
    try {
      original = await readFile(resolved, 'utf8');
    } catch (error) {
      throw fsFailure(error, where, note);
    }

    const occurrences = original.split(args.oldText).length - 1;
    if (occurrences === 0) {
      throw new GhostError(
        'not_found',
        `oldText was not found in ${where}. Read the file and copy the text exactly, including indentation.`,
        { details: { path: where } },
      );
    }
    if (occurrences > 1 && !args.replaceAll) {
      throw new GhostError(
        'conflict',
        `oldText occurs ${String(occurrences)} times in ${where}. Include more surrounding context to make it unique, or set replaceAll.`,
        { details: { path: where, occurrences } },
      );
    }

    // A function replacement, never the string form: `String.replace` gives
    // `$&`, `$1` and `$'` special meaning inside a replacement *string*, so a
    // `newText` containing a shell variable, a regex or a price in dollars
    // would be silently rewritten. The callback form has no such rule.
    const updated = args.replaceAll
      ? original.split(args.oldText).join(args.newText)
      : original.replace(args.oldText, () => args.newText);

    assertNotAborted(context.signal, 'edit_file');
    try {
      await writeFile(resolved, updated, {
        encoding: 'utf8',
        signal: context.signal,
      });
    } catch (error) {
      throw fsFailure(error, where, note);
    }

    const delta = updated.length - original.length;
    return {
      content: `Replaced ${String(occurrences)} occurrence${occurrences === 1 ? '' : 's'} in ${where} (${delta >= 0 ? '+' : ''}${String(delta)} characters).${note}`,
      details: { path: where, occurrences, delta },
    };
  },
});
