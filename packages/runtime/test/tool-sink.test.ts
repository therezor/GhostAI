import { ToolRegistry, defineTool, type AnyTool } from '@ghostbot/tools';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { registryToolSink } from '#src/tool-sink.js';

function tool(name: string): AnyTool {
  return defineTool({
    name,
    description: name,
    schema: z.strictObject({}),
    execute: () => name,
  });
}

describe('registryToolSink', () => {
  it('registers a server tools under the mcp source', () => {
    const registry = new ToolRegistry();
    const sink = registryToolSink(registry, 'mcp');

    expect(sink.replace('demo', [tool('mcp_demo_a')])).toEqual([]);
    expect(registry.sourceOf('mcp_demo_a')).toBe('mcp');
  });

  it('removes only the names the server it is replacing had', () => {
    // `unregisterBySource('mcp')` is the wrong grain here: it would take every
    // *other* server's tools with it.
    const registry = new ToolRegistry();
    const sink = registryToolSink(registry, 'mcp');
    sink.replace('one', [tool('mcp_one_a')]);
    sink.replace('two', [tool('mcp_two_a')]);

    sink.replace('one', [tool('mcp_one_b')]);

    expect(registry.names()).toEqual(['mcp_one_b', 'mcp_two_a']);
  });

  it('unregisters everything for a server that went away', () => {
    const registry = new ToolRegistry();
    const sink = registryToolSink(registry, 'mcp');
    sink.replace('demo', [tool('mcp_demo_a'), tool('mcp_demo_b')]);

    sink.replace('demo', []);

    expect(registry.names()).toEqual([]);
  });

  it('is idempotent, so a repeated publish does not double-register', () => {
    const registry = new ToolRegistry();
    const sink = registryToolSink(registry, 'mcp');
    sink.replace('demo', [tool('mcp_demo_a')]);

    expect(() => {
      sink.replace('demo', [tool('mcp_demo_a')]);
    }).not.toThrow();
    expect(registry.names()).toEqual(['mcp_demo_a']);
  });

  it('reports a clash with another source and keeps the rest', () => {
    // One collision must not cost a server its other thirty-nine tools, nor
    // take down the reconcile that was registering them.
    const registry = new ToolRegistry();
    registry.register(tool('read_file'), 'builtin');
    const sink = registryToolSink(registry, 'mcp');

    const rejected = sink.replace('demo', [
      tool('read_file'),
      tool('mcp_demo_ok'),
    ]);

    expect(rejected).toEqual(['read_file']);
    expect(registry.sourceOf('read_file')).toBe('builtin');
    expect(registry.has('mcp_demo_ok')).toBe(true);
  });

  it('does not later unregister a name it never owned', () => {
    const registry = new ToolRegistry();
    registry.register(tool('read_file'), 'builtin');
    const sink = registryToolSink(registry, 'mcp');
    sink.replace('demo', [tool('read_file'), tool('mcp_demo_ok')]);

    sink.replace('demo', []);

    // The built-in survives its namesake's server being torn down.
    expect(registry.sourceOf('read_file')).toBe('builtin');
  });
});
