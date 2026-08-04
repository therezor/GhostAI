/**
 * The one module that knows both `McpManager` and `ToolRegistry`.
 *
 * `@ghostai/mcp` declares `McpToolSink` and never learns what is behind it;
 * `@ghostai/tools` has no idea MCP exists. This is the composition root's job,
 * and it is twenty lines because the two interfaces were designed to meet.
 *
 * The bookkeeping is the reason it exists at all. `unregisterBySource('mcp')`
 * is the wrong grain for one server reconnecting — it would take every *other*
 * server's tools with it — so the names each server last contributed are
 * remembered here and removed by name.
 *
 * **It never throws.** A name that collides with a built-in, a toolbox program
 * or another server comes back as a rejected name rather than an exception:
 * `ToolRegistry.register` treats a duplicate as a `conflict`, and one clash
 * must not cost a server its other thirty-nine tools, nor take down the
 * reconcile that was registering them.
 */

import { isGhostError } from '@ghostai/core';
import type { McpToolSink } from '@ghostai/mcp';
import type { AnyTool, ToolRegistry } from '@ghostai/tools';

/**
 * No logger, deliberately: the rejected names are *returned*, and `McpManager`
 * is where they are written out — beside the server they belong to. Logging
 * them here as well would say the same thing twice from two places.
 */
export function registryToolSink(registry: ToolRegistry): McpToolSink {
  /** Server id → the names it currently holds in the registry. */
  const owned = new Map<string, readonly string[]>();

  return {
    replace(serverId: string, tools: readonly AnyTool[]): readonly string[] {
      for (const name of owned.get(serverId) ?? []) registry.unregister(name);

      const accepted: string[] = [];
      const rejected: string[] = [];
      for (const tool of tools) {
        try {
          registry.register(tool, 'mcp');
          accepted.push(tool.name);
        } catch (error) {
          rejected.push(tool.name);
          if (!isGhostError(error) || error.kind !== 'conflict') throw error;
        }
      }

      if (accepted.length === 0) owned.delete(serverId);
      else owned.set(serverId, accepted);
      return rejected;
    },
  };
}
