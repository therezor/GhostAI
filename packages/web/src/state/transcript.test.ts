/**
 * The reducer.
 *
 * Everything the chat view is judged on happens here rather than in a
 * component: a delta landing on the right part, a tool result finding its card,
 * a notice attaching to the call it describes, a reload rebuilding a turn that
 * has not finished. Testing it as a pure function over frames is what makes
 * "a mid-stream reload rebuilds the in-flight turn" a three-line assertion
 * instead of a browser.
 */

import { describe, expect, it } from 'vitest';

import type { ServerMessage, StoredMessage } from '@ghostai/protocol';

import {
  appendPendingUserMessage,
  applyServerMessage,
  fromStoredMessages,
  markApprovalAnswered,
  mergeStoredHistory,
  unwrapToolOutput,
  type ToolPart,
  type Transcript,
  type TurnItem,
} from './transcript.js';

/**
 * Distributes over the union, which a bare `Omit` would collapse into one
 * object type carrying only the fields every variant has.
 */
type Unsequenced<T> = T extends unknown ? Omit<T, 'seq'> : never;

/** Frames in order, with the sequence numbers the hub would have stamped. */
function play(...frames: readonly Unsequenced<ServerMessage>[]): Transcript {
  let seq = 0;
  return frames.reduce<Transcript>(
    (items, frame) => applyServerMessage(items, { ...frame, seq: (seq += 1) } as ServerMessage),
    [],
  );
}

const START = {
  type: 'turn.start',
  sessionKey: 'web:1',
  turnId: 't1',
  model: 'm',
  provider: 'p',
} as const;

const turnOf = (items: Transcript): TurnItem => {
  const turn = items.find((item) => item.kind === 'turn');
  if (turn === undefined) throw new Error('no turn in the transcript');
  return turn;
};

const toolsOf = (items: Transcript): readonly ToolPart[] =>
  turnOf(items).parts.filter((part) => part.kind === 'tool');

describe('accumulating a turn', () => {
  it('appends deltas into one text part', () => {
    const items = play(
      START,
      { type: 'assistant.delta', turnId: 't1', text: 'Hello' },
      { type: 'assistant.delta', turnId: 't1', text: ', world' },
    );

    expect(turnOf(items).parts).toEqual([{ kind: 'text', id: 't1#0', text: 'Hello, world' }]);
  });

  it('starts a new text part after a tool call rather than merging across it', () => {
    const items = play(
      START,
      { type: 'assistant.delta', turnId: 't1', text: 'Let me look.' },
      { type: 'tool.call', turnId: 't1', callId: 'c1', name: 'read', args: {}, risk: 'safe' },
      {
        type: 'tool.result',
        turnId: 't1',
        callId: 'c1',
        ok: true,
        content: 'ok',
        truncated: false,
        durationMs: 5,
      },
      { type: 'assistant.delta', turnId: 't1', text: 'Found it.' },
    );

    // Merging the second answer into the first would render the card below
    // text that was written before it.
    expect(turnOf(items).parts.map((part) => part.kind)).toEqual(['text', 'tool', 'text']);
  });

  it('keeps reasoning in its own part', () => {
    const items = play(
      START,
      { type: 'reasoning.delta', turnId: 't1', text: 'thinking' },
      { type: 'assistant.delta', turnId: 't1', text: 'answer' },
    );

    expect(turnOf(items).parts).toEqual([
      { kind: 'reasoning', id: 't1#0', text: 'thinking' },
      { kind: 'text', id: 't1#1', text: 'answer' },
    ]);
  });

  it('ignores an empty delta', () => {
    const items = play(START, { type: 'assistant.delta', turnId: 't1', text: '' });

    expect(turnOf(items).parts).toEqual([]);
  });

  it('does not open a second turn when the ring replays its start', () => {
    const items = play(START, { type: 'assistant.delta', turnId: 't1', text: 'hi' }, START);

    // Every resume re-delivers frames the client may already hold. Appending
    // would leave an empty turn above the real one on each one.
    expect(items.filter((item) => item.kind === 'turn')).toHaveLength(1);
    expect(turnOf(items).parts).toHaveLength(1);
  });

  it('closes the turn with its stop reason and usage', () => {
    const items = play(START, {
      type: 'turn.end',
      turnId: 't1',
      stopReason: 'aborted',
      iterations: 2,
      usage: { promptTokens: 10, completionTokens: 4, totalTokens: 14 },
    });

    expect(turnOf(items)).toMatchObject({ done: true, stopReason: 'aborted', iterations: 2 });
  });

  it('records a turn-scoped error on the turn and leaves a connection error alone', () => {
    const scoped = play(START, {
      type: 'error',
      code: 'provider_error',
      message: 'upstream said no',
      retryable: true,
      turnId: 't1',
    });
    expect(turnOf(scoped)).toMatchObject({
      done: true,
      failure: { code: 'provider_error', retryable: true },
    });

    // A connection-scoped error has no turn to render on; the toast is its home.
    const unscoped = play(START, {
      type: 'error',
      code: 'internal',
      message: 'boom',
      retryable: false,
    });
    expect(unscoped).toHaveLength(1);
  });
});

