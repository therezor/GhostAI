/**
 * Reasoning effort, as rows.
 *
 * The one picker whose list is a *schema* rather than a catalogue: the levels
 * are `ReasoningEffortSchema.options`, read from the schema so a level added
 * there appears here without a second list to remember. Everything else in this
 * folder turns records the runtime holds into rows; this turns an enum into
 * them, and the split-in-two shape is the same — `effortItems` is pure, and
 * `pickEffort` is the five lines that hand its rows to a menu.
 *
 * **`reset` is a row, not a level.** It is what "send no reasoning parameter at
 * all" is called at the prompt, and it has to be pickable for the same reason it
 * has to be typeable: unset and `off` are different requests, and a menu that
 * only offered the six levels would make one of them unreachable without going
 * to the settings panel. Its value is the literal word, so a level chosen from
 * the menu and one typed after the command take the same path.
 *
 * The hints are deliberately thin. Which levels mean anything is the model's
 * business rather than this project's — `minimal` is OpenAI's and `xhigh` is
 * Qwen3.8's top rung — so the two rows that carry a hint are the two whose
 * *mechanism* differs, and the rest say only whether they are the one in force.
 */

import {
  ReasoningEffortSchema,
  type ReasoningEffort,
} from '@ghostwire/protocol';
import type { SelectItem } from '@ghostwire/tui';

import type { CliT } from '../i18n.js';
import type { Menu } from '../menu.js';

/**
 * The word for "send nothing and let the provider decide".
 *
 * `default` names the outcome, and the outcome is now the same on every agent:
 * an entry that states no effort sends no reasoning parameter, so what arrives
 * is the provider's own default. There is nothing above an agent for the word
 * to be ambiguous about — which is what makes it available at all. It was not,
 * while a cleared field fell through to another agent's answer.
 *
 * Defined here because this is where it has to exist as *data* — a menu row
 * needs a value — and imported by `commands.ts`, which needs it as a word.
 * `/temperature default` reads it too: one spelling, one definition, so the
 * menu and the parser cannot drift apart on it.
 *
 * Not translated, for the reason a command name is not: it is what an operator
 * types, so it is syntax.
 */
export const DEFAULT_LEVEL = 'default';

interface EffortPickerDeps {
  readonly menu: Menu;
  /** The level in force, or `undefined` when this agent states none. */
  readonly current: ReasoningEffort | undefined;
  readonly t: CliT;
}

/** The row that clears, first — it is the state an agent starts in. */
function rows(t: CliT): Array<{ value: string; label: string; hint: string }> {
  return [
    {
      value: DEFAULT_LEVEL,
      label: DEFAULT_LEVEL,
      hint: t('menu.efforts.default'),
    },
    ...ReasoningEffortSchema.options.map((level) => ({
      value: level,
      label: level,
      hint: level === 'off' ? t('menu.efforts.off') : '',
    })),
  ];
}

/** Which row is in force. Stating none is `default`, which is a real answer. */
function currentValue(current: ReasoningEffort | undefined): string {
  return current ?? DEFAULT_LEVEL;
}

export function effortItems(
  current: ReasoningEffort | undefined,
  t: CliT,
): Array<SelectItem<string>> {
  const inForce = currentValue(current);
  return rows(t).map((row) => {
    const mark = row.value === inForce ? t('menu.current') : '';
    const hint =
      row.hint === '' ? mark : mark === '' ? row.hint : `${row.hint} · ${mark}`;
    return { value: row.value, label: row.label, hint };
  });
}

/** The listing, for a terminal that cannot draw a menu. */
export function effortListing(
  current: ReasoningEffort | undefined,
  t: CliT,
): string {
  const inForce = currentValue(current);
  return rows(t)
    .map((row) => {
      const mark = row.value === inForce ? '*' : ' ';
      return row.hint === ''
        ? `${mark} ${row.label}`
        : `${mark} ${row.label}  ·  ${row.hint}`;
    })
    .join('\n');
}

/** Opens the menu on the level in force. `undefined` if it was cancelled. */
export async function pickEffort(
  deps: EffortPickerDeps,
): Promise<string | undefined> {
  const items = effortItems(deps.current, deps.t);
  const at = items.findIndex(
    (item) => item.value === currentValue(deps.current),
  );

  return await deps.menu.choose({
    items,
    labels: {
      title: deps.t('menu.titles.effort'),
      empty: deps.t('menu.empty'),
      footer: deps.t('menu.footer'),
    },
    ...(at < 0 ? {} : { index: at }),
  });
}
