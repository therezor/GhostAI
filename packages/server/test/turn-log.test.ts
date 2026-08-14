import { describe, expect, it } from 'vitest';

import type { SequencedServerMessage } from '#src/replay.js';
import { TurnLog } from '#src/turn-log.js';

const TURN = 'turn-1';
const SESSION = 'web:1';
const BIG = 1024 * 1024;

function start(seq: number, turnId = TURN): SequencedServerMessage {
  return {
    type: 'turn.start',
    seq,
    sessionKey: SESSION,
    turnId,
    agentId: 'default',
    model: 'test-model',
    provider: 'test',
  };
}

function end(seq: number, turnId = TURN): SequencedServerMessage {
  return {
    type: 'turn.end',
    seq,
    turnId,
    stopReason: 'complete',
    iterations: 1,
  };
}

function delta(
  seq: number,
  text: string,
  turnId = TURN,
): SequencedServerMessage {
  return { type: 'assistant.delta', seq, turnId, text };
}

function reasoning(seq: number, text: string): SequencedServerMessage {
  return { type: 'reasoning.delta', seq, turnId: TURN, text };
}

function result(seq: number, content: string): SequencedServerMessage {
  return {
    type: 'tool.result',
    seq,
    turnId: TURN,
    callId: 'call-1',
    ok: true,
    content,
    truncated: false,
    durationMs: 4,
  };
}

function nested(
  seq: number,
  text: string,
  callId = 'call-1',
  parentSessionKey = SESSION,
): SequencedServerMessage {
  return {
    type: 'subagent.event',
    seq,
    turnId: TURN,
    parentSessionKey,
    parentCallId: callId,
    agentId: 'researcher',
    label: 'Researcher',
    sessionKey: 'subagent:1',
    depth: 1,
    event: { type: 'assistant.delta', turnId: 'child-turn', text },
  };
}

function texts(log: TurnLog): string[] {
  return log.frames().map((frame) => {
    if (frame.type === 'assistant.delta' || frame.type === 'reasoning.delta') {
      return frame.text;
    }
    if (frame.type === 'subagent.event') {
      return 'text' in frame.event ? frame.event.text : frame.event.type;
    }
    return frame.type;
  });
}

