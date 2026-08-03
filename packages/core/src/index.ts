/**
 * @ghostai/core — the shared spine.
 *
 * Everything above `protocol` and below `security` depends on this package, so
 * what it may do is deliberately narrow: **no network and no `child_process`**.
 * Those belong to `@ghostai/security`, which wraps them in the SSRF guard and
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
  isAbortError,
  isGhostError,
  toGhostError,
  type ErrorKind,
  type GhostErrorOptions,
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

export {
  MAX_SLUG_ID_LENGTH,
  RESERVED_DEVICE_NAMES,
  SLUG_ID_PATTERN,
  isSlugId,
  slugify,
} from './slug-id.js';

export {
  WorkspaceStore,
  type CreateWorkspaceOptions,
  type WorkspaceRecord,
  type WorkspaceStoreOptions,
} from './workspace-store.js';

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
  type LoadConfigOptions,
  type LoadedConfig,
} from './config.js';

export {
  REDACT_CENSOR,
  REDACT_PATHS,
  createLogger,
  silentLogger,
  type CreateLoggerOptions,
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
  type AssistantMessageOptions,
  type ToolMessageOptions,
} from './messages.js';

export {
  DEFAULT_MAX_HISTORY_MESSAGES,
  DEFAULT_MAX_TOOL_RESULT_CHARS,
  findLegalEnd,
  findLegalStart,
  hasOrphanedToolResult,
  hasUnansweredToolCall,
  historyForLLM,
  truncateHeadTail,
  type HistoryForLLMOptions,
  type TruncationResult,
} from './history.js';

export { MAX_TITLE_CHARS, deriveSessionTitle } from './session-title.js';

export {
  SessionStore,
  toStoredMessage,
  type AppendOptions,
  type ChatMessageInput,
  type CreateSessionOptions,
  type ListSessionsOptions,
  type ReadMessagesOptions,
  type SessionCursor,
  type SessionRecord,
  type SessionStoreOptions,
  type SessionSummaryRecord,
  type StoredMessageRecord,
  type TruncateResult,
  type TurnStatsRecord,
  type UpdateSessionOptions,
  type ForkResult,
  type ForkSessionOptions,
} from './session-store.js';

export {
  MessageBus,
  OUTBOUND_KINDS,
  RateLimiter,
  type InboundMessage,
  type InboundMessageInput,
  type MessageBusOptions,
  type OutboundKind,
  type OutboundMessage,
  type OutboundMessageInput,
  type PublishResult,
  type RateLimitOptions,
} from './message-bus.js';
