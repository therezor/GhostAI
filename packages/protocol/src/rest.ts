/**
 * REST DTOs.
 *
 * These are the objects `@fastify/swagger` turns into the OpenAPI 3.1 document.
 * The API reference is generated from them and never hand-maintained, so it
 * cannot drift from the routes it documents.
 *
 * Cursor pagination throughout, not offset: sessions and messages are
 * append-only, so an offset shifts under a reader whenever a turn lands.
 */

import { z } from 'zod';

import { ConfigSchema } from './config.js';
import { StoredMessageSchema, UsageSchema } from './messages.js';
import { ToolDefinitionSchema } from './tools.js';
import { AutomationJobSchema, AutomationRunSchema } from './automation.js';

// ---------------------------------------------------------------------------
// Envelopes
// ---------------------------------------------------------------------------

/**
 * The single error shape for every non-2xx response, so a client has one branch
 * to write. Mirrors the WS `error` event's code vocabulary.
 */
export const ErrorResponseSchema = z.object({
  error: z.object({
    code: z.string().min(1),
    message: z.string(),
    /** Field-level detail for a 422, keyed by JSON pointer. */
    details: z.record(z.string(), z.unknown()).optional(),
  }),
});
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;

export const PaginationQuerySchema = z.object({
  limit: z.number().int().positive().max(200).default(50),
  /** Opaque; echo back `nextCursor` verbatim. */
  cursor: z.string().optional(),
});
export type PaginationQuery = z.infer<typeof PaginationQuerySchema>;

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export const StatusResponseSchema = z.object({
  version: z.string(),
  protocolVersion: z.number().int().positive(),
  uptimeMs: z.number().int().nonnegative(),
  /**
   * Resolved, not configured — reflects what a turn would actually use now.
   * Both are empty when nothing is configured yet; `configured` is the flag to
   * branch on, so a client never has to read meaning into an empty string.
   */
  model: z.string(),
  provider: z.string(),
  /**
   * Whether a turn can run at all.
   *
   * `false` on a fresh install: the server, the files, the settings and the
   * socket are all up, and only chat is unavailable until a provider and a
   * model exist.
   */
  configured: z.boolean(),
  /**
   * The default workspace's id, never its path.
   *
   * `workspace` used to carry `jail.root` — an absolute host path, so every
   * authenticated client learned the operator's username and directory layout,
   * which is the one string that turns a blind traversal attempt into a
   * targeted one. Absolute paths do not cross this boundary in either
   * direction.
   */
  workspaceId: z.string().min(1),
  workspaceCount: z.number().int().positive(),
  authEnabled: z.boolean(),
  toolCount: z.number().int().nonnegative(),
  mcpServersConnected: z.number().int().nonnegative(),
  pluginsLoaded: z.number().int().nonnegative(),
});
export type StatusResponse = z.infer<typeof StatusResponseSchema>;

/** `ghost doctor` output. Defined early so the shape is stable before the CLI depends on it. */
export const HealthCheckSchema = z.object({
  name: z.string().min(1),
  status: z.enum(['ok', 'warn', 'fail', 'skipped']),
  detail: z.string().default(''),
});
export type HealthCheck = z.infer<typeof HealthCheckSchema>;