describe('tool calls', () => {
  const call = {
    type: 'tool.call',
    turnId: 't1',
    callId: 'c1',
    name: 'exec',
    args: { command: 'ls' },
    risk: 'exec',
  } as const;

  it('runs, then reports, and never shows the envelope', () => {
    const items = play(START, call, {
      type: 'tool.result',
      turnId: 't1',
      callId: 'c1',
      ok: true,
      content: 'a\nb',
      truncated: true,
      durationMs: 120,
    });

    expect(toolsOf(items)[0]).toMatchObject({
      name: 'exec',
      risk: 'exec',
      status: 'ok',
      content: 'a\nb',
      truncated: true,
      durationMs: 120,
    });
  });

  it('marks a failure as an error rather than inspecting the output for one', () => {
    const items = play(START, call, {
      type: 'tool.result',
      turnId: 't1',
      callId: 'c1',
      ok: false,
      content: 'no such file',
      truncated: false,
      durationMs: 2,
    });

    expect(toolsOf(items)[0]?.status).toBe('error');
  });

  it('only moves the heartbeat forward', () => {
    const items = play(
      START,
      call,
      { type: 'tool.progress', turnId: 't1', callId: 'c1', elapsedMs: 30_000 },
      { type: 'tool.progress', turnId: 't1', callId: 'c1', elapsedMs: 15_000 },
    );

    expect(toolsOf(items)[0]?.elapsedMs).toBe(30_000);
  });

  it('does not create a second card when the ring replays the call', () => {
    const items = play(START, call, call);

    expect(toolsOf(items)).toHaveLength(1);
  });

  it('opens a card for a result whose call arrived before this client did', () => {
    // The case a resume lands in: connected between the call and the result.
    const items = play(START, {
      type: 'tool.result',
      turnId: 't1',
      callId: 'orphan',
      ok: true,
      content: 'output',
      truncated: false,
      durationMs: 1,
    });

    expect(toolsOf(items)[0]).toMatchObject({ id: 'orphan', name: 'tool', status: 'ok' });
  });

  it('gates on an approval request and clears it when the result lands', () => {
    const gated = play(START, call, {
      type: 'tool.approvalRequest',
      turnId: 't1',
      callId: 'c1',
      name: 'exec',
      args: { command: 'ls' },
      risk: 'exec',
      expiresAtMs: 1_000,
    });

    expect(toolsOf(gated)[0]).toMatchObject({
      status: 'awaiting-approval',
      approval: { expiresAtMs: 1_000, answered: undefined },
    });

    const answered = markApprovalAnswered(gated, 'c1', 'approved');
    expect(toolsOf(answered)[0]?.approval).toEqual({ expiresAtMs: 1_000, answered: 'approved' });

    const resolved = applyServerMessage(answered, {
      type: 'tool.result',
      seq: 9,
      turnId: 't1',
      callId: 'c1',
      ok: true,
      content: '',
      truncated: false,
      durationMs: 3,
    });
    expect(toolsOf(resolved)[0]?.approval).toBeUndefined();
  });

  it('leaves a transcript alone when an answer names a call that is not in it', () => {
    const items = play(START, call);

    expect(markApprovalAnswered(items, 'nope', 'denied')).toEqual(items);
  });
});

