/**
 * The one module that knows both a tool-owning subsystem and `ToolRegistry`.
 *
 * `@ghostbot/tools` declares `ToolSink` and never learns what fills it;
 * `@ghostbot/mcp` and `@ghostbot/extension-host` each hold one and never learn
 * what is behind it. This is the composition root's job, and it is thirty lines
 * because the interfaces were designed to meet.
 *
 * The bookkeeping is the reason it exists at all. `unregisterBySource('mcp')`
 * is the wrong grain for one server reconnecting — it would take every *other*
 * server's tools with it — so the names each owner last contributed are
 * remembered here and removed by name. An extension reloading needs exactly the
 * same thing, which is why `source` is an argument rather than a constant: one
 * applier, two owners, and the `ToolSource` tag still exact for the case where
 * a whole subsystem goes away at once.
 *
 * **It never throws.** A name that collides with a built-in, a toolbox program
 * or another owner comes back as a rejected name rather than an exception:
 * `ToolRegistry.register` treats a duplicate as a `conflict`, and one clash
 * must not cost an owner its other thirty-nine tools, nor take down the
 * reconcile that was registering them.
 */

import { isGhostError } from '@ghostbot/core';
import type { ToolSource } from '@ghostbot/protocol';
import type { AnyTool, ToolRegistry, ToolSink } from '@ghostbot/tools';

/**
 * No logger, deliberately: the rejected names are *returned*, and the owning
 * manager is where they are written out — beside the server or extension they
 * belong to. Logging them here as well would say the same thing twice from two
 * places.
 */
export function registryToolSink(
  registry: ToolRegistry,
  source: ToolSource,
): ToolSink {
  /** Owner id → the names it currently holds in the registry. */
  const owned = new Map<string, readonly string[]>();

  return {
    replace(ownerId: string, tools: readonly AnyTool[]): readonly string[] {
      for (const name of owned.get(ownerId) ?? []) registry.unregister(name);

      const accepted: string[] = [];
      const rejected: string[] = [];
      for (const tool of tools) {
        try {
          registry.register(tool, source);
          accepted.push(tool.name);
        } catch (error) {
          rejected.push(tool.name);
          if (!isGhostError(error) || error.kind !== 'conflict') throw error;
        }
      }

      if (accepted.length === 0) owned.delete(ownerId);
      else owned.set(ownerId, accepted);
      return rejected;
    },
  };
}
