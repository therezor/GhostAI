import { describe, expect, it } from 'vitest';

import {
  assistantMessage,
  hasImages,
  imagePart,
  systemMessage,
  textOf,
  textPart,
  toolMessage,
  userMessage,
  withoutImages,
} from './messages.js';

const png = imagePart('image/png', { data: 'aGVsbG8=' });

describe('content parts', () => {
  it('builds a text part', () => {
    expect(textPart('hi')).toEqual({ type: 'text', text: 'hi' });
  });

  it('builds an inline image part', () => {
    expect(imagePart('image/png', { data: 'aGVsbG8=' })).toEqual({
      type: 'image',
      mimeType: 'image/png',
      data: 'aGVsbG8=',
    });
  });

  it('builds a referenced image part', () => {
    expect(imagePart('image/jpeg', { url: 'https://host/signed' })).toEqual({
      type: 'image',
      mimeType: 'image/jpeg',
      url: 'https://host/signed',
    });
  });
});

describe('message constructors', () => {
  it('builds a system message', () => {
    expect(systemMessage('you are a ghost')).toEqual({
      role: 'system',
      content: 'you are a ghost',
    });
  });

  it('wraps a plain string as a user message', () => {
    expect(userMessage('hello')).toEqual({ role: 'user', content: [textPart('hello')] });
  });

  it('accepts explicit parts for multimodal input', () => {
    expect(userMessage([textPart('look'), png]).content).toEqual([textPart('look'), png]);
  });

  it('copies the parts array so the caller cannot mutate the message', () => {
    const parts = [textPart('a')];
    const message = userMessage(parts);
    parts.push(textPart('b'));
    expect(message.content).toHaveLength(1);
  });

  it('defaults an assistant message to no tool calls', () => {
    expect(assistantMessage('done')).toEqual({
      role: 'assistant',
      content: [textPart('done')],
      toolCalls: [],
    });
  });

  it('carries tool calls and reasoning', () => {
    const call = { id: 'a', name: 'read_file', argumentsJson: '{}' };
    expect(assistantMessage('', { toolCalls: [call], reasoning: 'thinking' })).toMatchObject({
      toolCalls: [call],
      reasoning: 'thinking',
    });
  });

  it('omits reasoning entirely when there is none', () => {
    expect('reasoning' in assistantMessage('done')).toBe(false);
  });

  it('defaults a tool message to a successful, untruncated result', () => {
    expect(toolMessage('a', 'read_file', 'contents')).toEqual({
      role: 'tool',
      toolCallId: 'a',
      name: 'read_file',
      content: 'contents',
      isError: false,
      truncated: false,
    });
  });

  it('flags a failed tool result explicitly', () => {
    // An explicit flag, because inspecting the content for an "Error" prefix
    // misfires on any tool whose legitimate output starts with that word.
    expect(toolMessage('a', 'exec', 'Error: nope', { isError: true }).isError).toBe(true);
  });
});

describe('textOf', () => {
  it('reads a system message', () => {
    expect(textOf(systemMessage('prompt'))).toBe('prompt');
  });

  it('reads a tool message', () => {
    expect(textOf(toolMessage('a', 't', 'output'))).toBe('output');
  });

  it('reads a single-part message', () => {
    expect(textOf(userMessage('hello'))).toBe('hello');
  });

  it('joins several parts with a newline rather than gluing them', () => {
    expect(textOf(assistantMessage([textPart('first'), textPart('second')]))).toBe('first\nsecond');
  });

  it('drops image parts', () => {
    expect(textOf(userMessage([textPart('look at this'), png]))).toBe('look at this');
  });

  it('returns an empty string for an image-only message', () => {
    expect(textOf(userMessage([png]))).toBe('');
  });

  it('returns an empty string for an empty message', () => {
    expect(textOf(userMessage([]))).toBe('');
  });
});

describe('hasImages', () => {
  it('detects an image part', () => {
    expect(hasImages(userMessage([textPart('x'), png]))).toBe(true);
  });

  it('is false for text-only and for roles that cannot carry parts', () => {
    expect(hasImages(userMessage('x'))).toBe(false);
    expect(hasImages(systemMessage('x'))).toBe(false);
    expect(hasImages(toolMessage('a', 't', 'x'))).toBe(false);
  });
});

describe('withoutImages', () => {
  it('strips images and keeps the text', () => {
    const stripped = withoutImages(userMessage([textPart('look'), png]));
    expect(stripped.role === 'user' && stripped.content).toEqual([textPart('look')]);
  });

  it('returns the same object when there is nothing to strip', () => {
    const message = userMessage('plain');
    expect(withoutImages(message)).toBe(message);
  });

  it('leaves roles that cannot carry images alone', () => {
    const system = systemMessage('x');
    const tool = toolMessage('a', 't', 'x');
    expect(withoutImages(system)).toBe(system);
    expect(withoutImages(tool)).toBe(tool);
  });

  it('preserves tool calls while stripping images', () => {
    const call = { id: 'a', name: 't', argumentsJson: '{}' };
    const stripped = withoutImages(assistantMessage([textPart('x'), png], { toolCalls: [call] }));
    expect(stripped).toMatchObject({ toolCalls: [call] });
  });
});