describe('notices', () => {
  it('puts a call-scoped notice inside that call, not below the turn', () => {
    const items = play(
      START,
      { type: 'tool.call', turnId: 't1', callId: 'c1', name: 'fetch', args: {}, risk: 'network' },
      {
        type: 'notice',
        kind: 'prompt_injection',
        message: 'instruction_override',
        turnId: 't1',
        callId: 'c1',
      },
    );

    // A warning rendered away from the output it describes is a warning about
    // nothing in particular.
    expect(toolsOf(items)[0]?.notices).toEqual([
      {
        kind: 'notice',
        id: 'notice:3',
        notice: 'prompt_injection',
        message: 'instruction_override',
      },
    ]);
  });

  it('puts a turn-scoped notice in the turn', () => {
    const items = play(START, {
      type: 'notice',
      kind: 'truncated_history',
      message: 'dropped 3 messages',
      turnId: 't1',
    });

    expect(turnOf(items).parts).toEqual([
      { kind: 'notice', id: 't1#0', notice: 'truncated_history', message: 'dropped 3 messages' },
    ]);
  });

  it('puts a notice with no turn at the top level', () => {
    const items = play({ type: 'notice', kind: 'degraded', message: 'dropped images' });

    expect(items).toEqual([
      { kind: 'notice', id: 'notice:1', notice: 'degraded', message: 'dropped images' },
    ]);
  });
});

describe('the user bubble', () => {
  it('appears before the ack and settles on it', () => {
    const pending = appendPendingUserMessage([], { clientMessageId: 'c-1', text: 'hi' });
    expect(pending[0]).toMatchObject({ id: 'c-1', pending: true });

    const acked = applyServerMessage(pending, {
      type: 'message.ack',
      seq: 1,
      sessionKey: 'web:1',
      messageId: 't1',
      clientMessageId: 'c-1',
    });

    // The id does not become the turn id. Every item is a React key, and the
    // turn this message started is about to arrive carrying that exact id — two
    // siblings with one key is a subtree React cannot reconcile, which renders
    // as a message that appears twice.
    expect(acked[0]).toMatchObject({ id: 'c-1', turnId: 't1', pending: false });
  });

  it('never shares an id with the turn it started', () => {
    const acked = applyServerMessage(
      appendPendingUserMessage([], { clientMessageId: 'c-1', text: 'hi' }),
      { type: 'message.ack', seq: 1, sessionKey: 'web:1', messageId: 't1', clientMessageId: 'c-1' },
    );

    const withTurn = applyServerMessage(acked, { ...START, seq: 2 });
    const ids = withTurn.map((item) => item.id);

    expect(new Set(ids).size).toBe(ids.length);
  });

  it('is dropped rather than duplicated when storage already has the message', () => {
    // The order a reload produces: the REST history lands before the ack. Both
    // describe the same sentence, and the turn id is the only key they share.
    const withHistory = fromStoredMessages([
      stored('row-1', 't1', { role: 'user', content: [{ type: 'text', text: 'hi' }] }),
    ]);
    const pending = appendPendingUserMessage(withHistory, {
      clientMessageId: 'c-1',
      text: 'hi',
    });

    const acked = applyServerMessage(pending, {
      type: 'message.ack',
      seq: 1,
      sessionKey: 'web:1',
      messageId: 't1',
      clientMessageId: 'c-1',
    });

    expect(acked).toHaveLength(1);
    expect(acked[0]).toMatchObject({ id: 'row-1', turnId: 't1' });
  });

  it('records the turn id, so a history that lands later recognises it', () => {
    const pending = appendPendingUserMessage([], { clientMessageId: 'c-1', text: 'hi' });

    const acked = applyServerMessage(pending, {
      type: 'message.ack',
      seq: 1,
      sessionKey: 'web:1',
      messageId: 't1',
      clientMessageId: 'c-1',
    });

    expect(acked[0]).toMatchObject({ turnId: 't1' });
  });

  it('ignores an ack for someone else’s message', () => {
    const pending = appendPendingUserMessage([], { clientMessageId: 'c-1', text: 'hi' });

    const other = applyServerMessage(pending, {
      type: 'message.ack',
      seq: 1,
      sessionKey: 'web:1',
      messageId: 't9',
      clientMessageId: 'c-2',
    });

    expect(other[0]).toMatchObject({ id: 'c-1', pending: true });
  });
});

