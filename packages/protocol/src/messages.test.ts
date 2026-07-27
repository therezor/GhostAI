import { describe, expect, it } from 'vitest';

import { ChatMessageSchema, StoredMessageSchema, UsageSchema } from './messages.js';

describe('ChatMessageSchema', () => {
  it('parses a system message', () => {
    expect(ChatMessageSchema.parse({ role: 'system', content: 'be brief' })).toMatchObject({
      role: 'system',
    });
  });

  it('parses a user message with mixed content parts', () => {
    const parsed = ChatMessageSchema.parse({
      role: 'user',
      content: [
        { type: 'text', text: 'what is this?' },
        { type: 'image', mimeType: 'image/png', url: '/api/files/signed?x=1' },
      ],
    });
    expect(parsed.role).toBe('user');
    if (parsed.role !== 'user') throw new Error('unreachable');
    expect(parsed.content).toHaveLength(2);
  });

  it('rejects an unknown content part type', () => {
    expect(
      ChatMessageSchema.safeParse({ role: 'user', content: [{ type: 'audio', data: 'x' }] })
        .success,
    ).toBe(false);
  });

  it('defaults an assistant message to no tool calls', () => {
    const parsed = ChatMessageSchema.parse({ role: 'assistant', content: [] });
    expect(parsed).toMatchObject({ toolCalls: [] });
  });

  it('keeps tool-call arguments as a verbatim string', () => {
    // Models emit malformed JSON often enough that parsing must happen in the
    // tool registry, where a failure becomes a retryable tool error rather than
    // an exception in the transport layer.
    const parsed = ChatMessageSchema.parse({
      role: 'assistant',
      content: [],
      toolCalls: [{ id: 'c1', name: 'exec', argumentsJson: '{"argv":["ls",' }],
    });
    expect(parsed.role).toBe('assistant');
    if (parsed.role !== 'assistant') throw new Error('unreachable');
    expect(parsed.toolCalls[0]?.argumentsJson).toBe('{"argv":["ls",');
  });

  it('requires a tool message to name the call it answers', () => {
    // The pairing key `findLegalStart` walks: a tool result with no originating
    // call is a provider 400.
    expect(
      ChatMessageSchema.safeParse({ role: 'tool', name: 'read_file', content: 'x' }).success,
    ).toBe(false);
    expect(
      ChatMessageSchema.safeParse({
        role: 'tool',
        toolCallId: '',
        name: 'read_file',
        content: 'x',
      }).success,
    ).toBe(false);
  });

  it('treats a failed tool result as a legal history entry', () => {
    const parsed = ChatMessageSchema.parse({
      role: 'tool',
      toolCallId: 'c1',
      name: 'exec',
      content: 'ENOENT',
      isError: true,
    });
    expect(parsed).toMatchObject({ isError: true, truncated: false });
  });

  it('rejects an unknown role', () => {
    expect(ChatMessageSchema.safeParse({ role: 'developer', content: 'x' }).success).toBe(false);
  });

  it('rejects a role mismatch in the payload', () => {
    expect(ChatMessageSchema.safeParse({ role: 'user', content: 'a plain string' }).success).toBe(
      false,
    );
    expect(ChatMessageSchema.safeParse({ role: 'system', content: [] }).success).toBe(false);
  });
});

describe('StoredMessageSchema', () => {
  it('wraps a message with its storage identity', () => {
    const parsed = StoredMessageSchema.parse({
      id: 'm1',
      sessionKey: 'web:abc',
      createdAtMs: 1_700_000_000_000,
      turnId: 't1',
      message: { role: 'system', content: 'x' },
    });
    expect(parsed.message.role).toBe('system');
    expect(parsed.turnId).toBe('t1');
  });

  it('allows a message with no turn, for seeded system prompts', () => {
    const parsed = StoredMessageSchema.parse({
      id: 'm1',
      sessionKey: 's',
      createdAtMs: 0,
      message: { role: 'system', content: 'x' },
    });
    expect(parsed).not.toHaveProperty('turnId');
  });

  it('rejects a negative timestamp', () => {
    expect(
      StoredMessageSchema.safeParse({
        id: 'm1',
        sessionKey: 's',
        createdAtMs: -1,
        message: { role: 'system', content: 'x' },
      }).success,
    ).toBe(false);
  });
});

describe('UsageSchema', () => {
  it('defaults every counter to zero', () => {
    expect(UsageSchema.parse({})).toMatchObject({
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    });
  });

  it('omits cache and reasoning counters when the provider does not report them', () => {
    const parsed = UsageSchema.parse({});
    expect(parsed).not.toHaveProperty('cachedTokens');
    expect(parsed).not.toHaveProperty('reasoningTokens');
  });

  it('rejects negative counts', () => {
    expect(UsageSchema.safeParse({ promptTokens: -5 }).success).toBe(false);
  });
});
