/**
 * @ghostwire/server — the HTTP surface.
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
  SERVER_VERSION,
  createServer,
  type GhostServer,
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
} from './notifications.js';

export { MAX_AGENT_JOBS, createAutomationResolver } from './automation-port.js';

export { AutomationStore, type CreateJobInput } from './automation-store.js';

export {
  MAX_ARM_MS,
  Scheduler,
  firstRunAt,
  nextRunAfter,
  type NotificationBroadcast,
  type SchedulerConnectOptions,
  type SchedulerOptions,
  type SchedulerPort,
} from './scheduler.js';

export {
  HEARTBEAT_RESULT_TOOL,
  HEARTBEAT_TOOL,
  MAX_TASK_FILE_BYTES,
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
  type NotificationCursor,
} from './cursor.js';

export { buildContextResponse } from './context.js';

export {
  DEFAULT_MIME_TYPE,
  inlineSafe,
  listDirectory,
  mimeTypeFor,
} from './workspace.js';

export { HubApprovalGate, type UnattendedApproval } from './approvals.js';

export { agentForTurn } from './agent-binding.js';

export {
  SessionHub,
  type ConnectOptions,
  type HubClient,
  type TurnRunner,
} from './hub.js';

export { ReplayBuffer, type SequencedServerMessage } from './replay.js';

export {
  AuthStore,
  argon2Hasher,
  type AuthSession,
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
} from './auth.js';

export { assertBootPolicy } from './boot.js';

export {
  ACCOUNT_SCOPE,
  DECAY_MS,
  FREE_ATTEMPTS,
  LoginThrottle,
  MAX_ACCOUNT_DELAY_MS,
  MAX_ADDRESS_DELAY_MS,
  delayFor,
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
} from './errors.js';

export { ROUTE_MANIFEST, type RouteId, type RouteSpec } from './manifest.js';

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