describe('session frames', () => {
  it('empties the transcript on a reset', () => {
    const items = play(START, { type: 'session.reset', sessionKey: 'web:1' });

    expect(items).toEqual([]);
  });

  it('records a steer so every tab sees what was injected', () => {
    const items = play(START, { type: 'steer', sessionKey: 'web:1', content: 'be brief' });

    expect(items.at(-1)).toEqual({ kind: 'steer', id: 'steer:2', text: 'be brief' });
  });

  it('leaves the transcript alone when a replay was covered by the ring', () => {
    const items = play(START, { type: 'assistant.delta', turnId: 't1', text: 'hi' });

    const replayed = applyServerMessage(items, {
      type: 'session.replay',
      seq: 9,
      sessionKey: 'web:1',
      messages: [],
      complete: true,
    });

    // The frames themselves follow; rebuilding here would render them twice.
    expect(replayed).toBe(items);
  });

  it('rebuilds from storage when the resume fell outside the ring', () => {
    const replayed = applyServerMessage([], {
      type: 'session.replay',
      seq: 9,
      sessionKey: 'web:1',
      messages: [stored('m1', 'user', { role: 'user', content: [{ type: 'text', text: 'q' }] })],
      complete: false,
    });

    expect(replayed).toHaveLength(1);
    expect(replayed[0]).toMatchObject({ kind: 'user', text: 'q' });
  });

  it('ignores the frames that are not transcript events', () => {
    const items = play(
      START,
      { type: 'connected', protocolVersion: 1, sessionKey: 'web:1', serverTimeMs: 0, lastSeq: 0 },
      { type: 'pong', serverTimeMs: 0 },
      { type: 'session.status', sessionKey: 'web:1', busy: true, queueDepth: 0 },
      { type: 'message.queued', sessionKey: 'web:1', queueDepth: 1 },
      { type: 'transcribe.result', text: 'x' },
      { type: 'tools.changed', tools: [] },
      {
        type: 'notification',
        id: 'n1',
        title: 't',
        body: 'b',
        level: 'info',
        createdAtMs: 0,
      },
    );

    expect(items).toHaveLength(1);
  });
});

describe('the mid-stream reload', () => {
  it('rebuilds a turn from deltas whose turn.start fell outside the buffer', () => {
    // What a resume actually delivers when the ring has rolled past the start:
    // the deltas, with no `turn.start` in front of them.
    const items = play(
      { type: 'assistant.delta', turnId: 't1', text: 'half an ' },
      { type: 'assistant.delta', turnId: 't1', text: 'answer' },
      { type: 'tool.call', turnId: 't1', callId: 'c1', name: 'read', args: {}, risk: 'safe' },
    );

    expect(turnOf(items)).toMatchObject({ id: 't1', done: false });
    expect(turnOf(items).parts.map((part) => part.kind)).toEqual(['text', 'tool']);
  });
});

