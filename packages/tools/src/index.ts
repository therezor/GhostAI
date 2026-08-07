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
 *    definitions for the prompt, exact teardown by source for extension unload, and
 *    an `execute` that validates, bounds and reports without ever throwing.
 *  - The five built-ins — `read_file`, `write_file`, `edit_file`, `list_dir`,
 *    `exec` — every one of which routes its filesystem access through the
 *    workspace jail and, for `exec`, an argv guard rather than a shell.
 *
 * `toolConformance` is deliberately absent from this entry point. It imports
 * `vitest`, and nothing that ships may pull a test framework into its runtime
 * graph. It lives in `test/testkit/` — outside `src` entirely, so there is no
 * export that could reach it by accident — and this package's own tests reach
 * it as `#testkit/conformance.js`.
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
  type ToolResult,
} from './define.js';

export type {
  AutomationOutcome,
  AutomationPort,
  AutomationRefusal,
  AutomationResolver,
} from './automation.js';

export {
  ToolRegistry,
  withToolboxTools,
  type ToolExecution,
  type ToolScope,
} from './registry.js';

export { isEnabled, permissionFor } from './scope.js';

export type { ToolSink } from './sink.js';

export {
  isAdvertisableName,
  namespacedToolName,
  namespacedToolNames,
} from './names.js';

export {
  localRunner,
  type CommandRunner,
  type RunnerResolver,
  type ToolboxRequest,
  type RunOutcome,
  type RunRequest,
} from './runner.js';

export {
  TOOLBOX_MOUNT_DIR,
  RUNS_MOUNT_DIR,
  containerCreateArgv,
  containerExecArgv,
  containerIsGone,
  containerKillArgv,
  containerRunDir,
  containerRunner,
  openTranscript,
  type Transcript,
} from './container-runner.js';

export { coerceArgv } from './argv.js';
export {
  toolboxPermissions,
  toolboxTool,
  toolboxTools,
} from './toolbox-tools.js';

export {
  BUILTIN_TOOLS,
  builtinTools,
  editFileTool,
  execTool,
  formatBytes,
  listDirTool,
  readFileTool,
  registerBuiltins,
  writeFileTool,
} from './builtin/index.js';
