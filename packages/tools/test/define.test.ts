import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { isGhostError } from '@ghostwire/core';

import { assertNotAborted, defineTool, toToolResult } from '#src/define.js';
import { createTestWorkspace } from '#testkit/workspace.js';

const echo = defineTool({
  name: 'echo',
  description: 'Echo a value back.',
  schema: z.strictObject({
    text: z.string().min(1),
    times: z.coerce.number().int().min(1).default(1),
  }),
  execute(args) {
    return args.text.repeat(args.times);
  },
});

describe('defineTool', () => {
  it('derives JSON Schema from the Zod schema once', () => {
    expect(echo.parameters).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['text'],
    });
    // Computed at definition time, so the same object is handed out every turn.
    expect(echo.definition().parameters).toBe(echo.parameters);
  });

  it('advertises the input view, so a defaulted field is not required', () => {
    // The output view would list `times` as required — it is always present
    // after parsing — and the model would dutifully invent a value for it.
    expect(echo.parameters.required).toEqual(['text']);
  });

  it('strips the $schema document annotation', () => {
    expect(echo.parameters.$schema).toBeUndefined();
  });

  it('freezes the advertised schema', () => {
    expect(Object.isFrozen(echo.parameters)).toBe(true);
  });

  it('defaults risk to safe and source to builtin', () => {
    expect(echo.risk).toBe('safe');
    expect(echo.definition()).toMatchObject({
      risk: 'safe',
      source: 'builtin',
    });
  });

  it('carries the source it is asked for', () => {
    expect(echo.definition('mcp').source).toBe('mcp');
  });

  it('omits annotations when the tool declares none', () => {
    expect(echo.definition().annotations).toBeUndefined();
  });

  it('rejects a name a provider would refuse', () => {
    expect(() =>
      defineTool({
        name: 'web search',
        description: 'x',
        schema: z.strictObject({}),
        execute: () => '',
      }),
    ).toThrow(/must match/);
  });

  it('rejects an empty description', () => {
    expect(() =>
      defineTool({
        name: 'nameless',
        description: '   ',
        schema: z.strictObject({}),
        execute: () => '',
      }),
    ).toThrow(/no description/);
  });

  it('rejects a non-object schema', () => {
    expect(() =>
      defineTool({
        name: 'scalar',
        description: 'x',
        schema: z.string(),
        execute: () => '',
      }),
    ).toThrow(/must take an object/);
  });

  it('rejects a schema that would strip unknown arguments', () => {
    expect(() =>
      defineTool({
        name: 'loose',
        description: 'x',
        // z.object strips unknown keys, which would run a different call from
        // the one the model made without telling anyone.
        schema: z.object({ a: z.string() }),
        execute: () => '',
      }),
    ).toThrow(/strictObject/);
  });

  it('rejects a schema with no JSON Schema form', () => {
    expect(() =>
      defineTool({
        name: 'unrepresentable',
        description: 'x',
        schema: z.strictObject({ when: z.date() }),
        execute: () => '',
      }),
    ).toThrow(/no JSON Schema form/);
  });
});

describe('parseArgs', () => {
  it('accepts valid arguments and applies defaults', () => {
    const parsed = echo.parseArgs({ text: 'hi' });
    expect(parsed).toEqual({ ok: true, args: { text: 'hi', times: 1 } });
  });

  it('coerces the string numbers models emit', () => {
    const parsed = echo.parseArgs({ text: 'hi', times: '3' });
    expect(parsed.ok && parsed.args).toEqual({ text: 'hi', times: 3 });
  });

  it('treats a missing argument object as empty rather than malformed', () => {
    // Providers hand through `undefined` for a no-argument call; the schema's
    // own `required` list is what should decide, not the absence itself.
    const parsed = echo.parseArgs(undefined);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.issues[0]?.path).toBe('text');
  });

  it('reports the offending path in the message', () => {
    const parsed = echo.parseArgs({ text: 42 });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.message).toContain('echo');
      expect(parsed.message).toContain('text');
      expect(parsed.issues).toEqual([
        { path: 'text', message: expect.any(String) },
      ]);
    }
  });

  it('rejects an unknown key instead of stripping it', () => {
    expect(echo.parseArgs({ text: 'hi', extra: true }).ok).toBe(false);
  });
});

describe('run', () => {
  it('validates then executes', async () => {
    const workspace = createTestWorkspace();
    try {
      await expect(
        echo.run({ text: 'ab', times: 2 }, workspace.context),
      ).resolves.toBe('abab');
    } finally {
      workspace.dispose();
    }
  });

  it('throws invalid_input carrying the issues', async () => {
    const workspace = createTestWorkspace();
    try {
      const error = await echo
        .run({}, workspace.context)
        .catch((value: unknown) => value);
      expect(isGhostError(error)).toBe(true);
      if (isGhostError(error)) {
        expect(error.kind).toBe('invalid_input');
        expect(error.details.tool).toBe('echo');
      }
    } finally {
      workspace.dispose();
    }
  });

  it('awaits an async handler', async () => {
    const slow = defineTool({
      name: 'slow',
      description: 'Resolve later.',
      schema: z.strictObject({}),
      execute: async () => await Promise.resolve('done'),
    });
    const workspace = createTestWorkspace();
    try {
      await expect(slow.run({}, workspace.context)).resolves.toBe('done');
    } finally {
      workspace.dispose();
    }
  });
});

describe('helpers', () => {
  it('normalises a string result', () => {
    expect(toToolResult('text')).toEqual({ content: 'text' });
    expect(toToolResult({ content: 'text', isError: true })).toEqual({
      content: 'text',
      isError: true,
    });
  });

  it('throws the taxonomy abort rather than a DOMException', () => {
    const error = (() => {
      try {
        assertNotAborted(AbortSignal.abort(), 'thing');
      } catch (value: unknown) {
        return value;
      }
      return null;
    })();
    expect(isGhostError(error)).toBe(true);
    if (isGhostError(error)) expect(error.kind).toBe('aborted');
  });

  it('does nothing when the signal is live', () => {
    expect(() => {
      assertNotAborted(new AbortController().signal, 'thing');
    }).not.toThrow();
  });
});
