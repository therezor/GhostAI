/**
 * Skills: instruction sheets kept in the workspace, under `skills/`.
 *
 * One directory per skill, each holding a `SKILL.md` whose frontmatter carries a
 * description and whose body is the instructions. The directory may hold
 * whatever else the skill needs — a checklist, a template, a script — and the
 * model reaches those with `read_file` like any other workspace file. That is
 * the whole reason a skill is a directory rather than a file.
 *
 * This module is the disk half and nothing else: bytes to a `Skill[]`. What
 * reaches the prompt, and at what budget, is `skills-contributor.ts`.
 *
 * ## Two decisions worth stating
 *
 * **The directory name is the skill's id.** Not the frontmatter `name` — the
 * directory name is what appears in the path the model is given, so it is the
 * one identifier that cannot disagree with anything. A `name` field that says
 * something else is a warning and loses.
 *
 * **Nothing here throws.** A skill folder is workspace content, which means it
 * is whatever a person or a previous turn left there. A malformed file must cost
 * that one skill, not every turn on the workspace — the same position
 * `renderPromptTemplate` takes on a typo in a prompt template.
 *
 * ## Where these live, and what it costs
 *
 * In the workspace, which is inside the jail, which means `write_file` and
 * `exec` can both edit them. `paths.ts` puts an agent's own directory *beside*
 * the workspace for exactly this reason, and the tradeoff is deliberate rather
 * than overlooked: a skill folder is meant to be committed beside the project it
 * describes, and a location the agent cannot see in a directory listing is not
 * that. See `docs/skills.md`. What follows from it here: a skill directory that
 * is a symlink is skipped (`isDirectory()` is already false for one, so a link
 * pointing out of the workspace never resolves), and every body is bounded.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { parseFrontmatter, silentLogger, type Logger } from '@ghostbot/core';

/** The folder inside the workspace that holds them. */
export const SKILLS_DIRNAME = 'skills';

/** The one file a skill directory must contain. */
export const SKILL_FILENAME = 'SKILL.md';

/**
 * The most of one skill's body that reaches the prompt.
 *
 * 12 KB is roughly three thousand tokens. The bound exists because a body the
 * model opens with `read_file` lands in the transcript and is re-sent on every
 * later iteration of that turn at full price, so its size is a decision rather
 * than an accident.
 */
export const SKILL_MAX_BYTES: number = 12 * 1024;

/**
 * The most skills one workspace advertises.
 *
 * A bound rather than a courtesy. The index costs a line per skill on every
 * request, and a workspace that has accumulated a thousand directories under
 * `skills/` should meet a wall and a log line rather than a prompt nobody
 * budgeted for.
 */
export const MAX_SKILLS = 100;

/** How much of a description an index line carries. */
export const MAX_DESCRIPTION_CHARS = 200;

export interface Skill {
  /** The directory name. */
  readonly name: string;
  /** One line, collapsed and bounded. The basis on which a model opens the file. */
  readonly description: string;
  /** Everything after the frontmatter, already bounded by `SKILL_MAX_BYTES`. */
  readonly body: string;
  /** Workspace-relative, as the model would pass it to `read_file`. */
  readonly path: string;
}

interface ReadSkillsOptions {
  readonly logger?: Logger;
}

/**
 * Every loadable skill in a workspace, sorted by name.
 *
 * Sorted because the result lands in the provider's cached prefix, and a
 * `readdir` order that varies between hosts would move that prefix for no
 * reason anyone could see.
 *
 * A workspace with no `skills/` directory is the empty array. That is the
 * ordinary case rather than a misconfiguration, so it is not logged.
 */
export async function readSkills(
  workspaceRoot: string,
  options: ReadSkillsOptions = {},
): Promise<readonly Skill[]> {
  const logger = options.logger ?? silentLogger;
  const dir = join(workspaceRoot, SKILLS_DIRNAME);

  let names: string[];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    names = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }

  if (names.length > MAX_SKILLS) {
    logger.warn(
      { dir, found: names.length, max: MAX_SKILLS },
      'more skill directories than the cap; the rest are not advertised',
    );
    names = names.slice(0, MAX_SKILLS);
  }

  const loaded = await Promise.all(
    names.map((name) => readSkill(dir, name, logger)),
  );
  return loaded.filter((skill) => skill !== undefined);
}

async function readSkill(
  dir: string,
  name: string,
  logger: Logger,
): Promise<Skill | undefined> {
  const file = join(dir, name, SKILL_FILENAME);

  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    logger.warn({ skill: name, file }, 'skill has no readable SKILL.md');
    return undefined;
  }

  const { fields, body } = parseFrontmatter(text);

  // The description is the entire basis on which a model decides to open the
  // file, so a skill without one cannot be advertised — an index line reading
  // "**deploy**: " teaches it that the skill is about nothing.
  const description = collapse(fields.description ?? '');
  if (description === '') {
    logger.warn(
      { skill: name, file },
      'skill has no description and is not advertised',
    );
    return undefined;
  }

  const declared = fields.name?.trim();
  if (declared !== undefined && declared !== '' && declared !== name) {
    logger.warn(
      { skill: name, declared },
      'skill name disagrees with its directory; the directory wins',
    );
  }

  return {
    name,
    description: truncateChars(description, MAX_DESCRIPTION_CHARS),
    body: truncateBytes(body, SKILL_MAX_BYTES),
    // Built with `/` rather than `join`, because this string is handed to the
    // model to pass back to `read_file`, which takes POSIX separators on every
    // host. A Windows `join` would produce a path the jail then has to guess at.
    path: `${SKILLS_DIRNAME}/${name}/${SKILL_FILENAME}`,
  };
}

/** Whitespace to single spaces, so a wrapped description stays one index line. */
function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function truncateChars(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - 1).trimEnd()}…`;
}

function truncateBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  // Cut the bytes, then decode: a multi-byte character split down the middle
  // becomes one replacement character rather than corrupting what follows.
  const cut = Buffer.from(text, 'utf8').subarray(0, maxBytes).toString('utf8');
  return `${cut}\n\n[Truncated — read ${SKILL_FILENAME} for the rest.]`;
}
