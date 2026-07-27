/**
 * The built-in tool set.
 *
 * Five tools, and the reason there are only five is that every one of them is a
 * capability the agent cannot obtain any other way. Anything expressible as a
 * command — `grep`, `find`, `git` — is `exec`'s job, and adding a tool per
 * command would spend context on definitions the model already knows how to
 * write in argv form.
 *
 * `exec` is registered conditionally. A disabled exec tool that still appears in
 * the definitions list is worse than no exec tool at all: the model spends a
 * turn calling it, gets `permission_denied`, and has learned nothing it could
 * not have been told by its absence.
 */

import type { ToolsConfig } from '@ghostai/protocol';

import type { AnyTool } from '../define.js';
import type { ToolRegistry } from '../registry.js';
import { editFileTool } from './edit-file.js';
import { execTool } from './exec.js';
import { listDirTool } from './list-dir.js';
import { readFileTool } from './read-file.js';
import { writeFileTool } from './write-file.js';

export { editFileTool } from './edit-file.js';
export { execTool } from './exec.js';
export { listDirTool } from './list-dir.js';
export { readFileTool } from './read-file.js';
export { writeFileTool } from './write-file.js';

/** Every built-in, including `exec`. */
export const BUILTIN_TOOLS: readonly AnyTool[] = Object.freeze([
  readFileTool,
  writeFileTool,
  editFileTool,
  listDirTool,
  execTool,
]);

/** The built-ins that config can switch off, and the switch that does it. */
export function builtinTools(config?: ToolsConfig): readonly AnyTool[] {
  if (config?.exec.enable === false) {
    return BUILTIN_TOOLS.filter((tool) => tool !== execTool);
  }
  return BUILTIN_TOOLS;
}

/** Registers the built-ins under the `builtin` source. */
export function registerBuiltins(registry: ToolRegistry, config?: ToolsConfig): void {
  registry.registerAll(builtinTools(config), 'builtin');
}
