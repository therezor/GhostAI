/**
 * Skills, as a section of the prompt.
 *
 * A skill reaches the model one of two ways, and the split is the whole design:
 *
 *  - **Indexed.** One line — name, description, path. The model opens the file
 *    itself with `read_file` when the description tells it the skill applies.
 *    This is what "the rest loaded when relevant" means, and it costs about
 *    twenty tokens per skill instead of the whole sheet.
 *  - **Pinned.** Named in `pinnedSkills`, so the body is inlined and the model
 *    has read it before it does anything. A pinned skill drops out of the index;
 *    it is already here.
 *
 * There is no `skill` tool, deliberately. `docs/tools.md` opens by arguing that
 * the count of six built-ins is a decision, and a tool whose entire job is to
 * return the bytes of a workspace file is a worse `read_file` — one more name in
 * every agent's permission map, one more schema in every request, to reach a
 * file the agent could already open.
 *
 * ## Which half each part lands in
 *
 * The catalogue is a property of the workspace, so it goes in `staticSection` —
 * the provider's cached prefix, read once per turn. `@skill:` mentions are a
 * property of *this message*, so they go in `runtimeSection`. Putting a
 * per-turn value in the static half would end the session's cached prefix on
 * every turn, which is the cost the two-half split exists to avoid; see
 * `docs/prompts.md`.
 *
 * ## Nothing is cached on the instance
 *
 * One `AgentLoop` serves every session on an agent, and those sessions can be
 * bound to different workspaces. A contributor that remembered the catalogue it
 * read last turn would hand one workspace's skills to a concurrent turn in
 * another. So `staticSection` re-reads — which is a `readdir` and a handful of
 * small files, once per turn — and `runtimeSection` touches no state at all.
 */

import { silentLogger, type Logger } from '@ghostai/core';

import type {
  ContextContributor,
  RuntimePromptContext,
  StaticPromptContext,
} from './prompt.js';
import {
  SKILLS_DIRNAME,
  SKILL_FILENAME,
  readSkills,
  type Skill,
} from './skills.js';

const HEADING = '## Skills';

/**
 * Placed only when there is an index to explain.
 *
 * It names `read_file` because a list of files with no instruction to open them
 * is read as a list of things that exist, not as a list of things to use.
 */
const INDEX_PREAMBLE = [
  `Instruction sheets kept in this workspace under \`${SKILLS_DIRNAME}/\`.`,
  'Each line below is a summary, not the skill — open the file with',
  '`read_file` before acting on what it names.',
].join(' ');

export interface SkillBudget {
  /**
   * `pinnedSkills`, in the operator's order.
   *
   * Their order rather than the catalogue's, because the cap below truncates
   * this list and an operator who wrote three names expects the first two to
   * survive a cap of two.
   */
  readonly pinned: readonly string[];
  /** `maxPinnedSkills`. Names past it fall back to an index line. */
  readonly maxPinned: number;
}

/**
 * The section text for a catalogue and a budget.
 *
 * Pure, and separate from the contributor for that reason: the budget, the
 * ordering and what happens to a pin that names nothing are the parts worth
 * testing, and none of them needs a filesystem to test.
 *
 * An empty catalogue renders as `''`, never as a bare heading — `contributorSections`
 * drops a section that trims to nothing, so this is how "no skills" becomes "no
 * section" rather than a `## Skills` with nothing under it.
 */
export function renderSkills(
  skills: readonly Skill[],
  budget: SkillBudget,
): string {
  if (skills.length === 0) return '';

  const byName = new Map(skills.map((skill) => [skill.name, skill]));
  const pinned: Skill[] = [];
  const inlined = new Set<string>();
  for (const name of budget.pinned) {
    // Checked before the push, not after: a `maxPinned` of zero must pin
    // nothing, and a post-push check can never see a length of zero.
    if (pinned.length >= budget.maxPinned) break;
    const skill = byName.get(name);
    if (skill === undefined || inlined.has(name)) continue;
    inlined.add(name);
    pinned.push(skill);
  }

  const indexed = skills.filter((skill) => !inlined.has(skill.name));

  const sections: string[] = [HEADING];
  if (indexed.length > 0) {
    sections.push(INDEX_PREAMBLE, indexed.map(indexLine).join('\n'));
  }
  for (const skill of pinned) {
    sections.push(`### Skill: ${skill.name}\n\n${skill.body}`);
  }
  return sections.join('\n\n');
}

function indexLine(skill: Skill): string {
  return `- \`${skill.path}\` — **${skill.name}**: ${skill.description}`;
}

export interface SkillsContributorOptions extends SkillBudget {
  readonly logger?: Logger;
}

/** Reads the workspace's skills and places them in both halves of the prompt. */
export class SkillsContributor implements ContextContributor {
  readonly name: string = 'skills';

  private readonly pinned: readonly string[];
  private readonly maxPinned: number;
  private readonly logger: Logger;

  constructor(options: SkillsContributorOptions) {
    this.pinned = options.pinned;
    this.maxPinned = options.maxPinned;
    this.logger = options.logger ?? silentLogger;
  }

  async staticSection(
    context: StaticPromptContext,
  ): Promise<string | undefined> {
    const skills = await readSkills(context.workspaceRoot, {
      logger: this.logger,
    });
    if (skills.length === 0) return undefined;

    this.warnAboutPins(skills, context.workspaceId);
    return renderSkills(skills, {
      pinned: this.pinned,
      maxPinned: this.maxPinned,
    });
  }

  /**
   * The `@skill:` names on this message, as an instruction to go and read them.
   *
   * Deliberately not validated against the catalogue. This half is synchronous
   * and holds no state, so checking would mean either an I/O call per iteration
   * or a cache that the class does not keep for the reason in the file header. A
   * name that matches nothing costs one `read_file` that answers "no such file",
   * which the model recovers from; the alternative costs every turn.
   */
  runtimeSection(context: RuntimePromptContext): string | undefined {
    const named = context.mentions?.skill ?? [];
    if (named.length === 0) return undefined;

    const paths = named
      .map((name) => `\`${SKILLS_DIRNAME}/${name}/${SKILL_FILENAME}\``)
      .join(', ');
    return `Skills named on this message: read ${paths} before answering.`;
  }

  /**
   * Both ways a pin can be wrong, said once per turn.
   *
   * Neither is an error — a skill folder is workspace content and can change
   * under a config that named it — but both are silent from the model's side,
   * which is what makes them worth a log line.
   */
  private warnAboutPins(skills: readonly Skill[], workspaceId: string): void {
    const available = new Set(skills.map((skill) => skill.name));

    // Both counts are over *distinct* names, because `renderSkills` pins each
    // name once. Counting a list that repeats one would report a cap as
    // exceeded when nothing was dropped.
    const wanted = new Set(this.pinned);
    const missing = [...wanted].filter((name) => !available.has(name));
    if (missing.length > 0) {
      this.logger.warn(
        { workspaceId, missing },
        'pinnedSkills names a skill this workspace does not have',
      );
    }

    const present = wanted.size - missing.length;
    if (present > this.maxPinned) {
      this.logger.warn(
        { workspaceId, pinned: present, maxPinned: this.maxPinned },
        'more skills pinned than maxPinnedSkills allows; the rest are indexed',
      );
    }
  }
}
