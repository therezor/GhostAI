/**
 * `memory` — append a durable note to the workspace's memory.
 *
 * Append-only, one operation, and **no `path` argument**. That last part is the
 * whole reason this is not a worse `write_file`: the file is derived from the
 * jail root, so there is no path for a model to get wrong and nothing for the
 * jail to adjudicate. A tool that took a path would be `write_file` with a
 * shorter name.
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
 * ## What it does not do
 *
 * There is no `read` operation. When this tool is granted, `memory.md` is
 * already inlined whole into the static prompt, so the model holds the current
 * bytes at the moment it decides to add to them — and `read_file` covers anyone
 * who wants it again. That is also why appending is enough: the read half of a
 * read-modify-write has already been paid for.
 */

import { z } from 'zod';

import { appendMemory, MEMORY_PATH, systemClock } from '@ghostai/core';

import { assertNotAborted, defineTool, type AnyTool } from '../define.js';

/**
 * Long enough for a paragraph, short enough that one call cannot become the
 * whole file. Memory is read on every turn, so an unbounded note is a cost paid
 * forever rather than once.
 */
const MAX_NOTE_CHARS = 2000;

const schema = z.strictObject({
  note: z
    .string()
    .min(1)
    .max(MAX_NOTE_CHARS)
    .describe(
      'One durable fact about this workspace, in the form you want to read it back in. Appended under today’s heading — nothing already recorded is replaced.',
    ),
});

export const memoryTool: AnyTool = defineTool({
  name: 'memory',
  description:
    'Record something worth remembering about this workspace for future sessions. Appends to memory/memory.md, which is placed in your prompt from now on. Use it for durable facts — preferences, conventions, where things live — not for what only matters in this conversation.',
  schema,
  risk: 'write',
  annotations: {
    title: 'Remember',
    readOnlyHint: false,
    // Two identical calls append two notes. That is the correct answer for an
    // append and the reason this differs from `write_file`.
    idempotentHint: false,
  },
  async execute(args, context) {
    assertNotAborted(context.signal, 'memory');

    const clock = context.clock ?? systemClock;
    await appendMemory(
      context.jail.root,
      args.note,
      new Date(clock.now()).toISOString(),
    );

    return {
      content: `Recorded. ${MEMORY_PATH} now carries this, and it is in the prompt from the next turn.`,
      details: { path: MEMORY_PATH },
    };
  },
});
