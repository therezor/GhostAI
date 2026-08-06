/**
 * Turning stored history into a legal provider request.
 *
 * Stored history is append-only, and no row is ever rewritten — that is what
 * keeps a provider's prompt cache warm across a turn. (A *suffix* can be
 * dropped, by regenerate and edit; see `SessionStore.truncateAfter` for why
 * that leaves the cache intact.) But the slice of it that goes to
 * the model is a fixed-size window, and a naive window cuts through the middle
 * of a tool exchange: the `assistant` message that declared `tool_calls` falls
 * off the front while the `tool` results that answer it remain. Every major
 * provider rejects that with a 400, and it happens on exactly the long
 * conversations where losing the turn costs the most.
 *
 * `findLegalStart` is the fix, and it is the highest-value pure function in the
 * repository: a handful of lines standing between the agent and a class of
 * failure that is invisible until a session gets long enough.
 */

import type { ChatMessage, ToolMessage } from '@ghostai/protocol';

/**
 * The first index from which every `tool` message has a matching preceding
 * `assistant` message that declared its `toolCallId`.
 *
 * The `declared` set is cleared whenever the cut point moves, which is the
 * subtle part: ids declared *before* the new start are about to be discarded
 * along with the assistant message that declared them, so continuing to treat
 * them as declared would leave a genuine orphan behind the cut. Clearing makes
 * the scan conservative — it can return an index past a repairable boundary,
 * never one before a broken pair.
 *
 * Runs in a single pass, and returns `messages.length` when no legal window
 * exists (an empty history is always legal).
 */
export function findLegalStart(messages: readonly ChatMessage[]): number {
  const declared = new Set<string>();
  let start = 0;

  for (const [index, message] of messages.entries()) {
    if (message.role === 'assistant') {
      for (const call of message.toolCalls) declared.add(call.id);
    } else if (message.role === 'tool' && !declared.has(message.toolCallId)) {
      start = index + 1;
      declared.clear();
    }
  }

  return start;
}

/**
 * Whether any `tool` message lacks a preceding `assistant` that declared it.
 *
 * The invariant `findLegalStart` exists to establish, stated independently so
 * it can be asserted rather than assumed — the property tests check the two
 * against each other, and the agent loop can check a request it assembled by
 * some other path.
 */
export function hasOrphanedToolResult(
  messages: readonly ChatMessage[],
): boolean {
  const declared = new Set<string>();
  for (const message of messages) {
    if (message.role === 'assistant') {
      for (const call of message.toolCalls) declared.add(call.id);
    } else if (message.role === 'tool' && !declared.has(message.toolCallId)) {
      return true;
    }
  }
  return false;
}

/**
 * The number of leading messages that form a tool-complete prefix.
 *
 * The mirror of `findLegalStart`: that one finds where a window may *begin*,
 * this one finds where it may *end*. They exist for opposite defects. A window
 * that opens too early strands a `tool` result whose `assistant` fell off the
 * front; a history truncated at an arbitrary point strands the other half —
 * an `assistant` still declaring `tool_calls` whose answers were just deleted.
 * Providers reject both, and until truncation existed only the first could
 * happen.
 *
 * The `answered` set is cleared whenever the cut point moves, for the same
 * reason `findLegalStart` clears `declared`: the `tool` messages that answered
 * those calls sit *after* the new end and are about to be dropped with it, so
 * continuing to count them as answers would leave a genuine orphan in front of
 * the cut. Clearing makes the scan conservative — it can return an index before
 * a repairable boundary, never one that leaves a call unanswered.
 *
 * Runs in a single backward pass, and returns `messages.length` when the whole
 * list is already complete.
 */
export function findLegalEnd(messages: readonly ChatMessage[]): number {
  const answered = new Set<string>();
  let end = messages.length;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message === undefined) continue;

    if (message.role === 'tool') {
      answered.add(message.toolCallId);
    } else if (
      message.role === 'assistant' &&
      message.toolCalls.some((call) => !answered.has(call.id))
    ) {
      end = index;
      answered.clear();
    }
  }

  return end;
}

/**
 * Whether any `assistant` message declares a `toolCall` that no later `tool`
 * message answers.
 *
 * The invariant `findLegalEnd` exists to establish, stated independently so it
 * can be asserted rather than assumed — the counterpart to
 * `hasOrphanedToolResult`, and checked against `findLegalEnd` by property test.
 */
export function hasUnansweredToolCall(
  messages: readonly ChatMessage[],
): boolean {
  const pending = new Set<string>();
  for (const message of messages) {
    if (message.role === 'assistant') {
      for (const call of message.toolCalls) pending.add(call.id);
    } else if (message.role === 'tool') {
      pending.delete(message.toolCallId);
    }
  }
  return pending.size > 0;
}

export interface TruncationResult {
  readonly text: string;
  readonly truncated: boolean;
  /** Characters dropped from the middle. `0` when nothing was truncated. */
  readonly omitted: number;
}

