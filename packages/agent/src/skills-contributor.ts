/**
 * Skills, as a section of the prompt.
 *
 * A skill reaches the model as one index line — name, description, path. The
 * model opens the file itself with `read_file` when the description tells it the
 * skill applies. This is what "the rest loaded when relevant" means, and it
 * costs about twenty tokens per skill instead of the whole sheet.
 *
 * That is why `SkillBudget` no longer exists. It used to be a config array of
 * names whose bodies were inlined into the cached half for the life of a
 * session — a decision made once, by an operator, about every turn, paid for on
 * every turn.
 *
 * ## Which half it lands in
 *
 * The catalogue is a property of the workspace, so it goes in `staticSection` —
 * the provider's cached prefix, read once per turn. There is no runtime half:
 * putting a per-turn value in the static one would end the session's cached
 * prefix on every turn, which is the cost the two-half split exists to avoid,
 * and nothing here varies per turn anyway. See `docs/prompts.md`.
 *
 * ## Nothing is cached on the instance
 *
 * One `AgentLoop` serves every session on an agent, and those sessions can be
 * bound to different workspaces. A contributor that remembered the catalogue it
 * read last turn would hand one workspace's skills to a concurrent turn in
 * another. So `staticSection` re-reads — which is a `readdir` and a handful of
 * small files, once per turn.
 */

import { silentLogger, type Logger } from '@ghostbot/core';
import {
  DEFAULT_SKILLS_TEMPLATE,
  renderPromptTemplate,
} from '@ghostbot/protocol';

import {
  templateOr,
  type ContextContributor,
  type StaticPromptContext,
} from './prompt.js';
import { SKILLS_DIRNAME, readSkills, type Skill } from './skills.js';

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
  // convention noted beside the placeholders in `@ghostbot/protocol`.
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

/** Reads the workspace's skills and places the catalogue in the prompt. */
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

    const section = renderSkills(skills, this.template);
    // A template of a single space renders nothing, and an undefined here is
    // what stops `contributorSections` placing an empty section.
    return section === '' ? undefined : section;
  }
}
