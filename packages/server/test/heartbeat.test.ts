/**
 * The two decisions, driven from `ChatResult` literals.
 *
 * This is what the module being pure buys: every way a cheap model can answer
 * badly is a value here, not an endpoint that has to be persuaded to misbehave.
 */

import { describe, expect, it } from 'vitest';

import type { ChatMessage } from '@ghostai/protocol';
import type { ChatResult } from '@ghostai/providers';

import {
  HEARTBEAT_RESULT_TOOL,
  HEARTBEAT_TOOL,
  buildDecideMessages,
  buildEvaluateMessages,
  readDecision,
  readEvaluation,
} from '#src/heartbeat.js';

function completion(
  toolCalls: readonly { name: string; argumentsJson: string }[],
  text = '',
): ChatResult {
  return {
    message: {
      role: 'assistant',
      content: text === '' ? [] : [{ type: 'text', text }],
      toolCalls: toolCalls.map((call, index) => ({ id: `c${String(index)}`, ...call })),
    },
    finishReason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    model: 'cheap',
  };
}

/** The prose of one message, whichever shape its role gives `content`. */
function textOf(message: ChatMessage | undefined): string {
  if (message === undefined) return '';
  if (typeof message.content === 'string') return message.content;
  return message.content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('');
}

function decision(argumentsJson: string): ChatResult {
  return completion([{ name: HEARTBEAT_TOOL.name, argumentsJson }]);
}

function evaluation(argumentsJson: string): ChatResult {
  return completion([{ name: HEARTBEAT_RESULT_TOOL.name, argumentsJson }]);
}

describe('buildDecideMessages', () => {
  it('gives the model the time, so a task file can say "tomorrow"', () => {
    const messages = buildDecideMessages({
      file: 'TASK.md',
      contents: 'Ship it tomorrow',
      nowIso: '2026-07-31T09:00:00Z',
    });
    expect(textOf(messages[0])).toContain('2026-07-31T09:00:00Z');
    expect(textOf(messages[1])).toContain('Ship it tomorrow');
  });

  it('names the file, so the fallback instruction can point at it', () => {
    const messages = buildDecideMessages({ file: 'NOTES.md', contents: 'x', nowIso: 'now' });
    expect(textOf(messages[1])).toContain('NOTES.md');
  });
});