/**
 * Keeps the head and the tail, drops the middle.
 *
 * Head+tail rather than a plain head because both ends carry signal and the
 * middle rarely does: a directory listing's first entries identify what was
 * listed, its last entries are what the model was probably looking for, and a
 * stack trace's head names the error while its tail names the caller. Cutting
 * only the head loses the error; cutting only the tail loses the answer.
 *
 * `maxChars` budgets the *retained content*. The marker is added on top, so a
 * caller sizing a token budget can treat this as an exact bound on the part
 * that varies, rather than a bound that shrinks by the marker's length.
 */
export function truncateHeadTail(
  text: string,
  maxChars: number,
): TruncationResult {
  if (maxChars <= 0 || text.length <= maxChars) {
    return { text, truncated: false, omitted: 0 };
  }

  const headChars = Math.ceil(maxChars / 2);
  const tailChars = maxChars - headChars;
  const omitted = text.length - maxChars;
  const marker = `\n\n… [${String(omitted)} characters truncated] …\n\n`;
  const tail = tailChars === 0 ? '' : text.slice(-tailChars);

  return {
    text: `${text.slice(0, headChars)}${marker}${tail}`,
    truncated: true,
    omitted,
  };
}

export interface HistoryForLLMOptions {
  /** Most recent messages to keep. `0` or negative means no limit. */
  readonly maxMessages?: number;
  /** Cap on each `tool` result. `0` disables truncation. */
  readonly maxToolResultChars?: number;
}

export const DEFAULT_MAX_HISTORY_MESSAGES = 500;

/**
 * The cap the loop applies to a single tool result before it enters history.
 *
 * 8k characters is roughly 2k tokens — large enough for a substantial file or
 * command output, small enough that three of them in one turn cannot crowd out
 * the conversation in a 64k window.
 */
export const DEFAULT_MAX_TOOL_RESULT_CHARS = 8_000;

/**
 * Builds the message list for a provider request.
 *
 * Order matters and is not interchangeable:
 *
 *  1. Keep the most recent `maxMessages`.
 *  2. Start at the first `user` message, so the window opens on a complete turn
 *     rather than mid-exchange. Skipped entirely when the window contains no
 *     user message, since dropping everything would be worse than starting mid-turn.
 *  3. Align to a legal tool-call boundary — *after* step 2, because step 2 is
 *     itself capable of stranding a `tool` result whose `assistant` it just cut.
 *  4. Truncate tool results.
 *
 * The system prompt is not handled here. The loop owns `messages[0]` and
 * rewrites it each iteration to keep the static half cache-stable, so any
 * `system` message that reached storage is dropped by step 2 rather than
 * competing with it.
 */
export function historyForLLM(
  messages: readonly ChatMessage[],
  options: HistoryForLLMOptions = {},
): ChatMessage[] {
  const {
    maxMessages = DEFAULT_MAX_HISTORY_MESSAGES,
    maxToolResultChars = DEFAULT_MAX_TOOL_RESULT_CHARS,
  } = options;

  let window: readonly ChatMessage[] =
    maxMessages > 0 && messages.length > maxMessages
      ? messages.slice(-maxMessages)
      : messages;

  const firstUser = window.findIndex((message) => message.role === 'user');
  if (firstUser > 0) window = window.slice(firstUser);

  const legalStart = findLegalStart(window);
  if (legalStart > 0) window = window.slice(legalStart);

  if (maxToolResultChars <= 0) return [...window];

  return window.map((message) => {
    if (message.role !== 'tool') return message;
    const result = truncateHeadTail(message.content, maxToolResultChars);
    if (!result.truncated) return message;
    // A new object: stored history is append-only, and the caller's array may
    // be a view onto exactly that.
    const truncatedMessage: ToolMessage = {
      ...message,
      content: result.text,
      truncated: true,
    };
    return truncatedMessage;
  });
}

/**
 * The narrow view of a session store that `sessionHistory` needs.
 *
 * Structural, so `SessionStore` satisfies it without knowing this exists and
 * without this file importing it — `session-store.ts` already imports from
 * here, and an arrow back would be a cycle.
 */
export interface SessionHistorySource {
  messages(
    sessionKey: string,
    options: {
      readonly afterSeq: number;
      readonly limit?: number;
      readonly fromEnd?: boolean;
    },
  ): ReadonlyArray<{ readonly message: ChatMessage }>;
}

/**
 * The message list to send to a provider, read out of a store.
 *
 * Here rather than on `SessionStore` because the decision it encodes is about
 * what a *model* should be sent, not about how rows are read — and that made
 * `history()` the one method on a persistence class that knew a provider
 * existed. The rows come from the store; the window is this file's, beside
 * `historyForLLM` and the boundary rules it applies.
 *
 * A session with no stored row reads as no messages rather than as an error:
 * the SQL below is keyed on the session, so an unknown key selects nothing and
 * the window over nothing is empty.
 */
export function sessionHistory(
  source: SessionHistorySource,
  sessionKey: string,
  options: HistoryForLLMOptions = {},
): ChatMessage[] {
  const { maxMessages, ...rest } = options;
  const records = source.messages(sessionKey, {
    afterSeq: 0,
    ...(maxMessages !== undefined && maxMessages > 0
      ? { limit: maxMessages, fromEnd: true }
      : {}),
  });

  return historyForLLM(
    records.map((record) => record.message),
    {
      ...rest,
      ...(maxMessages === undefined ? {} : { maxMessages }),
    },
  );
}
