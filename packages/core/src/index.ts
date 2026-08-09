/**
 * @ghostwire/core — the shared spine.
 *
 * Everything above `protocol` and below `security` depends on this package, so
 * what it may do is deliberately narrow: **no network and no `child_process`**.
 * Those belong to `@ghostwire/security`, which wraps them in the SSRF guard and
 * the argv exec guard respectively, and a direct `fetch` or `execFile` here
 * would be a way around both.
 *
 * Filesystem access is allowed, because the session database has to live
 * somewhere — but only for paths GhostAI owns. Nothing here resolves an
 * agent-supplied path; that is `WorkspaceJail`'s job, and its alone.
 */

export {
  ERROR_KINDS,
  GhostError,
  abortedError,
  errnoOf,
  isAbortError,
  onAbort,
  isGhostError,
  toGhostError,
  type AbortSubscription,
  type ErrorKind,
} from './errors.js';

export { systemClock, type Clock, type TimerHandle } from './clock.js';

export { parseCron, nextCronRun, type CronSpec } from './cron.js';

export {
  HOME_ENV_VAR,
  ensureDir,
  expandHome,
  resolveGhostPaths,
  resolvePath,
  agentDirFor,
  extensionDataDirFor,
  extensionDirFor,
  sharedDirFor,
  workspaceDirFor,
  type GhostPaths,
  type ResolveGhostPathsOptions,
} from './paths.js';

export {
  DEFAULT_WORKSPACE_ID,
  RESERVED_WORKSPACE_IDS,
  WORKSPACE_ID_PATTERN,
  deriveWorkspaceId,
  isWorkspaceId,
} from './workspace-id.js';

export {
  AGENT_ID_PATTERN,
  DEFAULT_AGENT_ID,
  RESERVED_AGENT_IDS,
  deriveAgentId,
  isAgentId,
} from './agent-id.js';

export { EXTENSION_ID_PATTERN, isExtensionId } from './extension-id.js';

export {
  MAX_SLUG_ID_LENGTH,
  RESERVED_DEVICE_NAMES,
  SLUG_ID_PATTERN,
  isSlugId,
  slugify,
} from './slug-id.js';

export { parseMetadata, rowReader, type Row } from './sqlite-row.js';

export { WorkspaceStore, type WorkspaceRecord } from './workspace-store.js';

export {
  DEFAULT_MIME_TYPE,
  MAX_TEXT_BYTES,
  mimeTypeFor,
  readText,
  type WorkspaceText,
} from './workspace-files.js';

export {
  loadConfig,
  parseConfig,
  saveConfig,
  type LoadedConfig,
} from './config.js';

export {
  REDACT_CENSOR,
  createLogger,
  silentLogger,
  type LogLevel,
  type Logger,
} from './logger.js';

export {
  assistantMessage,
  filePart,
  hasImages,
  imagePart,
  systemMessage,
  textOf,
  textPart,
  toolMessage,
  userMessage,
  withoutImages,
} from './messages.js';

export {
  DEFAULT_MAX_TOOL_RESULT_CHARS,
  findLegalEnd,
  findLegalStart,
  hasOrphanedToolResult,
  hasUnansweredToolCall,
  historyForLLM,
  truncateHeadTail,
  type HistoryForLLMOptions,
  sessionHistory,
} from './history.js';

export { parseFrontmatter } from './frontmatter.js';

export {
  MAX_MEMORIES,
  MAX_MEMORY_DESCRIPTION_CHARS,
  MAX_MEMORY_NAME_CHARS,
  MEMORY_DIRNAME,
  MEMORY_MAX_BYTES,
  MEMORY_TYPES,
  memorySlug,
  readMemories,
  renderIndex,
  renderMemory,
  saveMemory,
  type Memory,
  type MemoryInput,
} from './memory.js';

export { MAX_TITLE_CHARS, deriveSessionTitle } from './session-title.js';

export {
  SessionStore,
  toStoredMessage,
  type ChatMessageInput,
  type ListSessionsOptions,
  type SessionRecord,
  type SessionSummaryRecord,
  type StoredMessageRecord,
  type TurnStatsRecord,
} from './session-store.js';

export {
  MessageBus,
  RateLimiter,
  type InboundMessage,
  type InboundMessageInput,
  type MessageBusOptions,
  type OutboundKind,
  type OutboundMessage,
  type PublishResult,
} from './message-bus.js';