export const HealthResponseSchema = z.object({
  status: z.enum(['ok', 'degraded', 'fail']),
  checks: z.array(HealthCheckSchema),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/**
 * Config as served to the UI. Credentials never appear — the vault is
 * write-only over HTTP — so the panel gets a per-provider boolean instead.
 */
export const SettingsResponseSchema = z.object({
  config: ConfigSchema,
  /** Provider *instance* id → whether a usable key exists in the vault. */
  credentialsPresent: z.record(z.string(), z.boolean()),
  /** Set when the file on disk failed to parse and defaults are in use. */
  loadError: z.string().optional(),
});
export type SettingsResponse = z.infer<typeof SettingsResponseSchema>;

/** Write-only credential update. */
export const SetCredentialRequestSchema = z.object({
  namespace: z.enum(['providers', 'tools', 'rag', 'audio', 'mcp_servers', 'plugins']),
  key: z.string().min(1),
  /** `null` deletes the entry. */
  value: z.string().nullable(),
});
export type SetCredentialRequest = z.infer<typeof SetCredentialRequestSchema>;

// ---------------------------------------------------------------------------
// Providers and models
// ---------------------------------------------------------------------------

/**
 * A provider *type*, projected from the `PROVIDERS` table in
 * `@ghostai/providers`. The catalogue an operator adds an endpoint from.
 *
 * It carries no credential flag. A credential belongs to a configured
 * instance — two Ollama entries can have different tokens — so the boolean
 * lives on `ProviderInstanceInfo` and nowhere else.
 */
export const ProviderInfoSchema = z.object({
  id: z.string().min(1),
  displayName: z.string(),
  /** Which wire adapter drives it. */
  wire: z.string(),
  isLocal: z.boolean(),
  isGateway: z.boolean(),
  isOAuth: z.boolean(),
  defaultApiBase: z.string().optional(),
  envKey: z.string().optional(),
  /** The endpoint can be asked for its own model list. */
  supportsModelListing: z.boolean(),
});
export type ProviderInfo = z.infer<typeof ProviderInfoSchema>;

/**
 * One configured endpoint.
 *
 * `type` names the `ProviderInfo` it was created from; `id` is the operator's
 * key for this particular endpoint, and is what `agents.defaults.provider`
 * names and what the vault stores its credential under.
 */
export const ProviderInstanceInfoSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  /** Resolved for display: the instance's label, or the type's name. */
  displayName: z.string(),
  /** Effective, not configured — the default is folded in. */
  apiBase: z.string(),
  isLocal: z.boolean(),
  isGateway: z.boolean(),
  isOAuth: z.boolean(),
  envKey: z.string().optional(),
  enabled: z.boolean(),
  supportsModelListing: z.boolean(),
  credentialsPresent: z.boolean(),
});
export type ProviderInstanceInfo = z.infer<typeof ProviderInstanceInfoSchema>;

/**
 * Both lists, because the panel needs both: `types` is what an "Add provider"
 * control offers, `instances` is what the list below it renders.
 */
export const ProvidersResponseSchema = z.object({
  types: z.array(ProviderInfoSchema),
  instances: z.array(ProviderInstanceInfoSchema),
});
export type ProvidersResponse = z.infer<typeof ProvidersResponseSchema>;

export const ModelInfoSchema = z.object({
  id: z.string().min(1),
  /** The provider *instance* this model was offered by. */
  providerId: z.string().min(1),
  /** The instance's type, for grouping and labelling. Absent on a bare list. */
  providerType: z.string().optional(),
  displayName: z.string().optional(),
  contextWindowTokens: z.number().int().positive().optional(),
  supportsTools: z.boolean().optional(),
  supportsVision: z.boolean().optional(),
  supportsReasoning: z.boolean().optional(),
});
export type ModelInfo = z.infer<typeof ModelInfoSchema>;

export const ModelsResponseSchema = z.object({
  models: z.array(ModelInfoSchema),
  /** Instances whose model list could not be fetched, id → reason. */
  errors: z.record(z.string(), z.string()).default({}),
});
export type ModelsResponse = z.infer<typeof ModelsResponseSchema>;

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export const SessionSummarySchema = z.object({
  key: z.string().min(1),
  title: z.string(),
  messageCount: z.number().int().nonnegative(),
  createdAtMs: z.number().int().nonnegative(),
  updatedAtMs: z.number().int().nonnegative(),
  /** Channel that owns it — `web`, `telegram`, `automation`, a plugin id. */
  origin: z.string().default('web'),
  /** Fixed when the session was created; see `SessionRecord.workspaceId`. */
  workspaceId: z.string().min(1).default('default'),
  profileId: z.string().optional(),
  totalUsage: UsageSchema.optional(),
});
export type SessionSummary = z.infer<typeof SessionSummarySchema>;

export const SessionListResponseSchema = z.object({
  sessions: z.array(SessionSummarySchema),
  nextCursor: z.string().optional(),
});
export type SessionListResponse = z.infer<typeof SessionListResponseSchema>;

