/**
 * `memory` — record one durable fact about the workspace.
 *
 * One operation, four fields, and **no `path` argument**. That last part is the
 * whole reason this is not a worse `write_file`: the folder is derived from the
 * jail root, so there is no path for a model to get wrong and nothing for the
 * jail to adjudicate.
 *
 * A *name* is not a path, but it does put a model-chosen string into a filename,
 * so the guarantee that used to be free has to be re-established. It is, in
 * `memorySlug` — the result is `[a-z0-9-]` and cannot contain a separator or a
 * `..`, so it cannot leave `memory/` by construction. This tool calls it to
 * report a clear failure; `saveMemory` calls it again because it is the function
 * that turns a string into a path.
 *
 * ## Why a tool at all
 *
 * `docs/skills.md` argues there is no `skill` tool because "a tool whose entire
 * job is to return the bytes of a workspace file is a worse `read_file`", and
 * that argument is correct about *reading*. This is the case it does not cover:
 * a tool carries a permission — `allow`, `ask`, `deny` — and that permission is
 * already per-agent, already in the config and already in the settings UI. It is
 * therefore the switch for the whole feature, and inventing a `memoryEnabled`
 * boolean beside it would be a second way to say the same thing. See
 * `docs/memory.md`.
 *
 * ## Why writing a name twice replaces
 *
 * Because it is the only way a model can correct itself. `docs/memory.md` names
 * a wrong memory as the worst failure the feature has — it is in every future
 * turn on that folder — and without replacement a fact that has changed can only
 * be recorded a second time, leaving the index carrying two contradictory lines
 * with nothing to say which is current.
 *
 * The rule this reverses — "appending never rewrites" — existed to protect an
 * operator's hand-written preamble at the top of a single shared file. There is
 * no shared file and no preamble now, and the blast radius of a rewrite is one
 * fact under a name the model chose deliberately. `Replaced` in the result and a
 * diff in git are what make it visible.
 *
 * ## What it does not do
 *
 * There is no read operation: the index is already in the prompt and `read_file`
 * opens what it names. There is no delete either — a superseded memory is
 * corrected by writing the same name, and one that should not exist at all is a
 * file that `exec` can remove. Because the prompt index is scanned from the
 * folder rather than read from `MEMORY.md`, removing a file by hand takes effect
 * on the very next turn.
 */

import { z } from 'zod';

import {
  MAX_MEMORY_DESCRIPTION_CHARS,
  MAX_MEMORY_NAME_CHARS,
  MEMORY_TYPES,
  memorySlug,
  saveMemory,
} from '@ghostai/core';

import { assertNotAborted, defineTool, type AnyTool } from '../define.js';

/**
 * Long enough for a paragraph, short enough that one call cannot become the
 * whole store. The old cap was the same number for a different reason — memory
 * was inlined on every turn, so an unbounded note was a cost paid forever. It is
 * not in the prompt any more; this bounds the *format*, which says one fact per
 * file, and a two-thousand-character note is already several.
 */
const MAX_BODY_CHARS = 2000;

const schema = z.strictObject({
  name: z
    .string()
    .min(1)
    .max(MAX_MEMORY_NAME_CHARS)
    .describe(
      'A short kebab-case name for this one fact, unique in this workspace — `ui-stack-preferences`. It becomes the filename and is what a [[link]] in another memory refers to. Calling this again with the same name replaces that memory, which is how you correct one.',
    ),
  description: z
    .string()
    .min(1)
    .max(MAX_MEMORY_DESCRIPTION_CHARS)
    .describe(
      'One line saying what this is about. It is the only part that reaches your prompt, and the whole basis on which you later decide the memory is worth opening.',
    ),
  type: z
    .enum(MEMORY_TYPES)
    .describe(
      'What kind of fact this is. `user` — who the person is and what they prefer. `feedback` — how they have asked you to work, and why. `project` — an ongoing goal or constraint the code does not state. `reference` — a pointer to something outside this workspace.',
    ),
  body: z
    .string()
    .min(1)
    .max(MAX_BODY_CHARS)
    .describe(
      'The fact itself, in the form you want to read it back in. One fact per call. Refer to a related memory as [[its-name]].',
    ),
});

export const memoryTool: AnyTool = defineTool({
  name: 'memory',
  description:
    'Record one durable fact about this workspace for future sessions. Each call writes memory/<name>.md and puts a one-line summary of it in your prompt from now on; the fact itself stays on disk until you open it with read_file. Use it for what stays true — preferences, conventions, where things live — not for what only matters in this conversation. Calling it again with the same name replaces that memory.',
  schema,
  risk: 'write',
  annotations: {
    title: 'Remember',
    readOnlyHint: false,
    // Two identical calls now leave one file with those contents, where the
    // append this replaced left two notes. That is the honest signal of the
    // change: a name is an address, and writing the same thing to the same
    // address twice is the same state.
    idempotentHint: true,
  },
  async execute(args, context) {
    assertNotAborted(context.signal, 'memory');

    // Checked here as well so the model gets a sentence it can act on rather
    // than an exception from two layers down.
    const name = memorySlug(args.name);
    if (name === undefined) {
      return {
        content: `Nothing usable as a filename in "${args.name}". Names are letters, digits and hyphens — try something like \`build-conventions\`.`,
        isError: true,
      };
    }

    const saved = await saveMemory(context.jail.root, {
      name,
      description: args.description,
      type: args.type,
      body: args.body,
    });

    const verb = saved.replaced ? 'Replaced' : 'Recorded';
    const renamed =
      saved.name === args.name ? '' : ` (named \`${saved.name}\`)`;

    return {
      content: `${verb} ${saved.path}${renamed}. Its line is in your prompt from the next turn; open the file when it looks relevant.`,
      details: {
        name: saved.name,
        path: saved.path,
        replaced: saved.replaced,
        total: saved.total,
      },
    };
  },
});