describe('the nonce envelope', () => {
  const NONCE = 'a1b2c3d4e5f60718';

  it('is stripped from stored tool output', () => {
    const wrapped = `<tool_output_${NONCE} name="exec">\nthe real output\n</tool_output_${NONCE}>`;

    // The delimiters are a defence aimed at the model. Showing them to a reader
    // would be showing them the machinery instead of the answer.
    expect(unwrapToolOutput(wrapped)).toBe('the real output');
  });

  it('restores a delimiter the wrapper escaped', () => {
    const wrapped = `<tool_output_${NONCE} name="cat">\nsee <\\tool_output_${NONCE}> here\n</tool_output_${NONCE}>`;

    expect(unwrapToolOutput(wrapped)).toBe(`see <tool_output_${NONCE}> here`);
  });

  it('leaves content that is not an envelope untouched', () => {
    expect(unwrapToolOutput('plain output')).toBe('plain output');
    expect(unwrapToolOutput('<tool_output_short name="x">\na\n</tool_output_short>')).toBe(
      '<tool_output_short name="x">\na\n</tool_output_short>',
    );
  });
});

describe('a stored history', () => {
  it('groups a turn and pairs its tool results by id', () => {
    const items = fromStoredMessages([
      stored('m1', 't1', { role: 'user', content: [{ type: 'text', text: 'run it' }] }),
      stored('m2', 't1', {
        role: 'assistant',
        content: [{ type: 'text', text: 'running' }],
        reasoning: 'I should run it',
        toolCalls: [{ id: 'c1', name: 'exec', argumentsJson: '{"command":"ls"}' }],
      }),
      stored('m3', 't1', {
        role: 'tool',
        toolCallId: 'c1',
        name: 'exec',
        content: 'a.txt',
        isError: false,
        truncated: false,
      }),
    ]);

    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ kind: 'user', text: 'run it' });

    const turn = turnOf(items);
    expect(turn.done).toBe(true);
    expect(turn.parts.map((part) => part.kind)).toEqual(['reasoning', 'text', 'tool']);
    expect(toolsOf(items)[0]).toMatchObject({
      name: 'exec',
      args: { command: 'ls' },
      status: 'ok',
      content: 'a.txt',
    });
  });

  it('keeps malformed tool arguments as the string the model emitted', () => {
    const items = fromStoredMessages([
      stored('m1', 't1', {
        role: 'assistant',
        content: [],
        toolCalls: [{ id: 'c1', name: 'exec', argumentsJson: '{"command": ' }],
      }),
    ]);

    // Models emit invalid JSON often enough that a parse failure cannot be an
    // exception here — the card renders whichever it turned out to be.
    expect(toolsOf(items)[0]?.args).toBe('{"command": ');
  });

  it('never renders a system message', () => {
    const items = fromStoredMessages([
      stored('m0', undefined, { role: 'system', content: 'you are an agent' }),
      stored('m1', undefined, { role: 'user', content: [{ type: 'text', text: 'hi' }] }),
    ]);

    expect(items).toHaveLength(1);
  });

  it('carries image attachments through as chips', () => {
    const items = fromStoredMessages([
      stored('m1', undefined, {
        role: 'user',
        content: [
          { type: 'text', text: 'look' },
          { type: 'image', mimeType: 'image/png', url: '/api/media/abc' },
          // Inline bytes are the same image; re-embedding a megabyte of them
          // to draw a chip is a trade nobody wants.
          { type: 'image', mimeType: 'image/png', data: 'AAAA' },
        ],
      }),
    ]);

    expect(items[0]).toMatchObject({
      text: 'look',
      attachments: [{ type: 'image/png', url: '/api/media/abc' }],
    });
  });

  it('renders a message with no turnId as a turn of one', () => {
    const items = fromStoredMessages([
      stored('m1', undefined, {
        role: 'assistant',
        content: [{ type: 'text', text: 'a' }],
        toolCalls: [],
      }),
      stored('m2', undefined, {
        role: 'assistant',
        content: [{ type: 'text', text: 'b' }],
        toolCalls: [],
      }),
    ]);

    expect(items).toHaveLength(2);
  });

  it('ignores a tool result whose call is in no turn', () => {
    const items = fromStoredMessages([
      stored('m1', 't1', {
        role: 'tool',
        toolCallId: 'missing',
        name: 'exec',
        content: 'output',
        isError: false,
        truncated: false,
      }),
    ]);

    expect(items).toEqual([]);
  });

  it('marks a failed stored tool call as an error', () => {
    const items = fromStoredMessages([
      stored('m1', 't1', {
        role: 'assistant',
        content: [],
        toolCalls: [{ id: 'c1', name: 'read', argumentsJson: '{}' }],
      }),
      stored('m2', 't1', {
        role: 'tool',
        toolCallId: 'c1',
        name: 'read',
        content: 'ENOENT',
        isError: true,
        truncated: true,
      }),
    ]);

    expect(toolsOf(items)[0]).toMatchObject({ status: 'error', truncated: true });
  });
});

