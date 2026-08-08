/**
 * What a turn on a session would actually send to the model, without running one.
 *
 * This is the measurement behind the context strip in the web UI and `/context`
 * in the CLI, and it lives here for a reason worth stating: it cannot live in
 * `@ghostbot/core`, which has no access to `estimateTokens` or to the prompt the
 * loop assembles; and it must not live in `@ghostbot/server`, because the CLI
 * drives `AgentLoop` in-process and never speaks HTTP. `@ghostbot/agent` already
 * depends on both halves, so putting it here adds no dependency edge and gives
 * both front ends one implementation instead of two that drift.
 *
 * It returns storage *records* rather than wire types. The REST layer narrows
 * them with `toStoredMessage`; the terminal never needs to.
 */

import {
  historyForLLM,
  type SessionStore,
  type StoredMessageRecord,
} from '@ghostbot/core';
import type { ChatMessage, ToolDefinition } from '@ghostbot/protocol';
import { estimateTokens } from '@ghostbot/providers';

import type { AgentLoop } from './loop.js';

interface ContextBreakdown {
  readonly systemPrompt: number;
  readonly tools: number;
  readonly messages: number;
  /**
   * The trailing turn: live state, the turn's delimiter, a correction.
   *
   * Reported apart from `systemPrompt` because it is the one section billed at
   * full price on every iteration — the three above it are the provider's cached
   * prefix. A single "prompt" figure would average the two together and hide the
   * only number here anyone can act on.
   */
  readonly runtimeBlock: number;
}

export interface ContextReport {
  readonly sessionKey: string;
  /** The cached prefix: the system message, without the per-iteration tail. */
  readonly systemPrompt: string;
  /**
   * The trailing turn, as the loop would send it — before the reminder envelope,
   * which is framing rather than content anyone reading this panel needs.
   *
   * Empty in `raw` mode, where the operator's one template is the whole system
   * message and there is no second half to show.
   */
  readonly runtimeBlock: string;
  /**
   * The definitions as the provider would receive them.
   *
   * Returned as well as measured, because the breakdown says `tools: 1,240` and
   * the only follow-up question anyone has is *which* tools. A number with
   * nothing behind it is the part of an inspector that gets asked about.
   */
  readonly tools: readonly ToolDefinition[];
  /** The window as it would be sent, in storage order. */
  readonly messages: readonly StoredMessageRecord[];
  readonly estimatedTokens: number;
  readonly contextWindowTokens: number;
  /**
   * Named sections rather than one number, because the question this exists to
   * answer is *which* block got too big.
   */
  readonly breakdown: ContextBreakdown;
}

interface DescribeContextInput {
  readonly store: SessionStore;
  /** Structural, so a test can supply a prompt without building a whole loop. */
  readonly loop: Pick<AgentLoop, 'previewPrompt'>;
  readonly tools: readonly ToolDefinition[];
  readonly sessionKey: string;
  readonly channel?: string;
  readonly agentId?: string;
  readonly contextWindowTokens: number;
}

/**
 * Measures the next turn's prompt for a session that already exists.
 *
 * Returns `undefined` for a session with no stored row — a conversation that
 * has not started has no context to describe, and inventing an empty one would
 * report a system prompt for a workspace nobody chose.
 */
export async function describeContext(
  input: DescribeContextInput,
): Promise<ContextReport | undefined> {
  const session = input.store.getSession(input.sessionKey);
  if (session === undefined) return undefined;

  // The same window the loop reads: the whole stored conversation, which
  // `historyForLLM` below then bounds exactly as a turn would.
  const records = input.store.messages(input.sessionKey, { afterSeq: 0 });

  // `maxToolResultChars: 0` disables truncation, and that is what makes the
  // returned messages the *same objects* that went in. That identity is how
  // each one is matched back to the stored row carrying its id and seq —
  // without it there would be no way to say which row a window entry came from.
  const byMessage = new Map<ChatMessage, StoredMessageRecord>(
    records.map((record) => [record.message, record]),
  );
  const window = historyForLLM(
    records.map((record) => record.message),
    { maxToolResultChars: 0 },
  );

  const messages: StoredMessageRecord[] = [];
  for (const message of window) {
    const record = byMessage.get(message);
    if (record !== undefined) messages.push(record);
  }

  const { staticPrompt, runtimeBlock } = await input.loop.previewPrompt({
    sessionKey: input.sessionKey,
    ...(input.channel === undefined ? {} : { channel: input.channel }),
    ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
  });

  const promptTokens = estimateTokens(staticPrompt);
  const runtimeTokens = estimateTokens(runtimeBlock);
  const toolTokens = estimateTokens(JSON.stringify(input.tools));
  const messageTokens = window.reduce(
    (total, message) => total + estimateTokens(JSON.stringify(message)),
    0,
  );

  return {
    sessionKey: input.sessionKey,
    systemPrompt: staticPrompt,
    runtimeBlock,
    tools: input.tools,
    messages,
    estimatedTokens: promptTokens + toolTokens + messageTokens + runtimeTokens,
    contextWindowTokens: input.contextWindowTokens,
    // In request order, which is also cached-then-not: the three sections a
    // provider can serve from its prefix cache, then the tail that is re-read
    // at full price on every iteration.
    breakdown: {
      systemPrompt: promptTokens,
      tools: toolTokens,
      messages: messageTokens,
      runtimeBlock: runtimeTokens,
    },
  };
}
