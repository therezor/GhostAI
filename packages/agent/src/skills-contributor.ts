/**
 * Skills, as a section of the prompt.
 *
 * A skill reaches the model one of two ways, and the split is the whole design:
 *
 *  - **Indexed.** One line — name, description, path. The model opens the file
 *    itself with `read_file` when the description tells it the skill applies.
 *    This is what "the rest loaded when relevant" means, and it costs about
 *    twenty tokens per skill instead of the whole sheet.
 *  - **Named on a message.** `@skill:code-review` inlines that body, for that
 *    message only. The person writing the message knows whether this one needs
 *    the sheet, which is a thing no setting can know in advance.
 *
 * The second is why `SkillBudget` no longer exists. It used to be a config array
 * of names whose bodies were inlined into the cached half for the life of a
 * session — a decision made once, by an operator, about every turn.
 *
 * ## Which half each part lands in
 *
 * The catalogue is a property of the workspace, so it goes in `staticSection` —
 * the provider's cached prefix, read once per turn. An inlined body is a
 * property of *this message*, so it goes in `runtimeSection`. Putting a per-turn
 * value in the static half would end the session's cached prefix on every turn,
 * which is the cost the two-half split exists to avoid; see `docs/prompts.md`.
 *
 * One visible consequence: a mentioned skill appears twice, as its index line up
 * in the catalogue and as its body down here. Suppressing the line would mean
 * varying the cached half per turn, which costs more than the twenty tokens it
 * would save.
 *
 * ## Nothing is cached on the instance
 *
 * One `AgentLoop` serves every session on an agent, and those sessions can be
 * bound to different workspaces. A contributor that remembered the catalogue it
 * read last turn would hand one workspace's skills to a concurrent turn in
 * another. So `staticSection` re-reads — which is a `readdir` and a handful of
 * small files, once per turn — and `runtimeSection` touches no state of its own.
 *
 * It does not re-read to inline a body, though, because it cannot: that half is
 * synchronous and runs on every iteration. `staticSection` has already read every
 * body by the time it renders one line of the index, so it leaves them in
 * `context.carry`, the per-turn map described on `StaticPromptContext`. That is
 * what dissolves the old either/or of I/O per iteration versus a cache that
 * outlives its turn.
 */

import { silentLogger, type Logger } from '@ghostai/core';
import {
  DEFAULT_SKILLS_TEMPLATE,
  renderPromptTemplate,
} from '@ghostai/protocol';

import {
  templateOr,
  type ContextContributor,
  type RuntimePromptContext,
  type StaticPromptContext,
} from './prompt.js';
import {
  MAX_MENTIONED_SKILLS,
  SKILLS_DIRNAME,
  SKILL_FILENAME,
  readSkills,
  type Skill,
} from './skills.js';

/** The `carry` key a skill's body is left under. */
function carryKey(name: string): string {
  return `skill:${name}`;
}

/**
 * The section text for a catalogue.
 *
 * Pure, and separate from the contributor for that reason: the ordering, the
 * empty cases and the template contract are the parts worth testing, and none of
 * them needs a filesystem to test.
 *
 * An empty catalogue renders as `''`, never as a bare heading —
 * `contributorSections` drops a section that trims to nothing, so this is how "no
 * skills" becomes "no section" rather than a `## Skills` with nothing under it.
 *
 * The heading and the prose come from the operator's `skillsPrompt`, on the same
 * contract the other seven templates keep: empty inherits
 * `DEFAULT_SKILLS_TEMPLATE`, a single space deletes the section. What stays in
 * code is the *shape* of the index line, because that is what `read_file` and the
 * catalogue agree on, not prose.
 */
export function renderSkills(
  skills: readonly Skill[],
  template?: string,
): string {
  if (skills.length === 0) return '';

  const resolved = templateOr(template, DEFAULT_SKILLS_TEMPLATE);
  if (resolved.trim() === '') return '';

  const indexLines = skills.map(indexLine).join('\n');

  // `{{index}}` carries its own leading blank line, so a template that places it
  // straight after its prose leaves no gap when the catalogue is empty. See the
  // convention noted beside the placeholders in `@ghostai/protocol`.
  return renderPromptTemplate(resolved, {
    path: SKILLS_DIRNAME,
    index: indexLines === '' ? '' : `\n\n${indexLines}`,
    indexLines,
    count: String(skills.length),
  }).trim();
}