describe('readDecision', () => {
  it('reads a clean skip and keeps the model′s reason', () => {
    const result = readDecision(
      decision(JSON.stringify({ action: 'skip', reason: 'Nothing is due until Friday.' })),
      'TASK.md',
    );
    expect(result).toMatchObject({
      action: 'skip',
      reason: 'Nothing is due until Friday.',
      warnings: [],
    });
  });

  it('reads a clean run and carries the instruction through', () => {
    const result = readDecision(
      decision(
        JSON.stringify({
          action: 'run',
          reason: 'The build check is due.',
          instruction: 'Run the build and report.',
        }),
      ),
      'TASK.md',
    );
    expect(result).toMatchObject({
      action: 'run',
      instruction: 'Run the build and report.',
      warnings: [],
    });
  });

  it('skips when the model answered in prose instead of calling the tool', () => {
    // Not defensive programming: `withResilience`'s `drop_tool_choice` rung
    // strips `toolChoice: 'required'` whenever a provider objects to it, so this
    // is a normal outcome of a normal degradation.
    const result = readDecision(completion([], 'I think you should probably run it.'), 'TASK.md');
    expect(result.action).toBe('skip');
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/without calling the decision tool/u);
  });

  it('skips when the arguments are not JSON', () => {
    const result = readDecision(decision('{not json'), 'TASK.md');
    expect(result.action).toBe('skip');
    expect(result.warnings[0]).toMatch(/did not parse/u);
  });

  it('skips when the action is not one of the two', () => {
    const result = readDecision(
      decision(JSON.stringify({ action: 'maybe', reason: 'x' })),
      'TASK.md',
    );
    expect(result.action).toBe('skip');
    expect(result.warnings).toHaveLength(1);
  });

  it('never fails open to run, whatever the model sends', () => {
    // The rule the module exists to hold: an unreliable cheap model must not be
    // able to start an unbounded agent turn by answering badly.
    for (const bad of ['', '{}', 'null', '[]', '{"reason":"go"}', '{"action":null}']) {
      expect(readDecision(decision(bad), 'TASK.md').action).toBe('skip');
    }
  });

  it('still runs when the model chose run but forgot to say what to do', () => {
    // The decision was made; only the phrasing was missing. Refusing here would
    // be a heartbeat that silently never acts.
    const result = readDecision(
      decision(JSON.stringify({ action: 'run', reason: 'Due.' })),
      'TASK.md',
    );
    expect(result.action).toBe('run');
    expect(result.instruction).toBe('Read `TASK.md` and do what it asks.');
    expect(result.warnings[0]).toMatch(/without saying what to do/u);
  });

  it('treats a blank instruction the same as a missing one', () => {
    const result = readDecision(
      decision(JSON.stringify({ action: 'run', reason: 'Due.', instruction: '   ' })),
      'NOTES.md',
    );
    expect(result.instruction).toBe('Read `NOTES.md` and do what it asks.');
  });

  it('fills in a reason when the model left it empty, so the card is not blank', () => {
    expect(
      readDecision(decision(JSON.stringify({ action: 'skip', reason: '' })), 'T.md').reason,
    ).toBe('Nothing due.');
  });

  it('truncates a reason that would not fit the column or the card', () => {
    const result = readDecision(
      decision(JSON.stringify({ action: 'skip', reason: 'x'.repeat(500) })),
      'TASK.md',
    );
    expect(result.reason.length).toBeLessThanOrEqual(256);
    expect(result.reason.endsWith('…')).toBe(true);
  });

  it('ignores a tool call that is not the decision tool', () => {
    const result = readDecision(
      completion([{ name: 'something_else', argumentsJson: '{"action":"run"}' }]),
      'TASK.md',
    );
    expect(result.action).toBe('skip');
  });
});

describe('buildEvaluateMessages', () => {
  it('shows the model what was asked and what came back', () => {
    const messages = buildEvaluateMessages({ instruction: 'Run the build', output: 'It failed' });
    expect(textOf(messages[1])).toContain('Run the build');
    expect(textOf(messages[1])).toContain('It failed');
  });
});

describe('readEvaluation', () => {
  it('reads a clean decision not to notify', () => {
    const result = readEvaluation(
      evaluation(JSON.stringify({ notify: false, title: 'Nothing changed' })),
      'fallback',
    );
    expect(result).toMatchObject({ notify: false, title: 'Nothing changed', warnings: [] });
  });

  it('reads a decision to notify, with its summary', () => {
    const result = readEvaluation(
      evaluation(
        JSON.stringify({ notify: true, title: 'Build broken', summary: 'Two tests fail.' }),
      ),
      'fallback',
    );
    expect(result).toMatchObject({
      notify: true,
      title: 'Build broken',
      summary: 'Two tests fail.',
    });
  });

  it('defaults to notifying when the model answers badly', () => {
    // The opposite default to `readDecision`, and deliberately so: failing open
    // there costs an agent turn, failing open here costs a toast.
    for (const bad of ['{not json', '{}', '{"notify":true}', 'null']) {
      const result = readEvaluation(evaluation(bad), 'The job finished');
      expect(result.notify).toBe(true);
      expect(result.title).toBe('The job finished');
      expect(result.warnings).toHaveLength(1);
    }
  });

  it('defaults to notifying when there is no tool call at all, keeping the prose', () => {
    const result = readEvaluation(completion([], 'It went fine.'), 'The job finished');
    expect(result).toMatchObject({
      notify: true,
      title: 'The job finished',
      summary: 'It went fine.',
    });
  });
});
