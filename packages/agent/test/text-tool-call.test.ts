import { describe, expect, it } from 'vitest';

import {
  textToolCallCorrection,
  textToolCallName,
} from '#src/text-tool-call.js';

const KNOWN = ['search', 'fetch', 'exec', 'read_file'];

describe('textToolCallName', () => {
  it('finds the call from the transcript that motivated this', () => {
    // Verbatim from `liquid/lfm2-24b-a2b`, on the iteration after `search`
    // returned an error. Note the `<tool_output>` wrapper: the model is copying
    // the envelope the tool-output policy describes, which is not a shape any
    // provider parses.
    const text = `The search tool is currently rate-limited. I will try using the \`fetch\` tool to retrieve news articles directly from a reputable news source.

<tool_output>
<tool_call>
{"name": "fetch", "arguments": ["https://www.bbc.com/news"]}
</tool_call>
</tool_output>`;

    expect(textToolCallName(text, KNOWN)).toBe('fetch');
  });

  it('reads the other wrappers models reach for', () => {
    expect(
      textToolCallName(
        '<function_call>{"name":"search"}</function_call>',
        KNOWN,
      ),
    ).toBe('search');
    expect(
      textToolCallName('<tool_use>{"name": "exec"}</tool_use>', KNOWN),
    ).toBe('exec');
    expect(
      textToolCallName(
        '```json\n{"name": "search", "arguments": {"args": ["x"]}}\n```',
        KNOWN,
      ),
    ).toBe('search');
  });

  it('reads a bare object from a model that wraps nothing', () => {
    expect(
      textToolCallName(
        'I will call {"name": "read_file", "arguments": {}}',
        KNOWN,
      ),
    ).toBe('read_file');
  });

  it('says nothing about an ordinary answer', () => {
    // The path almost every message takes, and the reason the cheap guards come
    // before any regex work.
    expect(textToolCallName('The answer is 42.', KNOWN)).toBeUndefined();
    expect(textToolCallName('', KNOWN)).toBeUndefined();
    expect(
      textToolCallName('I searched and found three results.', KNOWN),
    ).toBeUndefined();
  });

  it('ignores a name that is not a registered tool', () => {
    // Prose *about* tools rather than an attempt to use one. Correcting this would
    // be scolding the model for an answer that was fine.
    expect(
      textToolCallName('<tool_call>{"name": "browse_web"}</tool_call>', KNOWN),
    ).toBeUndefined();
    expect(
      textToolCallName('{"name": "Alice", "age": 30}', KNOWN),
    ).toBeUndefined();
  });

  it('ignores everything when no tools are registered', () => {
    expect(
      textToolCallName('<tool_call>{"name":"search"}</tool_call>', []),
    ).toBeUndefined();
  });

  it('does not carry regex state between calls', () => {
    // Module-level regexes with the `g` flag share `lastIndex`, so a second call
    // would otherwise start from wherever the first one stopped and miss a match
    // near the beginning of the string.
    const text = '<tool_call>{"name":"search"}</tool_call>';
    expect(textToolCallName(text, KNOWN)).toBe('search');
    expect(textToolCallName(text, KNOWN)).toBe('search');
    expect(textToolCallName(text, KNOWN)).toBe('search');
  });

  it('finds a call among several candidates, preferring one that is real', () => {
    const text = `<tool_call>{"name": "not_a_tool"}</tool_call>
<tool_call>{"name": "fetch", "arguments": {}}</tool_call>`;

    expect(textToolCallName(text, KNOWN)).toBe('fetch');
  });
});

describe('textToolCallCorrection', () => {
  it('names the tool, because generic advice is not actionable', () => {
    const correction = textToolCallCorrection('fetch');

    expect(correction).toContain('`fetch`');
    expect(correction).toContain('nothing ran');
    // The escape hatch matters: a model that genuinely cannot make the call has
    // to be told to say so, or it writes out a third one.
    expect(correction).toContain('say so in plain words');
  });
});