export const SessionMessagesResponseSchema = z.object({
  sessionKey: z.string().min(1),
  messages: z.array(StoredMessageSchema),
  nextCursor: z.string().optional(),
});
export type SessionMessagesResponse = z.infer<typeof SessionMessagesResponseSchema>;

export const CreateSessionRequestSchema = z.object({
  key: z.string().min(1).optional(),
  title: z.string().optional(),
  /** Which workspace to open the conversation in. Defaults to `default`. */
  workspaceId: z.string().min(1).optional(),
  profileId: z.string().optional(),
});
export type CreateSessionRequest = z.infer<typeof CreateSessionRequestSchema>;

export const UpdateSessionRequestSchema = z.object({
  title: z.string().min(1).optional(),
  profileId: z.string().optional(),
});
export type UpdateSessionRequest = z.infer<typeof UpdateSessionRequestSchema>;

/**
 * What the agent would actually send to the model, for the context inspector.
 * The panel that makes the token budget legible rather than a mystery.
 */
export const ContextResponseSchema = z.object({
  sessionKey: z.string().min(1),
  systemPrompt: z.string(),
  messages: z.array(StoredMessageSchema),
  estimatedTokens: z.number().int().nonnegative(),
  contextWindowTokens: z.number().int().positive(),
  /** Section name → token cost, so an oversized block is visible. */
  breakdown: z.record(z.string(), z.number()).default({}),
});
export type ContextResponse = z.infer<typeof ContextResponseSchema>;

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export const ToolListResponseSchema = z.object({
  tools: z.array(ToolDefinitionSchema),
});
export type ToolListResponse = z.infer<typeof ToolListResponseSchema>;

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

export const FileEntrySchema = z.object({
  /** Workspace-relative, always. Absolute paths never cross this boundary. */
  path: z.string().min(1),
  name: z.string().min(1),
  isDirectory: z.boolean(),
  sizeBytes: z.number().int().nonnegative(),
  modifiedAtMs: z.number().int().nonnegative(),
  mimeType: z.string().optional(),
});
export type FileEntry = z.infer<typeof FileEntrySchema>;

export const FileListResponseSchema = z.object({
  path: z.string(),
  entries: z.array(FileEntrySchema),
});
export type FileListResponse = z.infer<typeof FileListResponseSchema>;

/**
 * An HMAC-signed, expiring URL.
 *
 * `<img src>` cannot carry an Authorization header. The tempting fix is to make
 * the file endpoint public, which turns it into anonymous read access to
 * everything under the workspace. A short-lived signature satisfies the browser
 * instead, and the endpoint stays authenticated.
 */
export const SignedUrlSchema = z.object({
  url: z.string().min(1),
  expiresAtMs: z.number().int().nonnegative(),
});
export type SignedUrl = z.infer<typeof SignedUrlSchema>;

/**
 * Asking for one.
 *
 * A body rather than a query parameter, and the reason is the audit log: a
 * workspace path in a URL is written to every access log between the browser
 * and the server, and the whole point of the signature is that the *URL* is the
 * thing that travels.
 */
export const SignedUrlRequestSchema = z.object({
  /** Workspace-relative, like every other path that crosses this boundary. */
  path: z.string().min(1),
  /** Which workspace the path is relative to. Defaults to `default`. */
  workspaceId: z.string().min(1).optional(),
});
export type SignedUrlRequest = z.infer<typeof SignedUrlRequestSchema>;

export const UploadResponseSchema = z.object({
  path: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  mimeType: z.string(),
  signedUrl: SignedUrlSchema.optional(),
});
export type UploadResponse = z.infer<typeof UploadResponseSchema>;

/**
 * One text file, as an editor needs it.
 *
 * Distinct from the signed media URL, and not a duplicate of it. A signature
 * exists so a browser *element* — an `<img>` that cannot send a header — can
 * fetch bytes, and `/api/media/:token` therefore answers with the rules a
 * browser needs: `nosniff`, and `attachment` for anything it might execute. An
 * editor needs none of that. It needs the characters in a JSON string, which
 * render in a `<textarea>` and execute nowhere, and it needs `modifiedAtMs` —
 * which a media response does not carry and which is what makes a save
 * conflict detectable.
 */
