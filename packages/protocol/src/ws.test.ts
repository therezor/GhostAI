import { describe, expect, it } from 'vitest';

import {
  ClientMessageSchema,
  PROTOCOL_VERSION,
  ServerMessageSchema,
  UNSEQUENCED_SERVER_EVENTS,
  isSequencedServerMessage,
} from './ws.js';
import { ChatMessageSchema } from './messages.js';

/** Reads the `type` literal off a discriminated-union variant. */
function variantTypes(union: typeof ClientMessageSchema | typeof ServerMessageSchema): string[] {
  return union.options.map((option) => option.shape.type.value);
}

describe('protocol version', () => {
  it('pins the wire protocol version', () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });
});

describe('ClientMessageSchema', () => {
  it('parses a user message and defaults its attachment list', () => {
    const parsed = ClientMessageSchema.parse({
      type: 'user.message',
      sessionKey: 'web:abc',
      content: 'hello',
    });
    expect(parsed).toMatchObject({ type: 'user.message', attachments: [] });
  });

  it('rejects an unknown message type', () => {
    expect(ClientMessageSchema.safeParse({ type: 'nope' }).success).toBe(false);
  });

  it('rejects a known type with the wrong payload', () => {
    expect(ClientMessageSchema.safeParse({ type: 'turn.stop' }).success).toBe(false);
    expect(ClientMessageSchema.safeParse({ type: 'turn.stop', sessionKey: '' }).success).toBe(
      false,
    );
  });

  it('defaults an approval to the narrowest scope', () => {
    // Anything broader has to be chosen deliberately — a client that omits the
    // field must not silently grant blanket exec approval.
    const parsed = ClientMessageSchema.parse({
      type: 'tool.approve',
      callId: 'c1',
      approved: true,
    });
    expect(parsed).toMatchObject({ scope: 'once' });
  });

  it('requires a cursor on resume so replay has a lower bound', () => {
    expect(ClientMessageSchema.safeParse({ type: 'session.resume', sessionKey: 's' }).success).toBe(
      false,
    );
    expect(
      ClientMessageSchema.safeParse({ type: 'session.resume', sessionKey: 's', lastSeq: 0 })
        .success,
    ).toBe(true);
  });

  it('lets session.new omit a key for the server to generate', () => {
    expect(ClientMessageSchema.safeParse({ type: 'session.new' }).success).toBe(true);
  });

  it('covers every declared client message type exactly once', () => {
    const types = variantTypes(ClientMessageSchema);
    expect(new Set(types).size).toBe(types.length);
    expect(types).toContain('turn.steer');
    expect(types).toContain('audio.transcribe');
  });
});

describe('ServerMessageSchema', () => {
  it('parses a streaming delta', () => {
    const parsed = ServerMessageSchema.parse({
      type: 'assistant.delta',
      seq: 7,
      turnId: 't1',
      text: 'chunk',
    });
    expect(parsed).toMatchObject({ type: 'assistant.delta', seq: 7 });
  });

  it('pins the version literal on the connected event', () => {
    const base = { type: 'connected', sessionKey: 's', serverTimeMs: 0, lastSeq: 0 };
    expect(ServerMessageSchema.safeParse({ ...base, protocolVersion: 1 }).success).toBe(true);
    expect(ServerMessageSchema.safeParse({ ...base, protocolVersion: 2 }).success).toBe(false);
  });

  it('requires seq on every session-scoped event', () => {
    // The reconnect contract: anything a resuming client must be able to replay
    // has to be addressable by a cursor, so a new event without `seq` is a bug
    // that would silently drop from replay.
    const missing = ServerMessageSchema.options
      .filter(
        (option) =>
          !(UNSEQUENCED_SERVER_EVENTS as readonly string[]).includes(option.shape.type.value),
      )
      .filter((option) => !('seq' in option.shape))
      .map((option) => option.shape.type.value);

    expect(missing).toEqual([]);
  });

  it('omits seq on connection-level events', () => {
    const withSeq = ServerMessageSchema.options
      .filter((option) =>
        (UNSEQUENCED_SERVER_EVENTS as readonly string[]).includes(option.shape.type.value),
      )
      .filter((option) => 'seq' in option.shape)
      .map((option) => option.shape.type.value);

    expect(withSeq).toEqual([]);
  });

  it('rejects a negative sequence number', () => {
    expect(
      ServerMessageSchema.safeParse({
        type: 'assistant.delta',
        seq: -1,
        turnId: 't',
        text: '',
      }).success,
    ).toBe(false);
  });

  it('accepts an error event without a turn, for connection-level failures', () => {
    const parsed = ServerMessageSchema.parse({
      type: 'error',
      code: 'unauthorized',
      message: 'no',
    });
    expect(parsed).toMatchObject({ retryable: false });
  });

  it('rejects an untyped error code', () => {
    expect(
      ServerMessageSchema.safeParse({ type: 'error', code: 'kaboom', message: 'x' }).success,
    ).toBe(false);
  });

  it('carries the injection notice without touching the tool result', () => {
    // Detection is non-destructive: the notice is a separate event, so the
    // content the model sees is unchanged.
    const parsed = ServerMessageSchema.parse({
      type: 'notice',
      seq: 3,
      kind: 'prompt_injection',
      message: 'suspicious content in tool output',
      callId: 'c1',
    });
    expect(parsed).toMatchObject({ kind: 'prompt_injection', callId: 'c1' });
  });

  it('covers every declared server message type exactly once', () => {
    const types = variantTypes(ServerMessageSchema);
    expect(new Set(types).size).toBe(types.length);
    expect(types).toContain('tool.approvalRequest');
    expect(types).toContain('session.replay');
  });
});

