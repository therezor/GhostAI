import { isAbortError, isGhostError } from '@ghostai/core';
import { DEFAULT_TOOLS_CONFIG, type ToolContext } from '@ghostai/tools';
import { WorkspaceJail } from '@ghostai/security';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { bridgeTool, flattenContent } from '#src/bridge.js';
import type { McpCallResult, McpToolDescriptor } from '#src/session.js';
import { ECHO_TOOL } from '#testkit/fake-server.js';

const temporaries: string[] = [];

function context(): ToolContext {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'ghostai-mcp-')));
  temporaries.push(base);
  return {
    jail: new WorkspaceJail({ root: join(base, 'workspace') }),
    signal: new AbortController().signal,
    config: DEFAULT_TOOLS_CONFIG,
  };
}

afterEach(() => {
  while (temporaries.length > 0) {
    rmSync(temporaries.pop() ?? '', { recursive: true, force: true });
  }
});

function bridge(
  descriptor: McpToolDescriptor,
  answer: McpCallResult = { content: [{ type: 'text', text: 'ok' }] },
) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const bridged = bridgeTool({
    serverId: 'demo',
    descriptor,
    advertisedName: `mcp_demo_${descriptor.name}`,
    toolTimeoutMs: 0,
    call: async (name, args) => {
      calls.push({ name, args });
      return await Promise.resolve(answer);
    },
  });
  return { bridged, calls };
}

describe('bridgeTool', () => {
  it('advertises the flattened name and calls the upstream one', async () => {
    const { bridged, calls } = bridge(ECHO_TOOL);
    expect('tool' in bridged).toBe(true);
    if (!('tool' in bridged)) return;

    expect(bridged.tool.name).toBe('mcp_demo_echo');
    expect(bridged.upstreamName).toBe('echo');
    await bridged.tool.run({ text: 'hi' }, context());
    expect(calls).toEqual([{ name: 'echo', args: { text: 'hi' } }]);
  });

  it('reports its source as mcp, and honours an override', () => {
    const { bridged } = bridge(ECHO_TOOL);
    if (!('tool' in bridged)) throw new Error('expected a tool');
    expect(bridged.tool.definition().source).toBe('mcp');
    expect(bridged.tool.definition('extension').source).toBe('extension');
  });

  it('takes a read-only claim at face value and nothing else', () => {
    const read = bridge({ ...ECHO_TOOL, annotations: { readOnlyHint: true } });
    const silent = bridge({ ...ECHO_TOOL, annotations: undefined });
    const destructive = bridge({
      ...ECHO_TOOL,
      annotations: { destructiveHint: true },
    });

    if (!('tool' in read.bridged)) throw new Error('expected a tool');
    if (!('tool' in silent.bridged)) throw new Error('expected a tool');
    if (!('tool' in destructive.bridged)) throw new Error('expected a tool');

    expect(read.bridged.tool.risk).toBe('safe');
    // Silence is not the same claim: this is third-party code over a socket.
    expect(silent.bridged.tool.risk).toBe('network');
    expect(destructive.bridged.tool.risk).toBe('exec');
  });

  it('passes annotations through, because the vocabularies are the same', () => {
    const { bridged } = bridge({
      ...ECHO_TOOL,
      annotations: { readOnlyHint: true, title: 'Echo' },
    });
    if (!('tool' in bridged)) throw new Error('expected a tool');
    expect(bridged.tool.definition().annotations).toEqual({
      readOnlyHint: true,
      title: 'Echo',
    });
  });

  it('falls back through title to a sentence, never to nothing', () => {
    const titled = bridge({
      ...ECHO_TOOL,
      description: '',
      annotations: undefined,
      title: 'Repeat a string',
    });
    const bare = bridge({
      ...ECHO_TOOL,
      description: undefined,
      title: undefined,
    });
    if (!('tool' in titled.bridged)) throw new Error('expected a tool');
    if (!('tool' in bare.bridged)) throw new Error('expected a tool');

    expect(titled.bridged.tool.description).toBe('Repeat a string');
    expect(bare.bridged.tool.description).toContain('demo');
    expect(bare.bridged.tool.description).toContain('echo');
  });

  it('drops one unusable tool rather than the whole server', () => {
    const bridged = bridgeTool({
      serverId: 'demo',
      descriptor: { name: 'broken', inputSchema: { type: 'string' } },
      advertisedName: 'mcp_demo_broken',
      toolTimeoutMs: 0,
      call: async () => await Promise.resolve({}),
    });
    expect('tool' in bridged).toBe(false);
    expect(bridged.issues[0]?.message).toContain('must take an object');
  });

  it('carries a schema warning without refusing the tool', () => {
    const { bridged } = bridge({
      name: 'sloppy',
      inputSchema: { type: 'object', properties: { a: { type: 'string' } } },
    });
    expect('tool' in bridged).toBe(true);
    expect(bridged.issues[0]?.message).toContain('no description');
  });

  it('reports a remote failure as a result the model can read', async () => {
    const { bridged } = bridge(ECHO_TOOL, {
      content: [{ type: 'text', text: 'no such repository' }],
      isError: true,
    });
    if (!('tool' in bridged)) throw new Error('expected a tool');

    const output = await bridged.tool.run({ text: 'hi' }, context());
    expect(output).toMatchObject({
      content: 'no such repository',
      isError: true,
    });
  });

  it('throws a typed error for arguments that do not validate', async () => {
    const { bridged } = bridge(ECHO_TOOL);
    if (!('tool' in bridged)) throw new Error('expected a tool');
    const failure = await bridged.tool.run({ nope: true }, context()).then(
      () => null,
      (error: unknown) => error,
    );
    expect(isGhostError(failure)).toBe(true);
  });

  it('honours an already-aborted signal before it calls anything', async () => {
    const { bridged, calls } = bridge(ECHO_TOOL);
    if (!('tool' in bridged)) throw new Error('expected a tool');
    const failure = await bridged.tool
      .run({ text: 'hi' }, { ...context(), signal: AbortSignal.abort() })
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(isAbortError(failure)).toBe(true);
    expect(calls).toEqual([]);
  });

  it('keeps structured output for the audit log, out of the prompt', async () => {
    const { bridged } = bridge(ECHO_TOOL, {
      content: [{ type: 'text', text: 'ok' }],
      structuredContent: { count: 2 },
    });
    if (!('tool' in bridged)) throw new Error('expected a tool');
    const output = await bridged.tool.run({ text: 'hi' }, context());
    expect(output).toMatchObject({
      content: 'ok',
      details: { structuredContent: { count: 2 } },
    });
  });
});