describe('TurnLog', () => {
  it('holds nothing until a turn starts', () => {
    const log = new TurnLog(BIG);
    log.push(delta(1, 'orphan'));

    expect(log.openTurnId).toBeUndefined();
    expect(log.complete).toBe(false);
    expect(log.size).toBe(0);
  });

  it('holds the open turn from its start, and forgets it at its end', () => {
    const log = new TurnLog(BIG);
    log.push(start(1));
    log.push(delta(2, 'hello'));

    expect(log.openTurnId).toBe(TURN);
    expect(log.complete).toBe(true);
    expect(texts(log)).toEqual(['turn.start', 'hello']);

    log.push(end(3));
    expect(log.openTurnId).toBeUndefined();
    expect(log.complete).toBe(false);
    expect(log.size).toBe(0);
  });

  it('starts over on the next turn rather than accumulating', () => {
    const log = new TurnLog(BIG);
    log.push(start(1));
    log.push(delta(2, 'first'));
    log.push(end(3));
    log.push(start(4, 'turn-2'));
    log.push(delta(5, 'second', 'turn-2'));

    expect(log.openTurnId).toBe('turn-2');
    expect(texts(log)).toEqual(['turn.start', 'second']);
  });

  it('ignores frames belonging to another turn', () => {
    const log = new TurnLog(BIG);
    log.push(start(1));
    log.push(delta(2, 'mine'));
    log.push(delta(3, 'someone else’s', 'turn-2'));

    expect(texts(log)).toEqual(['turn.start', 'mine']);
  });

  it("keeps a turn open when another turn's end arrives", () => {
    const log = new TurnLog(BIG);
    log.push(start(1));
    log.push(delta(2, 'mine'));
    log.push(end(3, 'turn-2'));

    expect(log.openTurnId).toBe(TURN);
    expect(texts(log)).toEqual(['turn.start', 'mine']);
  });

  it('keeps the session-scoped frames out, so a replay raises no second toast', () => {
    const log = new TurnLog(BIG);
    log.push(start(1));
    log.push({
      type: 'session.status',
      seq: 2,
      sessionKey: SESSION,
      busy: true,
      queueDepth: 0,
      workspaceId: 'default',
      turnId: TURN,
    });
    log.push({
      type: 'context.usage',
      seq: 3,
      sessionKey: SESSION,
      estimatedTokens: 10,
      contextWindowTokens: 100,
      breakdown: {},
    });
    log.push({
      type: 'notification',
      seq: 4,
      id: 'n1',
      title: 'done',
      body: '',
      level: 'info',
      createdAtMs: 0,
    });

    expect(texts(log)).toEqual(['turn.start']);
  });

  it('merges a run of deltas into one entry carrying the later seq', () => {
    const log = new TurnLog(BIG);
    log.push(start(1));
    log.push(delta(2, 'one '));
    log.push(delta(3, 'two '));
    log.push(delta(4, 'three'));

    expect(texts(log)).toEqual(['turn.start', 'one two three']);
    // The later seq, so a client's cursor is not left behind what it rendered.
    expect(log.frames().at(-1)?.seq).toBe(4);
  });

  it('does not merge across a change of kind', () => {
    const log = new TurnLog(BIG);
    log.push(start(1));
    log.push(delta(2, 'answer'));
    log.push(reasoning(3, 'thinking'));
    log.push(delta(4, 'more'));

    expect(texts(log)).toEqual(['turn.start', 'answer', 'thinking', 'more']);
  });

  it('does not merge a turn’s own text into its subagent’s', () => {
    const log = new TurnLog(BIG);
    log.push(start(1));
    log.push(delta(2, 'parent '));
    log.push(nested(3, 'child '));
    log.push(nested(4, 'more'));
    log.push(delta(5, 'again'));

    expect(texts(log)).toEqual([
      'turn.start',
      'parent ',
      'child more',
      'again',
    ]);
  });

  it('keeps two delegations apart, even when they share a call id', () => {
    const log = new TurnLog(BIG);
    log.push(start(1));
    log.push(nested(2, 'first ', 'call-1', SESSION));
    log.push(nested(3, 'second', 'call-1', 'subagent:1'));

    expect(texts(log)).toEqual(['turn.start', 'first ', 'second']);
  });

  it('drops everything and says so once past its budget', () => {
    const log = new TurnLog(256);
    log.push(start(1));
    log.push(delta(2, 'a'));
    expect(log.complete).toBe(true);

    log.push(result(3, 'x'.repeat(512)));

    expect(log.complete).toBe(false);
    expect(log.size).toBe(0);
    expect(log.retainedBytes).toBe(0);
    // Still knows which turn is running — it just cannot describe it.
    expect(log.openTurnId).toBe(TURN);

    // And it stays dropped for the rest of the turn.
    log.push(delta(4, 'b'));
    expect(log.size).toBe(0);

    log.push(end(5));
    log.push(start(6, 'turn-2'));
    expect(log.complete).toBe(true);
  });

  it('retains nothing at all when the budget is zero', () => {
    const log = new TurnLog(0);
    log.push(start(1));
    log.push(delta(2, 'hello'));

    expect(log.openTurnId).toBe(TURN);
    expect(log.complete).toBe(false);
    expect(log.size).toBe(0);
  });

  it('clamps a negative budget rather than retaining forever', () => {
    const log = new TurnLog(-8);
    log.push(start(1));
    log.push(delta(2, 'hello'));

    expect(log.complete).toBe(false);
    expect(log.size).toBe(0);
  });

  it('charges a merged delta for its text, not for a new entry', () => {
    const log = new TurnLog(BIG);
    log.push(start(1));
    log.push(delta(2, 'abcd'));
    const afterFirst = log.retainedBytes;
    log.push(delta(3, 'efgh'));

    expect(log.retainedBytes - afterFirst).toBe(4);
  });

  it('forgets the open turn when the conversation moves under it', () => {
    const log = new TurnLog(BIG);
    log.push(start(1));
    log.push(delta(2, 'hello'));
    log.clear();

    expect(log.openTurnId).toBeUndefined();
    expect(log.complete).toBe(false);
    expect(log.frames()).toEqual([]);
  });
});
