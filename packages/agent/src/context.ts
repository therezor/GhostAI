/**
 * What a turn on a session would actually send to the model, without running one.
 *
 * This is the measurement behind the context strip in the web UI and `/context`
 * in the CLI, and it lives here for a reason worth stating: it cannot live in
 * `@ghostai/core`, which has no access to `estimateTokens` or to the prompt the
 * loop assembles; and it must not live in `@ghostai/server`, because the CLI
 * drives `AgentLoop` in-process and never speaks HTTP. `@ghostai/agent` already
 * depends on both halves, so putting it here adds no dependency edge and gives
 * both front ends one implementation instead of two that drift.
 *
 * It returns storage *records* rather than wire types. The REST layer narrows
 * them with `toStoredMessage`; the terminal never needs to.
 */

import { historyForLLM, type SessionStore, type StoredMessageRecord } from '@ghostai/core';
import type { ChatMessage, ToolDefinition } from '@ghostai/protocol';
import { estimateTokens } from '@ghostai/providers';

import type { AgentLoop } from './loop.js';

export interface ContextBreakdown {
  readonly systemPrompt: number;
  readonly tools: number;
  readonly messages: number;
}

export interface ContextReport {
  readonly sessionKey: string;
  readonly systemPrompt: string;
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

export interface DescribeContextInput {
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

  // The same window the loop reads — everything past the consolidation marker,
  // since what precedes it is represented by the memory files.
  const records = input.store.messages(input.sessionKey, {
    afterSeq: session.lastConsolidatedSeq,
  });

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

  const systemPrompt = await input.loop.previewPrompt({
    sessionKey: input.sessionKey,
    ...(input.channel === undefined ? {} : { channel: input.channel }),
    ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
  });

  const promptTokens = estimateTokens(systemPrompt);
  const toolTokens = estimateTokens(JSON.stringify(input.tools));
  const messageTokens = window.reduce(
    (total, message) => total + estimateTokens(JSON.stringify(message)),
    0,
  );

  return {
    sessionKey: input.sessionKey,
    systemPrompt,
    messages,
    estimatedTokens: promptTokens + toolTokens + messageTokens,
    contextWindowTokens: input.contextWindowTokens,
    breakdown: { systemPrompt: promptTokens, tools: toolTokens, messages: messageTokens },
  };
}
