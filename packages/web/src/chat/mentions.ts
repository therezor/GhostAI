/**
 * The `@` autocomplete, over the protocol's own mention grammar.
 *
 * `parseMentions` in `@ghostai/protocol` is what the server runs, and it answers
 * "what mentions are in this finished message". The composer needs the other
 * question — "is the caret inside a mention that is still being typed, and what
 * would complete it" — which no parser of finished text can answer. So this
 * file owns the partial case and defers to the protocol for everything else:
 * the kinds come from `MENTION_KINDS`, and `mentionsIn` is a straight
 * re-export, so a fourth namespace added there appears here without an edit.
 *
 * What it deliberately does *not* do is offer values. `@kb:`, `@mcp:` and
 * `@skill:` scope to a knowledge base, an MCP server and a skill — none of which
 * exist before Phase 3. A completion list populated from nothing is a menu that
 * says "no results" for a feature that was never turned on, which reads as
 * broken rather than as absent. Until there is a catalogue to read, the
 * autocomplete completes the namespace and gets out of the way.
 */

import {
  MENTION_KINDS,
  parseMentions,
  type MentionKind,
} from '@ghostai/protocol';

export { parseMentions as mentionsIn };

/** A mention being typed at the caret. */
export interface MentionQuery {
  /** Index of the `@` in the source text. */
  readonly start: number;
  /** The caret. Everything between `start` and here is what has been typed. */
  readonly end: number;
  /** The namespace, once the colon has been typed. */
  readonly kind: MentionKind | undefined;
  /**
   * What has been typed after `@`, or after `kind:` once there is a kind.
   * Lower-cased, because the namespaces are.
   */
  readonly query: string;
}

export interface MentionSuggestion {
  /** What replaces the query. Includes the trailing colon for a namespace. */
  readonly insert: string;
  readonly label: string;
  readonly hint: string;
}

/**
 * The mention under the caret, if there is one.
 *
 * A mention only starts at a word boundary — an email address is not a mention,
 * and neither is the `@` in `user@host`. It ends at whitespace, which is also
 * what closes it: moving the caret past a space means the mention is finished
 * and there is nothing to complete.
 */
export function mentionAtCaret(
  text: string,
  caret: number,
): MentionQuery | undefined {
  const before = text.slice(0, caret);

  // Search backwards for the `@` that opens the run the caret is in. A space
  // or a second `@` ends the search: the grammar excludes both from a value.
  let start = -1;
  for (let index = before.length - 1; index >= 0; index -= 1) {
    const character = before[index];
    if (character === undefined || /\s/.test(character)) break;
    if (character === '@') {
      start = index;
      break;
    }
  }

  if (start === -1) return undefined;

  // `a@kb:x` is an address fragment, not a mention. The protocol's own pattern
  // does not anchor, but every real mention in practice starts a word.
  const preceding = start === 0 ? undefined : text[start - 1];
  if (preceding !== undefined && !/[\s([]/.test(preceding)) return undefined;

  const typed = before.slice(start + 1);
  const colon = typed.indexOf(':');

  if (colon === -1) {
    return { start, end: caret, kind: undefined, query: typed.toLowerCase() };
  }

  const kind = typed.slice(0, colon).toLowerCase();
  if (!isMentionKind(kind)) return undefined;

  return { start, end: caret, kind, query: typed.slice(colon + 1) };
}

/**
 * What could complete this query.
 *
 * Empty once a namespace has been chosen — see the file docblock. An empty list
 * is what the caller renders as "no popover", not as "nothing found".
 */
export function mentionSuggestions(
  query: MentionQuery,
): readonly MentionSuggestion[] {
  if (query.kind !== undefined) return [];

  return MENTION_KINDS.filter((kind) => kind.startsWith(query.query)).map(
    (kind) => ({
      insert: `@${kind}:`,
      label: `@${kind}:`,
      hint: HINTS[kind],
    }),
  );
}

const HINTS: Record<MentionKind, string> = {
  kb: 'Scope retrieval to a knowledge base',
  mcp: 'Restrict tools to one MCP server',
  skill: 'Pin a skill into this turn',
};

/** The text and caret after accepting a suggestion. */
export function applyMention(
  text: string,
  query: MentionQuery,
  suggestion: MentionSuggestion,
): { readonly text: string; readonly caret: number } {
  const next =
    text.slice(0, query.start) + suggestion.insert + text.slice(query.end);
  return { text: next, caret: query.start + suggestion.insert.length };
}

function isMentionKind(value: string): value is MentionKind {
  return (MENTION_KINDS as readonly string[]).includes(value);
}