export const FileTextResponseSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
  /** The file's size on disk. Larger than `content` when `truncated`. */
  sizeBytes: z.number().int().nonnegative(),
  modifiedAtMs: z.number().int().nonnegative(),
  /**
   * The file was longer than the read limit and `content` is a prefix.
   *
   * An editor that saved a prefix would delete the rest of the file, so this is
   * the flag that makes the panel read-only rather than a detail for a footer.
   */
  truncated: z.boolean(),
});
export type FileTextResponse = z.infer<typeof FileTextResponseSchema>;

/**
 * Saving one.
 *
 * `expectedModifiedAtMs` is the reason this is not just a `PUT` of the body.
 * The workspace is a tree a language model writes to while a person is looking
 * at it, so "the agent rewrote the file under the open editor" is an ordinary
 * Tuesday rather than a race worth ignoring. Sending back the timestamp the
 * editor loaded turns that into a 409 the panel can explain, instead of a
 * silent overwrite of a turn's work.
 *
 * Absent means "write it regardless" — which is what creating a new file is.
 *
 * A modification time, not a hash, and it carries that mechanism's one
 * weakness: two writes inside the filesystem's timestamp resolution are
 * indistinguishable. This is the same trade `If-Unmodified-Since` has made for
 * thirty years, and it holds for the case that actually happens — a person
 * editing for seconds while a turn runs — rather than for two writes in the
 * same millisecond.
 */
export const FileWriteRequestSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
  /** Which workspace the path is relative to. Defaults to `default`. */
  workspaceId: z.string().min(1).optional(),
  expectedModifiedAtMs: z.number().int().nonnegative().optional(),
});
export type FileWriteRequest = z.infer<typeof FileWriteRequestSchema>;

export const CreateDirectoryRequestSchema = z.object({
  /** Workspace-relative, like every other path that crosses this boundary. */
  path: z.string().min(1),
  /** Which workspace the path is relative to. Defaults to `default`. */
  workspaceId: z.string().min(1).optional(),
});
export type CreateDirectoryRequest = z.infer<typeof CreateDirectoryRequestSchema>;

// ---------------------------------------------------------------------------
// Workspaces
// ---------------------------------------------------------------------------

/**
 * A workspace as the switcher and the manager see it.
 *
 * **No path field, anywhere in this section.** A workspace is
 * `<root>/workspace/<id>` and the id is the only thing that crosses the wire;
 * accepting a directory would turn "managed directories only" from a fact into
 * a convention, and the first client to send `/` would have handed an
 * authenticated caller the whole filesystem.
 */
export const WorkspaceSummarySchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  /** True for exactly one, which cannot be deleted and contains all the others. */
  isDefault: z.boolean(),
  createdAtMs: z.number().int().nonnegative(),
  updatedAtMs: z.number().int().nonnegative(),
  /** What a delete would have to move first. */
  sessionCount: z.number().int().nonnegative(),
});
export type WorkspaceSummary = z.infer<typeof WorkspaceSummarySchema>;

export const WorkspaceListResponseSchema = z.object({
  workspaces: z.array(WorkspaceSummarySchema),
});
export type WorkspaceListResponse = z.infer<typeof WorkspaceListResponseSchema>;

export const CreateWorkspaceRequestSchema = z.object({
  name: z.string().min(1).max(60),
  /** Derived from the name when absent. Lowercase; also the folder name. */
  id: z.string().min(1).max(40).optional(),
});
export type CreateWorkspaceRequest = z.infer<typeof CreateWorkspaceRequestSchema>;

export const UpdateWorkspaceRequestSchema = z.object({
  name: z.string().min(1).max(60),
});
export type UpdateWorkspaceRequest = z.infer<typeof UpdateWorkspaceRequestSchema>;

