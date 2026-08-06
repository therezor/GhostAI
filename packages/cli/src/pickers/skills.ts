/**
 * Skills, as rows — and the Tab completion that reaches them.
 *
 * `@skill:code-review` inlines that sheet into one message, so the name has to
 * be exact and it is the one thing a person cannot see from the terminal: the
 * catalogue is in the model's prompt, not on the screen. This is the half that
 * puts it on the screen.
 *
 * **Tab, not a second shortcut.** `chat.ts` argues that Ctrl-G is the only
 * binding worth spending and that Tab completes "only a slash command", because
 * a completer guessing at the middle of a sentence surprises more than it helps.
 * Both still hold: `@skill:` is a token with a known vocabulary, exactly as a
 * slash command is, and completion here is inert anywhere else in the line. What
 * would break the rule is completing bare words, and nothing does.
 */

import type { Skill } from '@ghostai/agent';
import type { SelectItem } from '@ghostai/tui';

import type { CliT } from '../i18n.js';
import type { Menu } from '../menu.js';

/** The prefix that opens a mention, and the only thing Tab acts on. */
const MENTION_PREFIX = '@skill:';

export interface SkillPickerDeps {
  readonly menu: Menu;
  readonly skills: readonly Skill[];
  readonly t: CliT;
}

export function skillItems(
  skills: readonly Skill[],
): Array<SelectItem<string>> {
  return skills.map((skill) => ({
    value: skill.name,
    label: `${MENTION_PREFIX}${skill.name}`,
    hint: skill.description,
  }));
}

export async function pickSkill(
  deps: SkillPickerDeps,
): Promise<string | undefined> {
  return await deps.menu.choose({
    items: skillItems(deps.skills),
    labels: {
      title: deps.t('menu.titles.skill'),
      empty: deps.t('menu.emptySkills'),
      footer: deps.t('menu.footer'),
    },
  });
}

/**
 * The partial name being typed at the end of the line, if there is one.
 *
 * `undefined` rather than an empty string when the line is not in a mention,
 * because "no mention here" and "a mention with nothing typed yet" want
 * different answers — the second should offer the whole catalogue.
 *
 * Only the *end* of the line counts. A `@skill:` earlier in a finished sentence
 * has already been typed, and completing it would rewrite text behind the
 * cursor.
 */
export function mentionPrefix(line: string): string | undefined {
  const at = line.lastIndexOf(MENTION_PREFIX);
  if (at < 0) return undefined;

  const typed = line.slice(at + MENTION_PREFIX.length);
  // The pattern in `@ghostai/protocol` ends a bare name at whitespace, a quote
  // or a second `@`, so anything holding one of those is a finished mention and
  // not the thing being typed.
  return /[\s"@]/u.test(typed) ? undefined : typed;
}

/**
 * Tab completion for a skill name, mirroring `completeCommand`.
 *
 * Returns the names that extend what is typed. The caller decides what a single
 * match means, on the same rule the command completer keeps: one match is
 * inserted, several are left for the picker.
 */
export function completeSkill(
  line: string,
  skills: readonly Skill[],
): readonly string[] {
  const typed = mentionPrefix(line);
  if (typed === undefined) return [];
  return skills
    .map((skill) => skill.name)
    .filter((name) => name.startsWith(typed));
}

/** The line with its half-typed mention completed to `name`. */
export function applySkill(line: string, name: string): string {
  const at = line.lastIndexOf(MENTION_PREFIX);
  if (at < 0) return line;
  return `${line.slice(0, at)}${MENTION_PREFIX}${name} `;
}