function indexLine(skill: Skill): string {
  return `- \`${skill.path}\` — **${skill.name}**: ${skill.description}`;
}

function sheetPath(name: string): string {
  return `${SKILLS_DIRNAME}/${name}/${SKILL_FILENAME}`;
}

/**
 * The bodies a message asked for, and the paths it will have to open itself.
 *
 * Pure and exported for the same reason `renderSkills` is: the cap, the order and
 * what happens to a name that matches nothing are the whole behaviour, and none
 * of them needs a turn to exercise.
 *
 * Order is the message's, not the catalogue's, because the cap truncates and
 * someone who named three skills expects the first two to survive a cap of two.
 * A name is counted once however often it appears.
 */
export function renderMentionedSkills(
  named: readonly string[],
  bodyOf: (name: string) => string | undefined,
): string | undefined {
  if (named.length === 0) return undefined;

  const inlined: string[] = [];
  const referenced: string[] = [];
  const seen = new Set<string>();

  for (const name of named) {
    if (seen.has(name)) continue;
    seen.add(name);

    // Checked before the push, not after: a cap of zero must inline nothing, and
    // a post-push check can never see a length of zero.
    const body =
      inlined.length >= MAX_MENTIONED_SKILLS ? undefined : bodyOf(name);
    if (body === undefined) referenced.push(name);
    else inlined.push(`### Skill: ${name}\n\n${body}`);
  }

  const blocks: string[] = [];
  if (referenced.length > 0) {
    const paths = referenced.map((name) => `\`${sheetPath(name)}\``).join(', ');
    blocks.push(
      `Skills named on this message: read ${paths} before answering.`,
    );
  }
  blocks.push(...inlined);
  return blocks.join('\n\n');
}

interface SkillsContributorOptions {
  /**
   * `agents.list.<id>.skillsPrompt`. Empty means `DEFAULT_SKILLS_TEMPLATE`.
   *
   * A single space renders nothing, which is how an operator deletes the
   * section — the same contract the other seven templates keep.
   */
  readonly template?: string;
  readonly logger?: Logger;
}

/** Reads the workspace's skills and places them in both halves of the prompt. */
export class SkillsContributor implements ContextContributor {
  readonly name: string = 'skills';

  private readonly template: string;
  private readonly logger: Logger;

  constructor(options: SkillsContributorOptions = {}) {
    this.template = options.template ?? '';
    this.logger = options.logger ?? silentLogger;
  }

  async staticSection(
    context: StaticPromptContext,
  ): Promise<string | undefined> {
    const skills = await readSkills(context.workspaceRoot, {
      logger: this.logger,
    });
    if (skills.length === 0) return undefined;

    // Every body is already in hand, and the runtime half cannot read files. It
    // costs a reference each to keep them until the turn ends.
    for (const skill of skills) {
      context.carry.set(carryKey(skill.name), skill.body);
    }

    const section = renderSkills(skills, this.template);
    // A template of a single space renders nothing, and an undefined here is
    // what stops `contributorSections` placing an empty section.
    return section === '' ? undefined : section;
  }

  /**
   * The `@skill:` names on this message, as their bodies.
   *
   * A name the workspace does not have falls back to the line it used to always
   * get: read this path. That covers a typo and a skill deleted since the
   * message was written, and it is why the names are still not validated — the
   * failure already costs one `read_file` answering "no such file", which the
   * model recovers from.
   *
   * Names past `MAX_MENTIONED_SKILLS` take the same fallback. The sheet is still
   * reachable; it is the inlining that is capped, not the mention.
   */
  runtimeSection(context: RuntimePromptContext): string | undefined {
    return renderMentionedSkills(context.mentions?.skill ?? [], (name) =>
      context.carry.get(carryKey(name)),
    );
  }
}
