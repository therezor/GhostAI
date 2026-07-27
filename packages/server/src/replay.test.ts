import { describe, expect, it } from 'vitest';

import { ReplayBuffer, type SequencedServerMessage } from './replay.js';

function delta(seq: number, text = 'x'): SequencedServerMessage {
  return { type: 'assistant.delta', seq, turnId: 'turn-1', text };
}

describe('ReplayBuffer', () => {
  it('retains up to its capacity, dropping the oldest', () => {
    const buffer = new ReplayBuffer(3);
    for (let seq = 1; seq <= 5; seq += 1) buffer.push(delta(seq));

    expect(buffer.size).toBe(3);
    expect(buffer.capacity).toBe(3);
    expect(buffer.after(0).messages.map((message) => message.seq)).toEqual([3, 4, 5]);
  });

  it('replays exactly the tail after a mid-stream seq', () => {
    const buffer = new ReplayBuffer(16);
    for (let seq = 1; seq <= 6; seq += 1) buffer.push(delta(seq, `chunk-${String(seq)}`));

    const slice = buffer.after(3);
    expect(slice.complete).toBe(true);
    expect(slice.messages).toEqual([delta(4, 'chunk-4'), delta(5, 'chunk-5'), delta(6, 'chunk-6')]);
  });

  it('reports a gap rather than a tail that starts late', () => {
    const buffer = new ReplayBuffer(2);
    for (let seq = 1; seq <= 5; seq += 1) buffer.push(delta(seq));

    // The client wants everything after 1; the buffer starts at 4.
    const slice = buffer.after(1);
    expect(slice.complete).toBe(false);
    expect(slice.messages.map((message) => message.seq)).toEqual([4, 5]);
  });

  it('treats a client that has seen everything as complete and empty', () => {
    const buffer = new ReplayBuffer(8);
    buffer.push(delta(1));
    buffer.push(delta(2));

    expect(buffer.after(2)).toEqual({ messages: [], complete: true });
  });

  it('treats a client ahead of the buffer as a gap', () => {
    // A restart: the counter began again, and this client's history predates it.
    const buffer = new ReplayBuffer(8);
    buffer.push(delta(1));

    expect(buffer.after(57)).toEqual({ messages: [], complete: false });
  });

  it('keeps counting with a capacity of zero and never claims coverage', () => {
    const buffer = new ReplayBuffer(0);
    buffer.push(delta(1));
    buffer.push(delta(2));

    expect(buffer.size).toBe(0);
    expect(buffer.lastSeq).toBe(2);
    expect(buffer.after(1)).toEqual({ messages: [], complete: false });
    expect(buffer.after(2)).toEqual({ messages: [], complete: true });
  });

  it('clamps a negative capacity rather than growing without bound', () => {
    const buffer = new ReplayBuffer(-4);
    buffer.push(delta(1));

    expect(buffer.capacity).toBe(0);
    expect(buffer.size).toBe(0);
  });

  it('forgets its entries on clear but not where the sequence is', () => {
    const buffer = new ReplayBuffer(4);
    buffer.push(delta(1));
    buffer.push(delta(2));
    buffer.clear();

    expect(buffer.size).toBe(0);
    expect(buffer.lastSeq).toBe(2);
    expect(buffer.after(1).complete).toBe(false);
  });
});
