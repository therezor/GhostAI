import type { AgentEvent } from '@ghostai/agent';
import { describe, expect, it } from 'vitest';

import {
  TurnRenderer,
  clip,
  formatCount,
  formatDuration,
  summariseArgs,
  type RenderTarget,
} from './render.js';

function buffer(): RenderTarget & { text: string } {
  return {
    text: '',
    write(chunk: string): void {
      this.text += chunk;
    },
  };
}

function render(
  events: readonly AgentEvent[],
  options: { showReasoning?: boolean; showUsage?: boolean; toolResultLines?: number } = {},
): string {
  const out = buffer();
  const renderer = new TurnRenderer({ out, colors: false, ...options });
  for (const event of events) renderer.handle(event);
  renderer.finish();
  return out.text;
}

const START: AgentEvent = {
  type: 'turn.start',
  sessionKey: 'cli:default',
  turnId: 't1',
  model: 'qwen3',
  provider: 'ollama',
};

describe('clip', () => {
  it('leaves a short string alone', () => {
    expect(clip('hello', 10)).toBe('hello');
  });

  it('counts the ellipsis inside the budget', () => {
    expect(clip('abcdefghij', 5)).toBe('abcd…');
    expect(clip('abcdefghij', 5)).toHaveLength(5);
  });

  it('collapses whitespace so a multi-line value stays on one line', () => {
    expect(clip('a\n  b\tc ', 20)).toBe('a b c');
  });
});

describe('summariseArgs', () => {
  it('renders an object as key=value pairs rather than JSON', () => {
    expect(summariseArgs({ path: 'src', recursive: true })).toBe('path="src" recursive=true');
  });

  it('passes a raw string through — that is a model that emitted bad JSON', () => {
    expect(summariseArgs('{"path": ')).toBe('{"path":');
  });

  it('is empty for no arguments at all', () => {
    expect(summariseArgs({})).toBe('');
    expect(summariseArgs(undefined)).toBe('');
  });

  it('renders an array by stringifying it', () => {
    expect(summariseArgs(['git', 'status'])).toBe('["git","status"]');
  });

  it('survives values JSON.stringify does not represent', () => {
    expect(summariseArgs({ a: undefined, b: null })).toBe('a=undefined b=null');
  });

  it('clips a long argument list', () => {
    const summary = summariseArgs({ content: 'x'.repeat(500) }, 40);
    expect(summary).toHaveLength(40);
    expect(summary.endsWith('…')).toBe(true);
  });
});

describe('formatDuration', () => {
  it.each([
    [12, '12ms'],
    [999, '999ms'],
    [1500, '1.5s'],
    [65_000, '1m 05s'],
  ])('formats %ims as %s', (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected);
  });
});

describe('formatCount', () => {
  it('switches to thousands past 999', () => {
    expect(formatCount(999)).toBe('999');
    expect(formatCount(1204)).toBe('1.2k');
  });
});

