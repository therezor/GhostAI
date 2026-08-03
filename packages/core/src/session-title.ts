/**
 * Naming a conversation from the first thing said in it.
 *
 * A session row has always had a `title`, and nothing ever wrote one — so every
 * list of conversations was a list of opaque keys. The fix is deliberately not a
 * model call: a summariser would cost a request, a provider dependency and a
 * failure mode on the hot path of the very first turn, to name something the
 * user is about to read anyway. The first message is what they typed; the first
 * line of it is almost always what the conversation is about.
 *
 * This is a pure function, and it lives here rather than in the agent because
 * the *caller* is the agent loop — which is what makes the CLI, the web and any
 * future channel derive titles identically, without one of them being the
 * "real" implementation the others copy.
 *
 * What it strips is chosen by what a first message actually looks like. Fenced
 * code is the common case that ruins a title: someone pastes a stack trace under
 * one line of question, and a naive slice names the conversation after the
 * stack. Mentions are scoping directives rather than subject matter — a title of
 * `@kb:runbooks how do I rotate` reads as noise where `how do I rotate` reads as
 * the question. Markdown furniture is stripped for the same reason a heading is
 * not part of its own text.
 */

/**
 * The character budget for a derived title.
 *
 * Wide enough to hold a real sentence, narrow enough that the sidebar truncates
 * with CSS rather than the row growing — the column is `--layout-sidebar` and
 * the rows are single-line.
 */
export const MAX_TITLE_CHARS = 60;

/**
 * How far back from the budget a space still counts as a word boundary.
 *
 * A third. Nearer than that and the title loses a visible amount of its last
 * word's worth of content to avoid a hyphen nobody would have noticed; further
 * and a message with one early space gets cut to almost nothing.
 */
const BOUNDARY_FRACTION = 1 / 3;

const FENCED_CODE = /```[\s\S]*?```/gu;
const MENTION = /@(?:kb|mcp|skill):[\w./-]+/gu;
/** Leading list markers, headings and quotes — per line, not per string. */
const LINE_FURNITURE =
  /^[ \t]*(?:#{1,6}[ \t]+|>[ \t]*|[-*][ \t]+|\d+\.[ \t]+)/gmu;

/**
 * A conversation title derived from its first message, or `''` when there is
 * nothing worth naming it after.
 *
 * The empty return is meaningful: the caller writes nothing, leaving the stored
 * title empty so that a later message — or a manual rename — can still claim it.
 */
export function deriveSessionTitle(
  text: string,
  maxChars: number = MAX_TITLE_CHARS,
): string {
  if (maxChars <= 0) return '';

  // Code first: it can contain anything the later passes look for, including
  // `#` comments and lines that read as list items.
  let cleaned = text.replaceAll(FENCED_CODE, ' ');

  // A message that was *only* code still deserves a name, and the code is the
  // one thing available to name it after. Backticks come off so the title is
  // the identifier rather than the markup around it.
  if (cleaned.trim() === '') cleaned = text.replaceAll('`', ' ');

  cleaned = cleaned.replaceAll(MENTION, ' ').replaceAll(LINE_FURNITURE, ' ');

  const flat = cleaned.replaceAll(/\s+/gu, ' ').trim();
  if (flat === '') return '';
  if (flat.length <= maxChars) return flat;

  // The ellipsis is inside the budget, matching `clip()` in the CLI renderer —
  // a "60 character" title that renders 61 is a column that overflows by one.
  const room = maxChars - 1;
  const boundary = flat.lastIndexOf(' ', room);
  const cut =
    boundary >= Math.floor(room * (1 - BOUNDARY_FRACTION)) ? boundary : room;

  return `${flat.slice(0, cut).trimEnd()}…`;
}