describe('flattenContent', () => {
  it('joins text parts', () => {
    expect(
      flattenContent({
        content: [
          { type: 'text', text: 'one' },
          { type: 'text', text: 'two' },
        ],
      }),
    ).toBe('one\ntwo');
  });

  it('describes a binary part instead of pasting its base64', () => {
    // A model reads nothing from base64, and the bytes would consume the whole
    // of `maxOutputChars`, evicting the text that does say something.
    const flattened = flattenContent({
      content: [
        { type: 'image', data: 'AAAA'.repeat(64), mimeType: 'image/png' },
      ],
    });
    expect(flattened).toContain('image/png');
    expect(flattened).not.toContain('AAAA');
  });

  it('prefers a resource text over its uri', () => {
    expect(
      flattenContent({
        content: [
          { type: 'resource', resource: { uri: 'file:///a', text: 'body' } },
        ],
      }),
    ).toBe('body');
    expect(
      flattenContent({
        content: [{ type: 'resource', resource: { uri: 'file:///a' } }],
      }),
    ).toBe('file:///a');
  });

  it('names a part it does not understand rather than dropping it', () => {
    expect(flattenContent({ content: [{ type: 'invented' }] })).toBe(
      '[invented — not shown]',
    );
  });

  it('falls back to structured output when there are no content parts', () => {
    // Showing the model nothing would look like a tool that silently did
    // nothing, which is the one outcome it cannot recover from.
    expect(flattenContent({ structuredContent: { ok: true } })).toContain('ok');
  });

  it('is empty for a result that genuinely carried nothing', () => {
    expect(flattenContent({})).toBe('');
  });
});
