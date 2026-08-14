import { describe, expect, it } from 'vitest';

import {
  assistantMessage,
  filePart,
  textPart,
  toolMessage,
  userMessage,
} from '@ghostwire/core';
import type { ToolDefinition } from '@ghostwire/protocol';

import { estimateMessageTokens, estimateToolTokens } from '#src/measure.js';
import { estimateTokens } from '#src/tokens.js';

const REASONING = 'x'.repeat(4000);

/**
 * Annotated, because the bookkeeping is the point.
 *
 * A bare definition encodes to about the length it stores at — the `type` and
 * `function` wrapper the body adds is roughly as long as the `risk` and
 * `source` it drops, which makes a bare fixture prove nothing either way. What
 * a real tool carries beyond those two is where the two figures separate.
 */
const TOOL: ToolDefinition = {
  name: 'exec',
  description: 'Runs a command.',
  risk: 'exec',
  source: 'mcp',
  parameters: { type: 'object', properties: { cmd: { type: 'string' } } },
  annotations: {
    title: 'Run a shell command in the workspace',
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
  },
};

describe('estimateMessageTokens', () => {
  it('ignores the reasoning an assistant kept, which the wire never carries', () => {
    const thought = assistantMessage('hi', { reasoning: REASONING });

    expect(estimateMessageTokens(thought)).toBe(
      estimateMessageTokens(assistantMessage('hi')),
    );
    // The assertion that makes this test mean something: the figure the old
    // measurement produced is a thousand tokens larger, so this cannot pass by
    // accident against a formula that stringifies the record.
    expect(estimateMessageTokens(thought)).toBeLessThan(
      estimateTokens(JSON.stringify(thought)),
    );
  });

  it('counts a tool call, which it does', () => {
    const called = assistantMessage('', {
      toolCalls: [{ id: 'a', name: 'exec', argumentsJson: '{"cmd":"ls"}' }],
    });

    expect(estimateMessageTokens(called)).toBeGreaterThan(
      estimateMessageTokens(assistantMessage('')),
    );
  });

  it('measures the collapsed string for text-only content', () => {
    // Two text parts become one newline-joined string on the wire, so the
    // figure is of that string and not of an array of objects around it.
    const parts = userMessage([textPart('first'), textPart('second')]);

    expect(estimateMessageTokens(parts)).toBe(
      estimateTokens(
        JSON.stringify({ role: 'user', content: 'first\nsecond' }),
      ),
    );
  });

  it('measures a file part as the reference the wire would carry', () => {
    const attached = userMessage([filePart('notes.md', 'text/plain')]);

    // Not the file's contents: `materialiseAttachments` expands those, and it
    // has not run here. What is priced is what this object encodes to.
    expect(estimateMessageTokens(attached)).toBeGreaterThan(0);
    expect(estimateMessageTokens(attached)).toBeLessThan(50);
  });

  it('measures a tool result whole', () => {
    const result = toolMessage('a', 'exec', 'y'.repeat(400));

    expect(estimateMessageTokens(result)).toBeGreaterThan(100);
  });
});

describe('estimateToolTokens', () => {
  it('bills the three fields a body carries and no others', () => {
    expect(estimateToolTokens([TOOL])).toBe(
      estimateTokens(
        JSON.stringify([
          {
            type: 'function',
            function: {
              name: TOOL.name,
              description: TOOL.description,
              parameters: TOOL.parameters,
            },
          },
        ]),
      ),
    );
    // `risk` and `source` drive an approval prompt and a badge, and no model
    // has seen either — so the old figure was larger for nothing.
    expect(estimateToolTokens([TOOL])).toBeLessThan(
      estimateTokens(JSON.stringify([TOOL])),
    );
  });

  it('prices the array, so two tools cost more than one', () => {
    expect(estimateToolTokens([TOOL, TOOL])).toBeGreaterThan(
      estimateToolTokens([TOOL]),
    );
  });
});