/** The way through a delete that was refused for having sessions. */
export const MoveSessionsRequestSchema = z.object({
  to: z.string().min(1),
});
export type MoveSessionsRequest = z.infer<typeof MoveSessionsRequestSchema>;

export const MoveSessionsResponseSchema = z.object({
  moved: z.number().int().nonnegative(),
});
export type MoveSessionsResponse = z.infer<typeof MoveSessionsResponseSchema>;

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

export const NotificationSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  body: z.string(),
  level: z.enum(['info', 'success', 'warning', 'error']).default('info'),
  createdAtMs: z.number().int().nonnegative(),
  readAtMs: z.number().int().nonnegative().optional(),
  sessionKey: z.string().optional(),
  jobId: z.string().optional(),
});
export type Notification = z.infer<typeof NotificationSchema>;

export const NotificationListResponseSchema = z.object({
  notifications: z.array(NotificationSchema),
  unreadCount: z.number().int().nonnegative(),
  nextCursor: z.string().optional(),
});
export type NotificationListResponse = z.infer<typeof NotificationListResponseSchema>;

// ---------------------------------------------------------------------------
// Automation
// ---------------------------------------------------------------------------

export const AutomationJobListResponseSchema = z.object({
  jobs: z.array(AutomationJobSchema),
});
export type AutomationJobListResponse = z.infer<typeof AutomationJobListResponseSchema>;

export const AutomationRunListResponseSchema = z.object({
  runs: z.array(AutomationRunSchema),
  nextCursor: z.string().optional(),
});
export type AutomationRunListResponse = z.infer<typeof AutomationRunListResponseSchema>;

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export const LoginRequestSchema = z.object({
  password: z.string().min(1),
});
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

/**
 * No token in the body. Browsers get an `httpOnly; Secure; SameSite=Strict`
 * cookie set by the response: a token readable from JavaScript is
 * XSS-exfiltratable, and this app's whole job is rendering model-authored
 * markdown. CLI and CI use a `Bearer` token minted out of band.
 */
export const LoginResponseSchema = z.object({
  ok: z.literal(true),
  expiresAtMs: z.number().int().nonnegative(),
});
export type LoginResponse = z.infer<typeof LoginResponseSchema>;

/**
 * Who the caller is, as far as the server is concerned.
 *
 * `authEnabled` is here so the UI has one request to make before deciding
 * whether to render the login overlay. With auth off every caller is
 * authenticated and there is no session behind it, which is why `expiresAtMs`
 * is optional rather than a sentinel.
 */
export const AuthSessionResponseSchema = z.object({
  authenticated: z.boolean(),
  authEnabled: z.boolean(),
  expiresAtMs: z.number().int().nonnegative().optional(),
});
export type AuthSessionResponse = z.infer<typeof AuthSessionResponseSchema>;

// ---------------------------------------------------------------------------
// First-run setup
// ---------------------------------------------------------------------------

/**
 * Whether this install still has to be claimed.
 *
 * Public, and deliberately says nothing else. An unauthenticated caller learns
 * one bit — that no password has been set — which they would learn anyway by
 * watching every login fail. Anything more (the workspace, the provider list,
 * whether a code is outstanding) would be describing an unclaimed agent to
 * whoever asked first.
 */
export const SetupStatusResponseSchema = z.object({
  required: z.boolean(),
});
export type SetupStatusResponse = z.infer<typeof SetupStatusResponseSchema>;

/**
 * The one-time code printed to the console on first launch.
 *
 * It exists because the alternative was worse in both directions: the server
 * used to refuse to start without a password, so the UI that would set one was
 * unreachable — and a server that simply started unauthenticated would be a
 * shell-capable agent answering to whoever reached the port first. A code that
 * only the operator's own terminal can see closes that gap without either.
 */
export const SetupClaimRequestSchema = z.object({
  code: z.string().min(1),
});
export type SetupClaimRequest = z.infer<typeof SetupClaimRequestSchema>;

export const SetupPasswordRequestSchema = z.object({
  password: z.string().min(1),
});
export type SetupPasswordRequest = z.infer<typeof SetupPasswordRequestSchema>;
