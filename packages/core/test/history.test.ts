import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { ChatMessage } from '@ghostwire/protocol';

import {
  DEFAULT_MAX_TOOL_RESULT_CHARS,
  findLegalEnd,
  findLegalStart,
  hasOrphanedToolResult,
  hasUnansweredToolCall,
  historyForLLM,
  truncateHeadTail,
} from '#src/history.js';
import {
  assistantMessage,
  systemMessage,
  toolMessage,
  userMessage,
} from '#src/messages.js';

const call = (
  id: string,
): { id: string; name: string; argumentsJson: string } => ({
  id,
  name: 'read_file',
  argumentsJson: '{}',
});

const assistantCalling = (...ids: string[]): ChatMessage =>
  assistantMessage('', { toolCalls: ids.map(call) });

describe('findLegalStart', () => {
  it('accepts an empty history', () => {
    expect(findLegalStart([])).toBe(0);
  });

  it('accepts a history with no tool traffic', () => {
    expect(findLegalStart([userMessage('hi'), assistantMessage('hello')])).toBe(
      0,
    );
  });

  it('accepts a well-paired exchange', () => {
    const messages = [
      userMessage('read it'),
      assistantCalling('a'),
      toolMessage('a', 'read_file', 'contents'),
      assistantMessage('done'),
    ];
    expect(findLegalStart(messages)).toBe(0);
  });

  it('cuts past a leading orphan', () => {
    // The window opened mid-turn: the assistant that declared `a` fell off.
    const messages = [
      toolMessage('a', 'read_file', 'contents'),
      assistantMessage('done'),
    ];
    expect(findLegalStart(messages)).toBe(1);
  });

  it('keeps a later well-paired exchange after cutting an orphan', () => {
    const messages = [
      toolMessage('a', 'read_file', 'x'),
      assistantCalling('b'),
      toolMessage('b', 'read_file', 'y'),
    ];
    expect(findLegalStart(messages)).toBe(1);
  });

  it('pairs each of several parallel tool calls', () => {
    const messages = [
      assistantCalling('a', 'b', 'c'),
      toolMessage('a', 'read_file', 'x'),
      toolMessage('b', 'read_file', 'y'),
      toolMessage('c', 'read_file', 'z'),
    ];
    expect(findLegalStart(messages)).toBe(0);
  });

  it('discards everything when the only orphan is last', () => {
    const messages = [
      assistantCalling('a'),
      toolMessage('a', 't', 'x'),
      toolMessage('b', 't', 'y'),
    ];
    expect(findLegalStart(messages)).toBe(messages.length);
  });

  it('re-orphans a result whose declaring assistant is cut away', () => {
    // `a` is declared before the cut at index 2, so it cannot count as
    // declared afterwards — this is what clearing the set protects against.
    const messages = [
      assistantCalling('a'),
      toolMessage('b', 't', 'orphan'),
      toolMessage('a', 't', 'now also orphaned'),
    ];
    expect(findLegalStart(messages)).toBe(3);
  });

  it('requires the assistant to come first, not merely to exist', () => {
    const messages = [toolMessage('a', 't', 'x'), assistantCalling('a')];
    expect(findLegalStart(messages)).toBe(1);
  });
});

describe('hasOrphanedToolResult', () => {
  it('is false for a paired exchange', () => {
    expect(
      hasOrphanedToolResult([
        assistantCalling('a'),
        toolMessage('a', 't', 'x'),
      ]),
    ).toBe(false);
  });

  it('is true for a leading tool result', () => {
    expect(hasOrphanedToolResult([toolMessage('a', 't', 'x')])).toBe(true);
  });
});