describe('TurnRenderer', () => {
  it('streams assistant text with nothing added around it', () => {
    const text = render([
      START,
      { type: 'assistant.delta', turnId: 't1', text: 'Hel' },
      { type: 'assistant.delta', turnId: 't1', text: 'lo.' },
      { type: 'turn.end', turnId: 't1', stopReason: 'complete', iterations: 1 },
    ]);
    expect(text).toContain('Hello.');
    // No stop-reason line: a turn that completed normally says so by having
    // produced an answer, and announcing it on every turn is noise.
    expect(text).not.toContain('stopped');
  });

  it('breaks the line before a tool card when text did not end on one', () => {
    const text = render([
      START,
      { type: 'assistant.delta', turnId: 't1', text: 'Let me look' },
      { type: 'tool.call', turnId: 't1', callId: 'c1', name: 'list_dir', args: {}, risk: 'safe' },
    ]);
    expect(text).toContain('Let me look\n');
    expect(text).toMatch(/\n⚙ list_dir/u);
  });

  it('does not add a second newline when the text already ended on one', () => {
    const text = render([
      START,
      { type: 'assistant.delta', turnId: 't1', text: 'Done.\n' },
      { type: 'tool.call', turnId: 't1', callId: 'c1', name: 'exec', args: {}, risk: 'exec' },
    ]);
    expect(text).not.toContain('\n\n');
  });

  it('labels a tool call with its arguments', () => {
    const text = render([
      START,
      {
        type: 'tool.call',
        turnId: 't1',
        callId: 'c1',
        name: 'read_file',
        args: { path: 'README.md' },
        risk: 'safe',
      },
    ]);
    expect(text).toContain('⚙ read_file path="README.md"');
  });

  it('previews a tool result and says how much it is hiding', () => {
    const text = render(
      [
        START,
        {
          type: 'tool.result',
          turnId: 't1',
          callId: 'c1',
          ok: true,
          content: ['a', 'b', 'c', 'd'].join('\n'),
          truncated: false,
          durationMs: 120,
        },
      ],
      { toolResultLines: 2 },
    );
    expect(text).toContain('✓ 120ms');
    expect(text).toContain('    a\n');
    expect(text).toContain('    b\n');
    expect(text).not.toContain('    c\n');
    expect(text).toContain('… 2 more lines');
  });

  it('marks a failed call and reports truncation', () => {
    const text = render([
      START,
      {
        type: 'tool.result',
        turnId: 't1',
        callId: 'c1',
        ok: false,
        content: 'ENOENT',
        truncated: true,
        durationMs: 4,
      },
    ]);
    expect(text).toContain('✗ 4ms, truncated');
  });

  it('names the running tool in a heartbeat', () => {
    const text = render([
      START,
      { type: 'tool.call', turnId: 't1', callId: 'c1', name: 'exec', args: {}, risk: 'exec' },
      { type: 'tool.progress', turnId: 't1', callId: 'c1', elapsedMs: 15_000 },
    ]);
    expect(text).toContain('… exec 15.0s');
  });

  it('falls back to a generic label for a heartbeat it never saw the call for', () => {
    const text = render([
      START,
      { type: 'tool.progress', turnId: 't1', callId: 'unknown', elapsedMs: 1000 },
    ]);
    expect(text).toContain('… tool 1.0s');
  });

  it('heads the reasoning stream so it is not read as the answer', () => {
    const text = render([
      START,
      { type: 'reasoning.delta', turnId: 't1', text: 'weighing options' },
      { type: 'assistant.delta', turnId: 't1', text: 'Yes.' },
    ]);
    expect(text).toContain('┄ thinking');
    expect(text).toContain('weighing options');
    expect(text).toContain('Yes.');
  });

  it('hides reasoning entirely when asked to', () => {
    const text = render([START, { type: 'reasoning.delta', turnId: 't1', text: 'secret' }], {
      showReasoning: false,
    });
    expect(text).not.toContain('secret');
    expect(text).not.toContain('thinking');
  });

  it('shows a notice without letting it look like the answer', () => {
    const text = render([
      START,
      {
        type: 'notice',
        kind: 'prompt_injection',
        message: 'Tool output contained instruction-like text.',
        turnId: 't1',
      },
    ]);
    expect(text).toContain('⚠ Tool output contained instruction-like text.');
  });

  it('prints an error with its code and whether retrying is worth it', () => {
    const text = render([
      START,
      {
        type: 'error',
        code: 'provider_error',
        message: 'The provider ended the stream without a result.',
        retryable: true,
        turnId: 't1',
      },
    ]);
    expect(text).toContain('✖ The provider ended the stream without a result.');
    expect(text).toContain('provider_error · retryable');
  });

  it('explains a turn that hit a cap', () => {
    const text = render([
      START,
      { type: 'turn.end', turnId: 't1', stopReason: 'max_iterations', iterations: 40 },
    ]);
    expect(text).toContain('stopped at the tool-iteration cap');
    expect(text).toContain('40 steps');
  });

  it('reports usage when the provider sent any', () => {
    const text = render([
      START,
      {
        type: 'turn.end',
        turnId: 't1',
        stopReason: 'complete',
        iterations: 1,
        usage: {
          promptTokens: 1204,
          completionTokens: 88,
          totalTokens: 1292,
          cachedTokens: 1000,
          reasoningTokens: 40,
        },
      },
    ]);
    expect(text).toContain('1 step');
    expect(text).toContain('1.2k in / 88 out / 1.0k cached / 40 reasoning');
  });

  it('omits the summary line when usage is switched off', () => {
    const text = render(
      [START, { type: 'turn.end', turnId: 't1', stopReason: 'complete', iterations: 2 }],
      { showUsage: false },
    );
    expect(text).not.toContain('steps');
  });

  it('emits ANSI only when colour is enabled', () => {
    const plain = buffer();
    const coloured = buffer();
    const call: AgentEvent = {
      type: 'tool.call',
      turnId: 't1',
      callId: 'c1',
      name: 'exec',
      args: {},
      risk: 'exec',
    };
    new TurnRenderer({ out: plain, colors: false }).handle(call);
    new TurnRenderer({ out: coloured, colors: true }).handle(call);

    expect(plain.text).not.toContain('[');
    expect(coloured.text).toContain('[');
  });

  it('writes its own notes in the same line discipline', () => {
    const out = buffer();
    const renderer = new TurnRenderer({ out, colors: false });
    renderer.handle({ type: 'assistant.delta', turnId: 't1', text: 'mid-line' });
    renderer.note('a note');
    renderer.warn('a warning');
    expect(out.text).toBe('mid-line\na note\n⚠ a warning\n');
  });
});
