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
 * **It offers values for `@skill:` and for nothing else**, and the asymmetry is
 * the honest state of the two namespaces rather than an oversight. Naming a
 * skill inlines its sheet into that message, so the completion leads somewhere
 * the turn will actually go. `@mcp:` does not: honouring it means narrowing a
 * turn's tool scope, which is `AgentLoop`'s business rather than this file's.
 * Offering a value the turn will then ignore is worse than offering none — a
 * list that completes to something inert reads as broken, where a namespace
 * that completes and stops reads as absent. So `@mcp:` completes the namespace
 * and gets out of the way.
 */

import {
  MENTION_KINDS,
  parseMentions,
  type MentionKind,
  type SkillSummary,
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

  // `a@skill:x` is an address fragment, not a mention. The protocol's pattern
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
 * An empty list is what the caller renders as "no popover", not as "nothing
 * found" — which is why `@mcp:` returns one: see the file docblock.
 *
 * `skills` is the workspace's catalogue, and an empty array is the honest answer
 * while it is still being fetched. The popover simply does not open until it
 * arrives, rather than flashing "no results" at a workspace that has plenty.
 */
export function mentionSuggestions(
  query: MentionQuery,
  skills: readonly SkillSummary[] = [],
): readonly MentionSuggestion[] {
  if (query.kind === 'skill') {
    const typed = query.query.toLowerCase();
    return skills
      .filter((skill) => skill.name.toLowerCase().startsWith(typed))
      .map((skill) => ({
        // The trailing space closes the mention, so the next word is prose
        // rather than more of the name.
        insert: `@skill:${skill.name} `,
        label: `@skill:${skill.name}`,
        hint: skill.description,
      }));
  }

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
  mcp: 'Restrict tools to one MCP server',
  skill: 'Send a skill’s whole sheet with this message',
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