describe('findLegalStart properties', () => {
  const idArb = fc.constantFrom('a', 'b', 'c', 'd');

  const messageArb: fc.Arbitrary<ChatMessage> = fc.oneof(
    fc.constant(userMessage('hi')),
    fc.constant(assistantMessage('plain answer')),
    fc.constant(systemMessage('you are a ghost')),
    fc
      .uniqueArray(idArb, { minLength: 1, maxLength: 3 })
      .map((ids) => assistantCalling(...ids)),
    idArb.map((id) => toolMessage(id, 'read_file', 'result')),
  );

  const historyArb = fc.array(messageArb, { maxLength: 24 });

  it('never leaves an orphaned tool result behind', () => {
    fc.assert(
      fc.property(historyArb, (messages) => {
        const aligned = messages.slice(findLegalStart(messages));
        expect(hasOrphanedToolResult(aligned)).toBe(false);
      }),
    );
  });

  it('returns an index within the array', () => {
    fc.assert(
      fc.property(historyArb, (messages) => {
        const start = findLegalStart(messages);
        expect(start).toBeGreaterThanOrEqual(0);
        expect(start).toBeLessThanOrEqual(messages.length);
      }),
    );
  });

  it('is a no-op on histories that were already legal', () => {
    fc.assert(
      fc.property(historyArb, (messages) => {
        fc.pre(!hasOrphanedToolResult(messages));
        expect(findLegalStart(messages)).toBe(0);
      }),
    );
  });

  it('is idempotent — realigning an aligned window changes nothing', () => {
    fc.assert(
      fc.property(historyArb, (messages) => {
        const aligned = messages.slice(findLegalStart(messages));
        expect(findLegalStart(aligned)).toBe(0);
      }),
    );
  });

  it('produces a legal window through the full historyForLLM pipeline', () => {
    fc.assert(
      fc.property(
        historyArb,
        fc.integer({ min: 0, max: 24 }),
        (messages, maxMessages) => {
          expect(
            hasOrphanedToolResult(historyForLLM(messages, { maxMessages })),
          ).toBe(false);
        },
      ),
    );
  });
});

describe('findLegalEnd', () => {
  it('accepts an empty history', () => {
    expect(findLegalEnd([])).toBe(0);
  });

  it('accepts a history with no tool traffic', () => {
    expect(findLegalEnd([userMessage('hi'), assistantMessage('hello')])).toBe(
      2,
    );
  });

  it('accepts a well-paired exchange', () => {
    const messages = [
      userMessage('read it'),
      assistantCalling('a'),
      toolMessage('a', 'read_file', 'contents'),
      assistantMessage('done'),
    ];
    expect(findLegalEnd(messages)).toBe(4);
  });

  it('cuts before an assistant whose calls were never answered', () => {
    // The shape a naive truncation leaves behind: the `tool` rows that answered
    // `a` were deleted, and the assistant declaring it is now the last message.
    const messages = [userMessage('read it'), assistantCalling('a')];
    expect(findLegalEnd(messages)).toBe(1);
  });

  it('cuts before the assistant when only some of its calls were answered', () => {
    const messages = [
      assistantCalling('a', 'b'),
      toolMessage('a', 'read_file', 'contents'),
    ];
    expect(findLegalEnd(messages)).toBe(0);
  });

  it('keeps an earlier well-paired exchange when cutting a later one', () => {
    const messages = [
      userMessage('first'),
      assistantCalling('a'),
      toolMessage('a', 'read_file', 'x'),
      userMessage('second'),
      assistantCalling('b'),
    ];
    expect(findLegalEnd(messages)).toBe(4);
  });

  it('discards answers that sit past the cut', () => {
    // `b` is answered, but only after the unanswered `a` — so the answer is
    // dropped along with the cut and cannot rescue the assistant declaring it.
    const messages = [
      assistantCalling('a'),
      assistantCalling('b'),
      toolMessage('b', 'read_file', 'y'),
    ];
    expect(findLegalEnd(messages)).toBe(0);
  });

  it('pairs each of several parallel tool calls', () => {
    const messages = [
      assistantCalling('a', 'b', 'c'),
      toolMessage('a', 'read_file', 'x'),
      toolMessage('b', 'read_file', 'y'),
      toolMessage('c', 'read_file', 'z'),
    ];
    expect(findLegalEnd(messages)).toBe(4);
  });
});

