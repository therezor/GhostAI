import type { ChatMessage } from '@ghostai/protocol';
import { describe, expect, it } from 'vitest';

import {
  KEEP_RECENT_TURNS,
  compactSections,
  selectSpan,
  transcript,
  type SpanRecord,
} from '#src/consolidation.js';

function user(text: string): ChatMessage {
  return { role: 'user', content: [{ type: 'text', text }] };
}

function assistant(text: string): ChatMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    toolCalls: [],
  };
}

/** A conversation of `turns` user/assistant pairs, each `chars` long. */
function conversation(turns: number, chars = 400): SpanRecord[] {
  const records: SpanRecord[] = [];
  for (let index = 0; index < turns; index += 1) {
    records.push({
      seq: records.length + 1,
      message: user(`q${String(index)} `.padEnd(chars, 'x')),
    });
    records.push({
      seq: records.length + 1,
      message: assistant(`a${String(index)} `.padEnd(chars, 'y')),
    });
  }
  return records;
}

const KEEP = { keepTurns: KEEP_RECENT_TURNS, toTokens: 200 };

describe('selectSpan', () => {
  it('does nothing for an empty history', () => {
    expect(selectSpan([], KEEP)).toBeUndefined();
  });

  it('does nothing when history is already under the target', () => {
    expect(
      selectSpan(conversation(20), { keepTurns: 4, toTokens: 1_000_000 }),
    ).toBeUndefined();
  });

  it('does nothing when there are not enough turns to keep any back', () => {
    // Two turns and a rule that keeps four: everything would be kept, so there
    // is nothing on the other side of the cut to fold.
    expect(selectSpan(conversation(2), KEEP)).toBeUndefined();
  });

  it('cuts immediately before a user message, always', () => {
    // The property that keeps `lastConsolidatedSeq` legal by construction: the
    // window that remains opens on a complete turn, so it can never begin with
    // a `tool` result whose `assistant` was folded away.
    const records = conversation(20);
    const span = selectSpan(records, KEEP);

    expect(span).toBeDefined();
    const next = records.find((record) => record.seq === (span?.cut ?? 0) + 1);
    expect(next?.message.role).toBe('user');
  });

  it('keeps the most recent turns whatever the budget asks for', () => {
    // A target of zero would fold everything if the budget won. It does not:
    // the recent turns are kept and the cut stops in front of them.
    const records = conversation(20);
    const span = selectSpan(records, { keepTurns: 4, toTokens: 0 });

    expect(span).toBeDefined();
    const remaining = records.length - (span?.messages.length ?? 0);
    expect(remaining).toBeGreaterThanOrEqual(KEEP_RECENT_TURNS * 2);
  });

  it('folds enough to get under the target when it can', () => {
    const records = conversation(30);
    const span = selectSpan(records, { keepTurns: 4, toTokens: 2_000 });

    expect(span).toBeDefined();
    expect(span?.messages.length).toBeGreaterThan(0);
  });

  it('reports the seq of the last folded message', () => {
    const records = conversation(20);
    const span = selectSpan(records, KEEP);

    // The marker is exclusive, so it names the last message represented by the
    // summary rather than the first one still replayed.
    expect(span?.cut).toBe(span?.messages.length);
  });
});

describe('transcript', () => {
  it('labels each message with its role', () => {
    expect(transcript([user('hello'), assistant('hi')])).toBe(
      'user: hello\n\nassistant: hi',
    );
  });

  it('caps a tool result rather than sending all of it', () => {
    // Tool results reach history at up to 8 000 characters. Uncapped, folding a
    // large span would be a request the size of the window it is shrinking.
    const huge: ChatMessage = {
      role: 'tool',
      toolCallId: 'call-1',
      name: 'exec',
      content: 'z'.repeat(8_000),
      isError: false,
      truncated: false,
    };

    const text = transcript([huge]);

    expect(text.length).toBeLessThan(1_000);
    expect(text).toContain('characters truncated');
  });

  it('drops a message that carries no text at all', () => {
    const empty: ChatMessage = {
      role: 'assistant',
      content: [],
      toolCalls: [],
    };
    expect(transcript([user('hello'), empty])).toBe('user: hello');
  });
});

describe('compactSections', () => {
  const sections = [
    { date: '2026-08-05', body: '- One.' },
    { date: '2026-08-07', body: '- Two.' },
  ];

  it('merges every section into one', () => {
    expect(compactSections(sections, '- One and two.', '2026-08-09')).toEqual([
      { date: '2026-08-07', body: '- One and two.' },
    ]);
  });

  it('dates the merge by the newest session, not by today', () => {
    // The merged content is what those sessions learned; stamping it with the
    // day someone ran the command would misdate all of it.
    const [merged] = compactSections(sections, '- Merged.', '2026-08-09');
    expect(merged?.date).toBe('2026-08-07');
  });

  it('leaves the sections alone when the summary came back empty', () => {
    // A provider that answered with nothing must not delete the notes.
    expect(compactSections(sections, '   ', '2026-08-09')).toEqual(sections);
  });

  it('falls back to the given date when there is nothing to merge', () => {
    expect(compactSections([], '- A fact.', '2026-08-09')).toEqual([
      { date: '2026-08-09', body: '- A fact.' },
    ]);
  });
});
