/**
 * The built-in tool set.
 *
 * Eight tools, and the reason there are only eight is that every one of them is
 * a capability the agent cannot obtain any other way. Anything expressible as a
 * command — `grep`, `find`, `git` — is `exec`'s job, and adding a tool per
 * command would spend context on definitions the model already knows how to
 * write in argv form.
 *
 * `memory` and `skill` are the two that do not quite fit that test, and they are
 * here for a second reason: a tool carries a per-agent permission, so being a
 * tool is what makes each feature switchable without a config flag beside it
 * that could disagree. `skill` in particular reverses a decision
 * `skills-contributor.ts` argued for; both files say so.
 *
 * `exec` is registered conditionally. A disabled exec tool that still appears in
 * the definitions list is worse than no exec tool at all: the model spends a
 * turn calling it, gets `permission_denied`, and has learned nothing it could
 * not have been told by its absence. `automation` follows the same rule against
 * `scheduler.enabled` — an install with the scheduler switched off should not
 * advertise a way to schedule.
 *
 * `automation` is also the one built-in absent from `DEFAULT_AGENT_TOOLS`, so
 * being registered is not the same as being reachable: no agent has it until an
 * operator grants it.
 */

import type { ToolsConfig } from '@ghostai/protocol';

import type { AnyTool } from '../define.js';
import type { ToolRegistry } from '../registry.js';
import { automationTool } from './automation.js';
import { editFileTool } from './edit-file.js';
import { execTool } from './exec.js';
import { listDirTool } from './list-dir.js';
import { memoryTool } from './memory.js';
import { readFileTool } from './read-file.js';
import { skillTool } from './skill.js';
import { writeFileTool } from './write-file.js';

export { automationTool } from './automation.js';
/**
 * Exported because the agent loop formats attachment sizes with it, and the
 * model reads both these strings and `list_dir`'s in the same context window —
 * two spellings of "4.2 KB" is a difference it would be entitled to read
 * meaning into.
 */
export { formatBytes } from './shared.js';
export { editFileTool } from './edit-file.js';
export { execTool } from './exec.js';
export { listDirTool } from './list-dir.js';
export { memoryTool } from './memory.js';
export { readFileTool } from './read-file.js';
export { skillTool } from './skill.js';
export { writeFileTool } from './write-file.js';

/** Every built-in, including `exec` and `automation`. */
export const BUILTIN_TOOLS: readonly AnyTool[] = Object.freeze([
  readFileTool,
  writeFileTool,
  editFileTool,
  listDirTool,
  execTool,
  automationTool,
  memoryTool,
  skillTool,
]);

/** Which of the conditionally-registered built-ins this install wants. */
export interface BuiltinOptions {
  /** `false` drops `automation`. Defaults to keeping it. */
  readonly scheduler?: boolean;
}

/** The built-ins that config can switch off, and the switches that do it. */
export function builtinTools(
  config?: ToolsConfig,
  options: BuiltinOptions = {},
): readonly AnyTool[] {
  const dropped = new Set<AnyTool>();
  if (config?.exec.enable === false) dropped.add(execTool);
  if (options.scheduler === false) dropped.add(automationTool);
  return dropped.size === 0
    ? BUILTIN_TOOLS
    : BUILTIN_TOOLS.filter((tool) => !dropped.has(tool));
}

/** Registers the built-ins under the `builtin` source. */
export function registerBuiltins(
  registry: ToolRegistry,
  config?: ToolsConfig,
  options: BuiltinOptions = {},
): void {
  registry.registerAll(builtinTools(config, options), 'builtin');
}
