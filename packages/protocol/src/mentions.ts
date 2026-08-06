/**
 * `@`-mention parsing.
 *
 * This lives in the protocol package, not in the WebSocket handler, so every
 * channel — web, Telegram, plugin channels, the scheduler's synthetic turns —
 * gets byte-identical behaviour from one tested implementation. Parsing
 * mentions at the transport layer instead is how `@skill:` ends up working in
 * the browser and silently doing nothing everywhere else.
 *
 * Grammar:
 *
 * ```
 *   mention  := "@" kind ":" value
 *   kind     := "mcp" | "skill"
 *   value    := '"' [^"]+ '"'          // quoted: may contain spaces
 *             | [^\s"@]+               // bare: trailing punctuation trimmed
 * ```
 *
 * Two rules worth stating because the naive alternation gets them wrong:
 *
 *  1. `@skill:""` yields no mention. An alternation that tries quoted-then-bare
 *     falls through to the bare branch and captures the literal `""` as a name.
 *  2. Bare values shed trailing punctuation, so `see @skill:deploy.` names
 *     `deploy` rather than `deploy.`. Quote the value to keep punctuation.
 */

/** The mention namespaces GhostAI understands. */
export const MENTION_KINDS = ['mcp', 'skill'] as const;

export type MentionKind = (typeof MENTION_KINDS)[number];

/** A single mention occurrence, with its span in the source text. */
export interface Mention {
  readonly kind: MentionKind;
  readonly value: string;
  /** Index of the `@`. */
  readonly start: number;
  /** Index one past the last character of the mention (punctuation excluded). */
  readonly end: number;
}

export interface ParsedMentions {
  /** MCP servers to restrict tool exposure to. De-duplicated, first-seen order. */
  readonly mcp: readonly string[];
  /** Skills whose whole sheet is inlined for this turn. */
  readonly skill: readonly string[];
  /** Every occurrence in source order, including repeats. */
  readonly all: readonly Mention[];
}

/**
 * Bare values stop at whitespace, a quote, or a second `@`. Excluding `@` is
 * what makes adjacent mentions (`@mcp:a@skill:b`) parse as two rather than one
 * mention whose value swallowed the next.
 */
const MENTION_PATTERN = /@(mcp|skill):(?:"([^"]+)"|([^\s"@]+))/g;

/** Sentence punctuation that is far more likely to be prose than part of a name. */
const TRAILING_PUNCTUATION = /[.,;:!?)\]}>]+$/;

export function isMentionKind(value: string): value is MentionKind {
  return (MENTION_KINDS as readonly string[]).includes(value);
}

/**
 * Extract `@mcp:` and `@skill:` mentions from message text.
 *
 * The text is never modified — the model sees what the user typed. Callers use
 * the returned spans if they want to render or strip the mentions.
 */
export function parseMentions(text: string): ParsedMentions {
  const all: Mention[] = [];
  const buckets: Record<MentionKind, string[]> = { mcp: [], skill: [] };
  const seen: Record<MentionKind, Set<string>> = {
    mcp: new Set(),
    skill: new Set(),
  };

  for (const match of text.matchAll(MENTION_PATTERN)) {
    const kind = match[1];
    const quoted = match[2];
    const bare = match[3];

    // The alternation guarantees a kind and exactly one value branch; the
    // checks are here because `noUncheckedIndexedAccess` types groups as
    // possibly-undefined, and a bad cast would be a worse trade.
    if (kind === undefined || !isMentionKind(kind)) continue;

    let value: string;
    let end: number;
    if (quoted !== undefined) {
      value = quoted;
      end = match.index + match[0].length;
    } else if (bare !== undefined) {
      value = bare.replace(TRAILING_PUNCTUATION, '');
      // Shrink the reported span by whatever punctuation was trimmed.
      end = match.index + match[0].length - (bare.length - value.length);
    } else {
      continue;
    }

    // `@skill:...` trims to nothing — punctuation, not a name.
    if (value === '') continue;

    all.push({ kind, value, start: match.index, end });
    if (!seen[kind].has(value)) {
      seen[kind].add(value);
      buckets[kind].push(value);
    }
  }

  return { mcp: buckets.mcp, skill: buckets.skill, all };
}
