/**
 * What the REPL says about itself: once at the top, and once under every prompt.
 *
 * Both are functions over one plain record — no runtime, no store, no session —
 * which is what makes them assertable without booting anything, and why the
 * caller does the looking-up.
 *
 * **The frame has a rule above the editor and one below, and they are drawn by
 * different things.** The one below is part of the status bar, under the cursor,
 * where a prompt string cannot reach. The one above *is* the prompt — the only
 * part of the frame written into the scrollback — so the caller takes the whole
 * prompt block down again when a turn starts and prints the message itself.
 * That is why the rule is a function here rather than a constant in the prompt:
 * both halves are the same width, measured the same way.
 *
 * The two rows are laid out with `justify`, so the fields that change — the
 * context budget and the model — are the ones anchored to the right edge and
 * the workspace name is what gets truncated when the window is narrow.
 */

import {
  justify,
  padToWidth,
  rule,
  truncateToWidth,
  type Theme,
} from '@ghostwire/tui';

import type { CliKey, CliT } from './i18n.js';

/** How much of the model's window the next turn would fill. */
export interface ContextUsage {
  readonly usedTokens: number;
  readonly windowTokens: number;
}

export interface HeaderView {
  /** The agent's label, or its id when it has no label of its own. */
  readonly agent: string;
  readonly model: string;
  readonly provider: string;
  /** The workspace *directory*, which is what the startup header shows. */
  readonly workspace: string;
  /** The workspace's name in the registry, which is what the bar shows. */
  readonly workspaceName: string;
  /** The conversation's title, falling back to its key. */
  readonly session: string;
  /** Absent until a turn has run and there is something to measure. */
  readonly context: ContextUsage | undefined;
}

interface Row {
  readonly key: CliKey;
  readonly value: string;
}

function rowsFor(view: HeaderView): readonly Row[] {
  return [
    { key: 'chat.header.agent', value: view.agent },
    { key: 'chat.header.model', value: view.model },
    { key: 'chat.header.provider', value: view.provider },
    { key: 'chat.header.workspace', value: view.workspace },
    { key: 'chat.header.session', value: view.session },
  ];
}

/**
 * The block printed once, when the prompt opens.
 *
 * The label column is measured rather than typed out, for the reason `helpText`
 * and `serve.ts`'s banner both give: a run of hand-counted spaces holds only
 * until the first translation is longer than the English it replaced, and then
 * it is wrong for every row at once.
 */
export function startupHeader(
  view: HeaderView,
  width: number,
  theme: Theme,
  t: CliT,
  shortcuts: boolean,
): string {
  const rows = rowsFor(view);
  const column = Math.max(...rows.map((row) => t(row.key).length));

  const lines = rows.map((row) =>
    truncateToWidth(
      `  ${theme.dim(padToWidth(t(row.key), column))}  ${row.value}`,
      width,
    ),
  );

  const hint = shortcuts ? t('chat.header.hintMenu') : t('chat.header.hint');
  return [
    theme.title(theme.accent('  ghost')),
    ...lines,
    '',
    truncateToWidth(`  ${theme.dim(hint)}`, width),
    // A trailing blank, which the frame's own gap above the editor then
    // doubles: the welcome is a block about the install rather than part of
    // the conversation, and one line of gap reads as though it were the first
    // message.
    '',
  ].join('\n');
}

/** `12.4%/128k`, or nothing at all before a turn has been measured. */
export function contextLabel(context: ContextUsage | undefined): string {
  if (context === undefined || context.windowTokens <= 0) return '';
  const percent = (context.usedTokens / context.windowTokens) * 100;
  const window = Math.round(context.windowTokens / 1000);
  return `${percent.toFixed(1)}%/${String(window)}k`;
}

/**
 * The rule and the two status rows that sit under the editor.
 *
 * Returned as lines rather than a string because `BottomBar` addresses one row
 * at a time, and because the height is what the caller has to reserve before
 * the prompt is drawn.
 */
export function statusBar(
  view: HeaderView,
  width: number,
  theme: Theme,
): string[] {
  const context = contextLabel(view.context);
  const model =
    view.provider === '' ? view.model : `${view.provider}/${view.model}`;

  return [
    theme.dim(rule(width)),
    theme.dim(justify(view.workspaceName, view.agent, width)),
    theme.dim(justify(context, model, width)),
  ];
}

/**
 * The rule above the editor, which the prompt string carries.
 *
 * One column short of the window, like the rows below it: writing exactly
 * `columns` characters leaves a terminal in a pending-wrap state that emulators
 * resolve differently, and everything here is followed by cursor motion that
 * assumes it knows which row it is on.
 */
export function inputRule(width: number, theme: Theme): string {
  return theme.dim(rule(width));
}
