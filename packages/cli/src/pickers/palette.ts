/**
 * Every slash command, as one searchable list.
 *
 * The rows come from `commands.ts`'s own help table rather than a second list
 * beside it — one table, so a command cannot exist in the palette and not in
 * `/help`, or the other way round. The arrow points one way: this file imports
 * `commands.ts` and `commands.ts` does not import this one.
 *
 * **A row that needs an argument is typed, not run.** `/rename <title>` submitted
 * on its own is a usage error the operator has to read and then retype around,
 * so the palette puts `/rename ` in the editor and leaves the cursor after it.
 * A row that needs nothing — `/help`, `/agent`, `/context` — is submitted
 * outright, because there is nothing left to say.
 */

import type { SelectItem } from '@ghostwire/tui';

import { commandRows, type CommandRow } from '../commands.js';
import type { CliT } from '../i18n.js';
import type { Menu } from '../menu.js';

interface CommandChoice {
  /** What to put on the line: `/workspace move`, not `/workspace move <a> <b>`. */
  readonly command: string;
  /** Whether to press Return, or leave the operator typing the arguments. */
  readonly submit: boolean;
}

interface PalettePickerDeps {
  readonly menu: Menu;
  readonly t: CliT;
  /**
   * Every command, including the ones extensions contribute.
   *
   * Passed in rather than computed here, because it changes while the REPL is
   * running: approving an extension in a browser adds a command to a terminal
   * that is already open, and a constant captured at start-up would not have
   * it. `commandRowsFor` is what the caller reads.
   */
  readonly rows: readonly CommandRow[];
}

/**
 * The typeable part of a row's syntax.
 *
 * `/workspace move <from> <to>` → `/workspace move`, `/agent [id]` → `/agent`,
 * `/exit, /quit` → `/exit`. Placeholders end it, and so does the comma that
 * separates a command from its alias — an alias is the same command, and
 * offering both would double a list whose whole value is being short.
 */
export function commandValue(syntax: string): string {
  const words: string[] = [];
  for (const word of syntax.split(/\s+/u)) {
    if (word.startsWith('<') || word.startsWith('[')) break;
    if (word.endsWith(',')) {
      words.push(word.slice(0, -1));
      break;
    }
    words.push(word);
  }
  return words.join(' ');
}

/** Whether a row cannot run without something the operator has yet to type. */
function needsArgument(syntax: string): boolean {
  return syntax.includes('<');
}

export function commandItems(
  rows: readonly CommandRow[],
  t: CliT,
): Array<SelectItem<CommandChoice>> {
  return rows.map((row) => ({
    value: {
      command: commandValue(row.syntax),
      submit: !needsArgument(row.syntax),
    },
    label: row.syntax,
    ...(row.key === undefined ? {} : { hint: t(row.key) }),
  }));
}

export async function pickCommand(
  deps: PalettePickerDeps,
): Promise<CommandChoice | undefined> {
  return await deps.menu.choose({
    items: commandItems(deps.rows, deps.t),
    labels: {
      title: deps.t('menu.titles.command'),
      empty: deps.t('menu.empty'),
      footer: deps.t('menu.footer'),
    },
  });
}

/**
 * Tab completion, for readline's `completer`.
 *
 * Only ever completes a slash command: a prompt is mostly prose, and a completer
 * that guessed at the middle of a sentence would be a Tab key that inserted
 * something surprising far more often than it helped.
 */
export function completeCommand(
  line: string,
  rows: readonly CommandRow[] = commandRows(),
): [string[], string] {
  if (!line.startsWith('/')) return [[], line];
  const values = new Set(rows.map((row) => commandValue(row.syntax)));
  return [[...values].filter((value) => value.startsWith(line)), line];
}