describe('isSequencedServerMessage', () => {
  it('accepts a sequenced event', () => {
    const message = ServerMessageSchema.parse({
      type: 'assistant.delta',
      seq: 1,
      turnId: 't',
      text: 'x',
    });
    expect(isSequencedServerMessage(message)).toBe(true);
  });

  it.each([...UNSEQUENCED_SERVER_EVENTS])('rejects %s', (type) => {
    const samples: Record<string, unknown> = {
      connected: {
        type: 'connected',
        protocolVersion: PROTOCOL_VERSION,
        sessionKey: 's',
        serverTimeMs: 0,
        lastSeq: 0,
      },
      pong: { type: 'pong', serverTimeMs: 0 },
      error: { type: 'error', code: 'internal', message: 'x' },
    };
    const message = ServerMessageSchema.parse(samples[type]);
    expect(isSequencedServerMessage(message)).toBe(false);
  });
});

describe('session replay', () => {
  it('reports incomplete when history fell out of the ring buffer', () => {
    const parsed = ServerMessageSchema.parse({
      type: 'session.replay',
      seq: 9,
      sessionKey: 's',
      messages: [],
      complete: false,
    });
    expect(parsed).toMatchObject({ complete: false });
  });

  it('defaults to complete', () => {
    const parsed = ServerMessageSchema.parse({
      type: 'session.replay',
      seq: 9,
      sessionKey: 's',
      messages: [],
    });
    expect(parsed).toMatchObject({ complete: true });
  });

  it('carries stored messages with their tool-call pairing intact', () => {
    const assistant = ChatMessageSchema.parse({
      role: 'assistant',
      content: [{ type: 'text', text: 'calling' }],
      toolCalls: [{ id: 'call_1', name: 'read_file', argumentsJson: '{"path":"a.txt"}' }],
    });
    const tool = ChatMessageSchema.parse({
      role: 'tool',
      toolCallId: 'call_1',
      name: 'read_file',
      content: 'contents',
    });

    const parsed = ServerMessageSchema.parse({
      type: 'session.replay',
      seq: 1,
      sessionKey: 's',
      messages: [
        { id: 'm1', sessionKey: 's', createdAtMs: 1, message: assistant },
        { id: 'm2', sessionKey: 's', createdAtMs: 2, message: tool },
      ],
    });

    expect(parsed.type).toBe('session.replay');
    if (parsed.type !== 'session.replay') throw new Error('unreachable');
    const [first, second] = parsed.messages;
    expect(first!.message.role === 'assistant' && first!.message.toolCalls[0]?.id).toBe('call_1');
    expect(second!.message.role === 'tool' && second!.message.toolCallId).toBe('call_1');
  });
});
