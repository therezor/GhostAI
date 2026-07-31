import { describe, expect, it } from 'vitest';

import { ServerMessageSchema } from '@ghostai/protocol';

import type { AgentEvent, AgentEventType } from './events.js';

/**
 * One sample per event type. `Record<AgentEventType, …>` is what makes this
 * exhaustive: an event added to the union without a sample here is a compile
 * error, not a silently untested shape.
 */
const SAMPLES: Record<AgentEventType, AgentEvent> = {
  'turn.start': {
    type: 'turn.start',
    agentId: 'default',
    sessionKey: 'web:1',
    turnId: 'turn-1',
    model: 'qwen3:8b',
    provider: 'ollama',
  },
  'assistant.delta': { type: 'assistant.delta', turnId: 'turn-1', text: 'Hello' },
  'reasoning.delta': { type: 'reasoning.delta', turnId: 'turn-1', text: 'Thinking' },
  'tool.call': {
    type: 'tool.call',
    turnId: 'turn-1',
    callId: 'call-1',
    name: 'read_file',
    args: { path: 'notes.md' },
    risk: 'safe',
  },
  'tool.progress': {
    type: 'tool.progress',
    turnId: 'turn-1',
    callId: 'call-1',
    elapsedMs: 15_000,
    message: 'exec is still running',
  },
  'tool.approvalRequest': {
    type: 'tool.approvalRequest',
    turnId: 'turn-1',
    callId: 'call-1',
    name: 'exec',
    args: { argv: ['git', 'status'] },
    risk: 'exec',
    expiresAtMs: 1_700_000_300_000,
  },
  'tool.result': {
    type: 'tool.result',
    turnId: 'turn-1',
    callId: 'call-1',
    ok: true,
    content: 'file contents',
    truncated: false,
    durationMs: 12,
  },
  notice: {
    type: 'notice',
    kind: 'prompt_injection',
    message: 'Tool output contained an instruction-override phrase.',
    turnId: 'turn-1',
    callId: 'call-1',
  },
  error: {
    type: 'error',
    code: 'provider_error',
    message: 'The provider returned 500.',
    retryable: true,
    turnId: 'turn-1',
  },
  'turn.end': {
    type: 'turn.end',
    turnId: 'turn-1',
    stopReason: 'complete',
    usage: { promptTokens: 10, completionTokens: 4, totalTokens: 14 },
    iterations: 2,
  },
  'subagent.event': {
    type: 'subagent.event',
    // The root turn, deliberately not the subagent's own — which is `turn-2`,
    // on the inner event where it belongs.
    turnId: 'turn-1',
    parentSessionKey: 'web:1',
    parentCallId: 'call-1',
    agentId: 'researcher',
    label: 'Researcher',
    sessionKey: 'sub-9',
    depth: 1,
    event: { type: 'assistant.delta', turnId: 'turn-2', text: 'Found it' },
  },
};

describe('AgentEvent', () => {
  it('is a ServerMessage once the transport adds a seq', () => {
    for (const [type, event] of Object.entries(SAMPLES)) {
      expect(event.type).toBe(type);

      const parsed = ServerMessageSchema.safeParse({ ...event, seq: 7 });
      expect(parsed.success, `${type}: ${JSON.stringify(parsed.error?.issues)}`).toBe(true);

      // `safeParse` strips unknown keys rather than rejecting them, so success
      // alone would not catch a field this package renamed. Every field the
      // event carries has to survive the parse with its value intact.
      expect(parsed.data).toMatchObject(event);
    }
  });
});
