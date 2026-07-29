/**
 * @ghostai/tools — how the agent acts on the world.
 *
 * Everything a model can *do* enters through this package: a tool is defined
 * here, registered here, and called here, and there is no second path. That is
 * what makes the security boundary reviewable — `@ghostai/security` decides
 * whether a path, a binary or a host is acceptable, and this package is the only
 * caller that asks.
 *
 * The three pieces:
 *
 *  - `defineTool` collapses a tool's schema, its advertised JSON Schema, its
 *    argument validation and its handler's parameter type into one declaration.
 *  - `ToolRegistry` is the source-tagged, per-agent collection: memoised
 *    definitions for the prompt, exact teardown by source for plugin unload, and
 *    an `execute` that validates, bounds and reports without ever throwing.
 *  - The five built-ins — `read_file`, `write_file`, `edit_file`, `list_dir`,
 *    `exec` — every one of which routes its filesystem access through the
 *    workspace jail and, for `exec`, an argv guard rather than a shell.
 *
 * `toolConformance` is deliberately absent from this entry point. It lives in
 * `src/testkit/` and is imported relatively by tests, so `vitest` never becomes
 * a runtime dependency of anything that ships.
 */

export {
  DEFAULT_TOOLS_CONFIG,
  TOOL_NAME_PATTERN,
  assertNotAborted,
  defineTool,
  toToolResult,
  type AnyTool,
  type ArgIssue,
  type ParseArgsResult,
  type Tool,
  type ToolContext,
  type ToolOutput,
  type ToolResult,
  type ToolSpec,
} from './define.js';

export {
  ToolRegistry,
  type ToolExecution,
  type ToolInvocation,
  type ToolRegistryOptions,
  type ToolScope,
} from './registry.js';

export { isUnrestricted, selectionAllows, type ToolSelection } from './scope.js';

export {
  KILL_GRACE_MS,
  localRunner,
  type CommandRunner,
  type RunOutcome,
  type RunRequest,
} from './runner.js';

export {
  BUILTIN_TOOLS,
  builtinTools,
  editFileTool,
  execTool,
  listDirTool,
  readFileTool,
  registerBuiltins,
  writeFileTool,
} from './builtin/index.js';
