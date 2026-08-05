/**
 * `skill` — open one of the workspace's instruction sheets.
 *
 * ## This overturns a stated decision, deliberately
 *
 * `skills-contributor.ts` says there is no `skill` tool, and gives a good
 * reason: "a tool whose entire job is to return the bytes of a workspace file is
 * a worse `read_file` — one more name in every agent's permission map, one more
 * schema in every request, to reach a file the agent could already open." That
 * argument is about *reading*, and about reading it was right.
 *
 * The reason it did not address is the permission. A tool carries `allow`,
 * `ask` or `deny` per agent, and that is exactly "this capability is on, off, or
 * gated" — already in the config, already in the settings UI, already
 * per-agent. Without a `skill` tool there is no way to turn skills off for one
 * agent short of adding a `skillsEnabled` boolean beside the permission map,
 * which is a second switch for one thing and the way the two end up disagreeing.
 *
 * So the cost the old comment names is real and is now being paid on purpose.
 * What it buys is that denying `skill` removes the catalogue from the prompt
 * too — see the contributor gating in `runtime.ts`. See `docs/skills.md`.
 *
 * The name is still the directory name, and the path is still derived rather
 * than taken: a `name` that tries to climb out of `skills/` is refused by the
 * jail, not by a check here that could be forgotten.
 */

import { readFile } from 'node:fs/promises';

import { z } from 'zod';

import { assertNotAborted, defineTool, type AnyTool } from '../define.js';
import { fsFailure } from './shared.js';

/**
 * Restated rather than imported: they belong to `skills.ts` in `@ghostai/agent`,
 * which depends on this package and so cannot be depended on from here. Two
 * short strings is the cheaper of the two costs — the same trade Telegram's
 * command layer makes with `resolveSeq`.
 */
const SKILLS_DIRNAME = 'skills';
const SKILL_FILENAME = 'SKILL.md';

const schema = z.strictObject({
  name: z
    .string()
    .min(1)
    .describe(
      'The skill’s directory name, exactly as the catalogue in your prompt lists it.',
    ),
});

export const skillTool: AnyTool = defineTool({
  name: 'skill',
  description:
    'Read one of this workspace’s skills — the full instruction sheet behind a line in the skills catalogue. Open it before acting on what it names.',
  schema,
  risk: 'safe',
  annotations: {
    title: 'Open skill',
    readOnlyHint: true,
    idempotentHint: true,
  },
  async execute(args, context) {
    assertNotAborted(context.signal, 'skill');

    // Through the jail rather than joined here: `name` came from the model, and
    // the jail is the only thing permitted to judge an agent-supplied path.
    const where = `${SKILLS_DIRNAME}/${args.name}/${SKILL_FILENAME}`;
    const accepted = context.jail.accept(where);

    let text: string;
    try {
      text = await readFile(accepted.path, 'utf8');
    } catch (error) {
      throw fsFailure(error, accepted.relative);
    }

    return {
      content: text,
      details: { path: accepted.relative, skill: args.name },
    };
  },
});
