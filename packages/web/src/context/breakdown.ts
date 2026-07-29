/**
 * The token budget, turned into something a bar can be drawn from.
 *
 * `GET /api/sessions/:key/context` answers with a number and a record of named
 * sections, and the panel's whole purpose is answering *which* block got too
 * big. That makes three things this module has to get right, none of which
 * belong in a component:
 *
 *  - **Order.** The prompt, the tools and the messages are three costs an
 *    operator compares against each other every time they open this, so they
 *    always appear in that order regardless of the key order the JSON happened
 *    to arrive in. A section neither this file nor the server's current
 *    implementation knows about still renders — sorted after the known ones —
 *    so adding memory or knowledge on the server does not need a change here.
 *  - **The gap.** `estimatedTokens` is the server's own total; the sections do
 *    not have to sum to it. Whatever is unaccounted for is shown as one segment
 *    rather than silently dropped, because a bar that does not add up to the
 *    number printed above it is a bar nobody trusts twice.
 *  - **Overflow.** A window can be exceeded — that is precisely the state this
 *    panel exists to make visible — so the percentages are of the *window*, and
 *    the caller is told when they sum past 100 rather than being handed
 *    silently normalised values that make an overflowing budget look full.
 */

import type { TFunction } from 'i18next';

import type { WebKey } from '@/i18n/keys.js';

/** The order the three sections the server reports are always shown in. */
const KNOWN_ORDER: readonly string[] = ['systemPrompt', 'tools', 'messages'];

const LABELS: Readonly<Record<string, WebKey>> = {
  systemPrompt: 'context.labels.systemPrompt',
  tools: 'context.labels.tools',
  messages: 'context.labels.messages',
  other: 'context.labels.other',
};

export interface ContextSegment {
  /** The breakdown key, or `other` for the unaccounted remainder. */
  readonly key: string;
  readonly label: string;
  readonly tokens: number;
  /** Share of the context window, 0–100, unclamped so overflow stays visible. */
  readonly percent: number;
}

export interface ContextBudget {
  readonly segments: readonly ContextSegment[];
  readonly usedTokens: number;
  readonly windowTokens: number;
  readonly usedPercent: number;
  /** What is left, floored at zero: a negative "remaining" is not a quantity. */
  readonly freeTokens: number;
  readonly over: boolean;
}

export interface ContextInput {
  readonly breakdown: Readonly<Record<string, number>>;
  readonly estimatedTokens: number;
  readonly contextWindowTokens: number;
}

export function summariseContext(
  { breakdown, estimatedTokens, contextWindowTokens }: ContextInput,
  t: TFunction,
): ContextBudget {
  const windowTokens = contextWindowTokens > 0 ? contextWindowTokens : 0;
  const percentOf = (tokens: number): number =>
    windowTokens === 0 ? 0 : (tokens / windowTokens) * 100;

  const named = Object.entries(breakdown)
    .map(([key, tokens]) => ({ key, tokens: Math.max(0, tokens) }))
    .sort(compareSections);

  const accounted = named.reduce((total, section) => total + section.tokens, 0);
  const remainder = Math.max(0, estimatedTokens - accounted);
  const sections = remainder > 0 ? [...named, { key: 'other', tokens: remainder }] : named;

  return {
    segments: sections.map(({ key, tokens }) => ({
      key,
      label: labelFor(key, t),
      tokens,
      percent: percentOf(tokens),
    })),
    usedTokens: estimatedTokens,
    windowTokens,
    usedPercent: percentOf(estimatedTokens),
    freeTokens: Math.max(0, windowTokens - estimatedTokens),
    over: estimatedTokens > windowTokens,
  };
}

/** Known sections in their fixed order, then everything else alphabetically. */
function compareSections(a: { key: string }, b: { key: string }): number {
  const rankA = KNOWN_ORDER.indexOf(a.key);
  const rankB = KNOWN_ORDER.indexOf(b.key);
  if (rankA !== -1 && rankB !== -1) return rankA - rankB;
  if (rankA !== -1) return -1;
  if (rankB !== -1) return 1;
  return a.key.localeCompare(b.key);
}

/**
 * `camelCase` and `snake_case` become words when the key is one this file has
 * never heard of, so a section the server adds tomorrow reads as "Knowledge
 * base" rather than `knowledge_base`.
 */
/**
 * The four sections the server reports have translations; anything else does
 * not, and cannot. A newer server may name a section this build has never heard
 * of, and there is no key to look up for it — so the fallback below derives
 * something readable from the identifier rather than rendering a missing key.
 * That is the one place in the UI where English leaks through by design.
 */
function labelFor(key: string, t: TFunction): string {
  const known = LABELS[key];
  if (known !== undefined) return t(known);

  const words = key
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .trim();
  return words === '' ? key : words.charAt(0).toUpperCase() + words.slice(1);
}
