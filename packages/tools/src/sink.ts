/**
 * How a subsystem that owns a changing set of tools hands them to a registry.
 *
 * One method, and it **replaces** rather than adds: an MCP server that
 * reconnects with a shorter list must lose the tools it no longer has, and an
 * extension that reloads must lose the ones its new code stopped registering.
 * Expressing that as add-plus-remove would put the bookkeeping in two places
 * that can disagree.
 *
 * `unregisterBySource` is the wrong grain for both of them. It is exact by
 * *source* — `mcp`, `extension` — and one server reconnecting or one extension
 * reloading would take every sibling's tools with it. `ownerId` is the finer
 * key the implementation remembers names under.
 *
 * It is declared here rather than in `@ghostai/mcp`, where it started, because
 * two packages now consume it and neither may import the other. `@ghostai/tools`
 * is the one place both already depend on, and the interface is about a
 * registry rather than about MCP.
 */

import type { AnyTool } from './define.js';

export interface ToolSink {
  /**
   * Replaces everything `ownerId` currently holds.
   *
   * Returns the names it could not register — a collision with a built-in, a
   * toolbox program or another owner. Returned rather than thrown: one clash
   * must not cost an owner its other thirty-nine tools, and the caller is the
   * one that knows where to report it.
   */
  replace(ownerId: string, tools: readonly AnyTool[]): readonly string[];
}