describe('hasUnansweredToolCall', () => {
  it('is false for an empty history', () => {
    expect(hasUnansweredToolCall([])).toBe(false);
  });

  it('is false for a well-paired exchange', () => {
    expect(
      hasUnansweredToolCall([
        assistantCalling('a'),
        toolMessage('a', 'read_file', 'x'),
      ]),
    ).toBe(false);
  });

  it('is true when an answer never arrives', () => {
    expect(hasUnansweredToolCall([assistantCalling('a')])).toBe(true);
  });

  it('is true when the answer precedes the call', () => {
    // Order matters: a `tool` row before its `assistant` answers nothing.
    expect(
      hasUnansweredToolCall([
        toolMessage('a', 'read_file', 'x'),
        assistantCalling('a'),
      ]),
    ).toBe(true);
  });
});

describe('findLegalEnd properties', () => {
  const idArb = fc.constantFrom('a', 'b', 'c', 'd');

  const messageArb: fc.Arbitrary<ChatMessage> = fc.oneof(
    fc.constant(userMessage('hi')),
    fc.constant(assistantMessage('plain answer')),
    fc.constant(systemMessage('you are a ghost')),
    fc
      .uniqueArray(idArb, { minLength: 1, maxLength: 3 })
      .map((ids) => assistantCalling(...ids)),
    idArb.map((id) => toolMessage(id, 'read_file', 'result')),
  );

  const historyArb = fc.array(messageArb, { maxLength: 24 });

  it('never leaves an unanswered tool call behind', () => {
    fc.assert(
      fc.property(historyArb, (messages) => {
        const kept = messages.slice(0, findLegalEnd(messages));
        expect(hasUnansweredToolCall(kept)).toBe(false);
      }),
    );
  });

  it('returns an index within the array', () => {
    fc.assert(
      fc.property(historyArb, (messages) => {
        const end = findLegalEnd(messages);
        expect(end).toBeGreaterThanOrEqual(0);
        expect(end).toBeLessThanOrEqual(messages.length);
      }),
    );
  });

  it('is a no-op on histories that were already complete', () => {
    fc.assert(
      fc.property(historyArb, (messages) => {
        fc.pre(!hasUnansweredToolCall(messages));
        expect(findLegalEnd(messages)).toBe(messages.length);
      }),
    );
  });

  it('is idempotent — re-cutting a cut prefix changes nothing', () => {
    fc.assert(
      fc.property(historyArb, (messages) => {
        const kept = messages.slice(0, findLegalEnd(messages));
        expect(findLegalEnd(kept)).toBe(kept.length);
      }),
    );
  });
});

describe('truncateHeadTail', () => {
  it('leaves short text alone', () => {
    expect(truncateHeadTail('short', 100)).toEqual({
      text: 'short',
      truncated: false,
      omitted: 0,
    });
  });

  it('leaves text of exactly the budget alone', () => {
    expect(truncateHeadTail('abcde', 5).truncated).toBe(false);
  });

  it('treats a non-positive budget as no limit', () => {
    expect(truncateHeadTail('anything at all', 0).truncated).toBe(false);
    expect(truncateHeadTail('anything at all', -5).truncated).toBe(false);
  });

  it('keeps both ends and reports the gap', () => {
    const result = truncateHeadTail('abcdefghij', 4);
    expect(result.truncated).toBe(true);
    expect(result.omitted).toBe(6);
    expect(result.text.startsWith('ab')).toBe(true);
    expect(result.text.endsWith('ij')).toBe(true);
    expect(result.text).toContain('6 characters truncated');
  });

  it('biases the odd character to the head', () => {
    const result = truncateHeadTail('abcdefghij', 5);
    expect(result.text.startsWith('abc')).toBe(true);
    expect(result.text.endsWith('ij')).toBe(true);
  });

  it('handles a budget of one, where there is no tail to keep', () => {
    const result = truncateHeadTail('abcdef', 1);
    expect(result.text.startsWith('a')).toBe(true);
    expect(result.omitted).toBe(5);
  });

  it('always retains exactly the budgeted number of source characters', () => {
    fc.assert(
      fc.property(
        fc.string(),
        fc.integer({ min: 1, max: 64 }),
        (text, maxChars) => {
          const result = truncateHeadTail(text, maxChars);
          if (!result.truncated) return;
          const head = text.slice(0, Math.ceil(maxChars / 2));
          expect(result.text.startsWith(head)).toBe(true);
          expect(result.omitted).toBe(text.length - maxChars);
        },
      ),
    );
  });
});

