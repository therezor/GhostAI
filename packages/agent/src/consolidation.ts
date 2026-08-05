/**
 * Compression: turning the oldest half of a conversation into a memory entry.
 *
 * This module is the pure half — records in, a span and some strings out. It
 * touches no filesystem, no store and no provider, which is what lets the
 * decisions worth arguing about be tested with literals. `consolidator.ts` is
 * the half that does I/O.
 *
 * ## It is not automatic, and that is the design
 *
 * Nothing here runs on a timer or at the end of a turn. A person runs
 * `/memory compress`. Two reasons: a fold costs a provider round trip, and
 * putting one in front of a turn's first token buys nothing for the turn that
 * paid for it; and a summary is lossy in a way a person may want to look at
 * before it becomes the only copy. `CONSOLIDATE_AT_FRACTION` exists to *suggest*
 * compressing, never to trigger it.
 *
 * ## The cut is a `user` message, always
 *
 * `selectSpan` never cuts anywhere else. That is the load-bearing decision in
 * this file, and it is what keeps `@ghostai/core` unchanged: a window that opens
 * on a `user` message cannot begin with a `tool` result whose `assistant` was
 * left behind, so `lastConsolidatedSeq` is legal by construction and
 * `findLegalStart` has nothing to repair. Cutting anywhere else would need
 * `SessionStore`'s private `legalSeq`, and would silently drop messages nothing
 * had summarised whenever the boundary landed mid-exchange.
 */

import { textOf, truncateHeadTail, type MemorySection } from '@ghostai/core';
import type { ChatMessage } from '@ghostai/protocol';
import { estimateTokens } from '@ghostai/providers';

/**
 * User turns never folded, however large the history is.
 *
 * The tail of a conversation is the part the next turn is actually about, and a
 * summary of "what we were just doing" is strictly worse than the messages. Four
 * is enough to keep a question, its answer, a correction and the reply.
 */
export const KEEP_RECENT_TURNS = 4;

/**
 * The share of the context window above which compressing is *worth suggesting*.
 *
 * Advisory. Nothing reads this to decide to act — `/memory` prints a nudge when
 * history is over it, and that is all. It is a constant rather than a config key
 * because a number nobody can act on automatically is not a setting.
 */
export const CONSOLIDATE_AT_FRACTION = 0.5;

/** The share of the context window a compression aims to get history down to. */
export const CONSOLIDATE_TO_FRACTION = 0.3;

/** What one `tool` result may contribute to a summarising request. */
const MAX_TOOL_CHARS = 500;

export const CONSOLIDATE_INSTRUCTION: string = [
  'You are compressing the earliest part of a conversation so it can be',
  'dropped from the context window without losing what it established.',
  '',
  'Write terse bullets recording only what stays true afterwards: decisions',
  'made, preferences stated, facts discovered about the project, and problems',
  'ruled out. Skip pleasantries, skip what was merely attempted, and skip',
  'anything the files themselves already say.',
  '',
  'Write nothing but the bullets. No preamble, no heading, no closing summary.',
].join('\n');

export const COMPACT_INSTRUCTION: string = [
  'You are shortening an agent’s accumulated notes about a workspace.',
  '',
  'Merge duplicates, drop what has been superseded, and keep every fact that',
  'still holds. Preserve specifics — names, paths, commands, numbers — in',
  'preference to the sentences around them.',
  '',
  'Write nothing but the merged bullets. No preamble, no heading.',
].join('\n');

/** The oldest messages, and where the marker moves to once they are folded. */
export interface Span {
  /**
   * The seq to advance `lastConsolidatedSeq` to.
   *
   * Always the seq immediately before a `user` message, so the window that
   * remains opens on a complete turn.
   */
  readonly cut: number;
  readonly messages: readonly ChatMessage[];
}

/** What `selectSpan` needs of a stored record. Structural, so a test can fake it. */
export interface SpanRecord {
  readonly seq: number;
  readonly message: ChatMessage;
}

export interface SelectSpanOptions {
  /** `KEEP_RECENT_TURNS`. User turns at the end that are never folded. */
  readonly keepTurns: number;
  /** The token size history should end up under. */
  readonly toTokens: number;
}

/**
 * The oldest messages worth folding, or `undefined` when there is no work.
 *
 * Returns `undefined` rather than an empty span in three cases that are all
 * "nothing to do" rather than failures: history is already under the target,
 * there are not enough user turns to keep any back, and keeping the recent turns
 * would leave nothing on the other side of the cut.
 */
export function selectSpan(
  records: readonly SpanRecord[],
  options: SelectSpanOptions,
): Span | undefined {
  if (records.length === 0) return undefined;

  const total = records.reduce(
    (sum, record) => sum + estimateTokens(JSON.stringify(record.message)),
    0,
  );
  if (total <= options.toTokens) return undefined;

  // Every index a window could legally open on. The first is skipped: cutting
  // there would fold nothing.
  const starts = records
    .map((record, index) => (record.message.role === 'user' ? index : -1))
    .filter((index) => index > 0);
  if (starts.length === 0) return undefined;

  // Walk back from the end so `keepTurns` counts turns, not messages, then take
  // the *latest* boundary that still leaves the kept turns intact.
  const boundary = starts.at(-options.keepTurns);
  if (boundary === undefined) return undefined;

  // Fold as much as the target allows, but never past the boundary: the recent
  // turns are kept whatever the budget says.
  let end = boundary;
  let kept = total;
  for (const start of starts) {
    if (start > boundary) break;
    const folded = records
      .slice(0, start)
      .reduce(
        (sum, record) => sum + estimateTokens(JSON.stringify(record.message)),
        0,
      );
    end = start;
    kept = total - folded;
    if (kept <= options.toTokens) break;
  }

  const messages = records.slice(0, end).map((record) => record.message);
  if (messages.length === 0) return undefined;

  // The seq of the last folded message: the marker is exclusive, so the window
  // that remains starts at the `user` message this cut sits in front of.
  const cut = records[end - 1]?.seq;
  return cut === undefined ? undefined : { cut, messages };
}

/**
 * The span as one plain-text transcript for the summariser.
 *
 * Tool results are capped hard. They reach history at up to 8 000 characters
 * each, so an uncapped transcript of a large span would be a request the size of
 * the window it is trying to shrink — on the model chosen for being cheap.
 */
export function transcript(messages: readonly ChatMessage[]): string {
  return messages
    .map((message) => {
      const text = textOf(message);
      const body =
        message.role === 'tool'
          ? truncateHeadTail(text, MAX_TOOL_CHARS).text
          : text;
      return body.trim() === '' ? '' : `${message.role}: ${body}`;
    })
    .filter((line) => line !== '')
    .join('\n\n');
}

/**
 * Replaces every dated section with one.
 *
 * The preamble is not passed in and cannot be reached, which is the point: this
 * is the only operation that rewrites, and the prose above the first heading has
 * to survive it byte for byte. The caller supplies the preamble back to
 * `renderMemoryFile` unchanged.
 *
 * Dated with the *newest* section's date rather than today's, because the merged
 * content is what those sessions learned and stamping it with the day someone
 * happened to run the command would misdate all of it.
 */
export function compactSections(
  sections: readonly MemorySection[],
  summary: string,
  fallbackDate: string,
): readonly MemorySection[] {
  const merged = summary.trim();
  if (merged === '') return sections;
  return [{ date: sections.at(-1)?.date ?? fallbackDate, body: merged }];
}
