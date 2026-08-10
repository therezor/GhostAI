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
 * **Which agents see a sheet is declared in the file, not by where it sits.** An
 * `agents:` line in the frontmatter narrows a sheet to the agents it names;
 * without one it is every agent's, which is what every sheet written before this
 * existed keeps doing. Scope is a property of the *catalogue* — it decides what
 * an agent is told about, not what it may read, and `read_file` and the `skill`
 * tool will still open a sheet that was not advertised.
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

import { parseFrontmatter, silentLogger, type Logger } from '@ghostwire/core';
import { isAgentId } from '@ghostwire/protocol';

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
  /**
   * The agents whose catalogue advertises this sheet. Empty means every agent,
   * which is both the default and what a malformed `agents:` falls back to.
   *
   * Required rather than optional: `readSkills` always produces it and `[]` is a
   * total answer for "unscoped", so an optional field would only mean every
   * consumer writing `?? []`.
   */
  readonly agents: readonly string[];
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
    agents: parseSkillAgents(fields.agents, { skill: name, logger }),
    // Built with `/` rather than `join`, because this string is handed to the
    // model to pass back to `read_file`, which takes POSIX separators on every
    // host. A Windows `join` would produce a path the jail then has to guess at.
    path: `${SKILLS_DIRNAME}/${name}/${SKILL_FILENAME}`,
  };
}

/**
 * The `agents:` line, as a list of agent ids. Empty means every agent.
 *
 * ## Comma-separated is the only form, and that is a property of the reader
 *
 * `parseFrontmatter` is not YAML and its header says it must never become YAML.
 * Its field pattern is anchored on a letter, so a `- coder` block item does not
 * match: it clears the parent and is discarded. A block list is therefore
 * *indistinguishable* from a bare `agents:` by the time the value reaches here,
 * which is why the empty case warns rather than passing silently — somebody who
 * wrote the YAML they know needs to be told why nothing happened.
 *
 * A surrounding `[…]` is stripped first, because `agents: [coder, writer]` is
 * the other thing that person writes and it is three lines to accept.
 *
 * ## It fails open, deliberately
 *
 * A value that yields no usable id leaves the sheet visible to **every** agent.
 * A skill is prose, not a capability — `docs/skills.md` makes that argument at
 * length — so the two ways of being wrong are not symmetric: showing a sheet too
 * widely is prompt cost a person can see in `/skills`, and hiding one from
 * everybody is a sheet that silently stopped working with nothing to find.
 *
 * At most one warning per sheet. `readSkills` re-reads on every turn, so a
 * second line here is a second line forever.
 */
export function parseSkillAgents(
  value: string | undefined,
  context: { readonly skill: string; readonly logger: Logger },
): readonly string[] {
  if (value === undefined) return [];

  const ids: string[] = [];
  const dropped: string[] = [];

  for (const part of stripBrackets(value.trim()).split(',')) {
    const item = unquote(part.trim()).trim().toLowerCase();
    if (item === '') continue;
    if (!isAgentId(item)) {
      dropped.push(item);
      continue;
    }
    if (!ids.includes(item)) ids.push(item);
  }

  if (ids.length === 0) {
    context.logger.warn(
      { skill: context.skill, dropped },
      'skill `agents:` names no usable agent id, so the sheet stays visible to ' +
        'every agent; write it as `agents: coder, writer`',
    );
  } else if (dropped.length > 0) {
    context.logger.warn(
      { skill: context.skill, dropped },
      'skill `agents:` names something that is not an agent id; those entries ' +
        'are ignored',
    );
  }

  return ids;
}

/**
 * The sheets one agent's catalogue advertises.
 *
 * Separate from `readSkills` rather than an option on it, for the reason
 * `renderSkills` is separate from its contributor: of the three callers only the
 * contributor filters — both `/skills` surfaces want every sheet so they can say
 * which ones are out of scope — and this way the rule is testable without a
 * filesystem.
 *
 * Note that `MAX_SKILLS` is applied by `readSkills`, before this. That is the
 * right order — the cap bounds the per-turn read, and applying it after would
 * mean opening a thousand directories to find the twelve one agent sees — but it
 * does mean that past the cap, which sheets an agent sees follows alphabetical
 * order rather than scope.
 */
export function skillsForAgent(
  skills: readonly Skill[],
  agentId: string,
): readonly Skill[] {
  const id = agentId.toLowerCase();
  return skills.filter(
    (skill) => skill.agents.length === 0 || skill.agents.includes(id),
  );
}

/** One surrounding `[…]` pair, so the YAML flow form parses. */
function stripBrackets(text: string): string {
  return text.startsWith('[') && text.endsWith(']') ? text.slice(1, -1) : text;
}

/**
 * One matching quote pair. Restated rather than imported: `frontmatter.ts` keeps
 * its own copy private, and this one runs per *item* rather than per value —
 * `[coder, "writer"]` is only unquotable after the split.
 */
function unquote(text: string): string {
  const quoted =
    text.length >= 2 &&
    (text.startsWith('"') || text.startsWith("'")) &&
    text.endsWith(text[0] ?? '');
  return quoted ? text.slice(1, -1) : text;
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
