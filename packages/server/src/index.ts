/**
 * @ghostai/server — the HTTP surface.
 *
 * One Fastify instance on one port, serving the REST API, the WebSocket and the
 * built UI. It depends on `protocol`, `core` and `security`, and on nothing
 * above them: the agent loop must never be able to reach back into the
 * transport, so the dependency only points one way and the event stream is the
 * only path out.
 *
 * Two invariants this package exists to hold:
 *
 *  - **No route is served except from `ROUTE_MANIFEST`.** The router registers
 *    from it and the auth matrix test iterates it, so "is this route
 *    authenticated" is answered by a table rather than by remembering.
 *  - **A configuration that would expose an unauthenticated, shell-capable
 *    agent does not start.** `assertBootPolicy` is a refusal, not a warning.
 */

export {
  MAX_PARAM_LENGTH,
  SERVER_VERSION,
  createServer,
  type GhostServer,
  type ListenOptions,
  type ServerOptions,
  type UiOptions,
} from './app.js';

export type {
  AgentSummary,
  AgentView,
  ExtensionCounts,
  ServerRuntime,
} from './runtime.js';

export {
  NotificationStore,
  type CreateNotificationInput,
  type ListNotificationsOptions,
  type NotificationStoreOptions,
} from './notifications.js';

export {
  MAX_AGENT_JOBS,
  createAutomationResolver,
  type AutomationPortOptions,
} from './automation-port.js';

export {
  AutomationStore,
  type AutomationStoreOptions,
  type CreateJobInput,
  type FinishRunInput,
  type ListRunsOptions,
  type StartRunInput,
  type TrimmedRun,
  type UpdateJobInput,
} from './automation-store.js';

export {
  BUSY_RETRY_MS,
  DEFAULT_RUN_TIMEOUT_MS,
  INTERRUPTED_BY_RESTART,
  MAX_ARM_MS,
  Scheduler,
  firstRunAt,
  nextRunAfter,
  type NotificationBroadcast,
  type SchedulerChat,
  type SchedulerConnectOptions,
  type SchedulerConnection,
  type SchedulerOptions,
  type SchedulerPort,
  type SchedulerReadFile,
} from './scheduler.js';

export {
  HEARTBEAT_RESULT_TOOL,
  HEARTBEAT_TOOL,
  MAX_TASK_FILE_BYTES,
  type HeartbeatDecision,
  type HeartbeatEvaluation,
} from './heartbeat.js';

export {
  MEDIA_SECRET_NAME,
  assertSigningKey,
  mediaUrl,
  signMediaToken,
  verifyMediaToken,
  type MediaClaim,
} from './signing.js';

export {
  decodeAutomationRunCursor,
  decodeMessageCursor,
  decodeNotificationCursor,
  decodeSessionCursor,
  encodeAutomationRunCursor,
  encodeMessageCursor,
  encodeNotificationCursor,
  encodeSessionCursor,
  type AutomationRunCursor,
  type MessageCursor,
  type NotificationCursor,
  type SessionListCursor,
} from './cursor.js';

export { buildContextResponse, type ContextRuntime } from './context.js';

export {
  DEFAULT_MIME_TYPE,
  inlineSafe,
  listDirectory,
  mimeTypeFor,
} from './workspace.js';

export {
  HubApprovalGate,
  type HubApprovalGateOptions,
  type UnattendedApproval,
} from './approvals.js';

export { agentForTurn } from './agent-binding.js';

export {
  DEFAULT_MAX_QUEUE_DEPTH,
  DEFAULT_MAX_SESSIONS,
  RESUME_MESSAGE_LIMIT,
  SessionHub,
  type ConnectOptions,
  type HubClient,
  type SessionHubOptions,
  type TurnRunner,
} from './hub.js';

export {
  ReplayBuffer,
  type ReplaySlice,
  type SequencedServerMessage,
} from './replay.js';

export {
  AuthStore,
  SECRET_BYTES,
  TOKEN_ID_BYTES,
  TOKEN_SECRET_BYTES,
  argon2Hasher,
  type AuthSession,
  type AuthStoreOptions,
  type IssuedToken,
  type PasswordHasher,
} from './auth-store.js';

export {
  SESSION_COOKIE,
  clearSessionCookie,
  cookieSecure,
  createAuthHook,
  createSignedHook,
  mediaClaimOf,
  readCredential,
  sessionOf,
  setSessionCookie,
  type AuthHookOptions,
  type SignedHookOptions,
} from './auth.js';

export { assertBootPolicy, type BootPolicyInput } from './boot.js';

export {
  ACCOUNT_SCOPE,
  BASE_DELAY_MS,
  DECAY_MS,
  FREE_ATTEMPTS,
  LoginThrottle,
  MAX_ACCOUNT_DELAY_MS,
  MAX_ADDRESS_DELAY_MS,
  MAX_TRACKED_ADDRESSES,
  delayFor,
  type LoginThrottleOptions,
  type ThrottleBlock,
} from './login-throttle.js';

export {
  HttpError,
  badRequest,
  errorBody,
  notFound,
  registerErrorHandler,
  resolveError,
  unauthorized,
  unprocessable,
  type ErrorHandlerOptions,
  type ResolvedError,
} from './errors.js';

export {
  ROUTE_MANIFEST,
  type RouteAuth,
  type RouteId,
  type RouteMethod,
  type RouteSpec,
} from './manifest.js';

export {
  LOGIN_ATTEMPTS_PER_MINUTE,
  MAX_BUFFERED_BYTES,
  MAX_UPLOAD_BYTES,
  createRoutes,
  type RouteDefinition,
  type RouteDeps,
  type RouteGroup,
  type RouteRateLimit,
} from './routes.js';

export {
  PROTOCOL_COMPONENTS,
  componentRef,
  jsonSchemaTransform,
  jsonSerializerCompiler,
  zodValidatorCompiler,
} from './schema.js';