describe('historyForLLM', () => {
  it('keeps the most recent maxMessages', () => {
    const messages = [userMessage('a'), userMessage('b'), userMessage('c')];
    expect(historyForLLM(messages, { maxMessages: 2 })).toEqual([
      userMessage('b'),
      userMessage('c'),
    ]);
  });

  it('treats maxMessages of zero as unlimited', () => {
    const messages = [userMessage('a'), userMessage('b'), userMessage('c')];
    expect(historyForLLM(messages, { maxMessages: 0 })).toHaveLength(3);
  });

  it('starts at the first user message', () => {
    const messages = [
      systemMessage('stale prompt'),
      assistantMessage('mid-turn'),
      userMessage('go'),
    ];
    expect(historyForLLM(messages)).toEqual([userMessage('go')]);
  });

  it('keeps the window when it contains no user message at all', () => {
    const messages = [assistantCalling('a'), toolMessage('a', 't', 'x')];
    expect(historyForLLM(messages)).toHaveLength(2);
  });

  it('aligns after trimming to the first user message', () => {
    // Trimming to the user message strands the tool result that follows it,
    // so alignment has to run after the trim rather than before.
    const messages = [
      assistantCalling('a'),
      userMessage('interrupting'),
      toolMessage('a', 't', 'stranded'),
      userMessage('next'),
    ];
    const result = historyForLLM(messages);
    expect(hasOrphanedToolResult(result)).toBe(false);
    expect(result).toEqual([userMessage('next')]);
  });

  it('truncates long tool results and flags them', () => {
    const long = 'x'.repeat(DEFAULT_MAX_TOOL_RESULT_CHARS + 100);
    const messages = [
      userMessage('go'),
      assistantCalling('a'),
      toolMessage('a', 't', long),
    ];
    const result = historyForLLM(messages);
    const tool = result[2];

    expect(tool?.role).toBe('tool');
    if (tool?.role !== 'tool') throw new Error('expected a tool message');
    expect(tool.truncated).toBe(true);
    expect(tool.content.length).toBeLessThan(long.length);
  });

  it('leaves tool results within the cap untouched', () => {
    const messages = [
      userMessage('go'),
      assistantCalling('a'),
      toolMessage('a', 't', 'small'),
    ];
    const tool = historyForLLM(messages)[2];
    if (tool?.role !== 'tool') throw new Error('expected a tool message');
    expect(tool.truncated).toBe(false);
  });

  it('disables truncation when the cap is zero', () => {
    const long = 'x'.repeat(20_000);
    const messages = [
      userMessage('go'),
      assistantCalling('a'),
      toolMessage('a', 't', long),
    ];
    const tool = historyForLLM(messages, { maxToolResultChars: 0 })[2];
    if (tool?.role !== 'tool') throw new Error('expected a tool message');
    expect(tool.content).toHaveLength(20_000);
  });

  it('never mutates the caller’s messages', () => {
    const long = 'x'.repeat(200);
    const original = toolMessage('a', 't', long);
    const messages = [userMessage('go'), assistantCalling('a'), original];

    historyForLLM(messages, { maxToolResultChars: 10 });

    expect(original.content).toBe(long);
    expect(original.truncated).toBe(false);
  });
});