describe('merging a fetched history', () => {
  const row = stored('row-1', 't1', {
    role: 'user',
    content: [{ type: 'text', text: 'the question' }],
  });

  it('puts storage underneath what the socket has already built', () => {
    const live = play(START, { type: 'assistant.delta', turnId: 't1', text: 'half an answer' });

    const merged = mergeStoredHistory(live, [row]);

    // Replacing would discard the turn the user is watching; appending would
    // render the conversation twice.
    expect(merged.map((item) => item.kind)).toEqual(['user', 'turn']);
    expect(turnOf(merged).parts).toHaveLength(1);
  });

  it('keeps the risk band the socket reported, which storage does not record', () => {
    const live = play(START, {
      type: 'tool.call',
      turnId: 't1',
      callId: 'c1',
      name: 'exec',
      args: { argv: ['node', '--version'] },
      risk: 'exec',
    });

    const merged = mergeStoredHistory(live, [
      row,
      stored('row-2', 't1', {
        role: 'assistant',
        content: [],
        toolCalls: [{ id: 'c1', name: 'exec', argumentsJson: '{"argv":["node","--version"]}' }],
      }),
    ]);

    // The row cannot say what band the call was in — that was the registry's
    // answer at call time — so the stored form fills in `safe`. Letting it win
    // would relabel an `exec` the user was asked to approve as `read`, the
    // moment its turn lands in the database.
    expect(toolsOf(merged)[0]).toMatchObject({ name: 'exec', risk: 'exec' });
  });

  it('recognises an acked bubble as the message storage just returned', () => {
    const acked = applyServerMessage(
      appendPendingUserMessage([], { clientMessageId: 'c-1', text: 'the question' }),
      { type: 'message.ack', seq: 1, sessionKey: 'web:1', messageId: 't1', clientMessageId: 'c-1' },
    );

    const merged = mergeStoredHistory(acked, [row]);

    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ id: 'row-1' });
  });

  it('keeps a bubble that has not been acked yet', () => {
    const pending = appendPendingUserMessage([], { clientMessageId: 'c-2', text: 'a second one' });

    const merged = mergeStoredHistory(pending, [row]);

    // No turn id yet, so nothing says it is the same message — and it is not.
    expect(merged).toHaveLength(2);
  });

  it('is idempotent, because the history query can resolve more than once', () => {
    const live = play(START, { type: 'assistant.delta', turnId: 't1', text: 'answer' });

    const once = mergeStoredHistory(live, [row]);
    const twice = mergeStoredHistory(once, [row]);

    expect(twice).toEqual(once);
  });
});

function stored(
  id: string,
  turnId: string | undefined,
  message: StoredMessage['message'],
): StoredMessage {
  return {
    id,
    sessionKey: 'web:1',
    createdAtMs: 0,
    ...(turnId === undefined ? {} : { turnId }),
    message,
  };
}
