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
  /** Resolved, not configured — reflects what a turn would actually use now. */
  model: z.string(),
  provider: z.string(),
  workspace: z.string(),
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
  /** Provider id → whether a usable key or OAuth token exists in the vault. */
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
 * A provider as advertised to the settings UI, projected from the `PROVIDERS`
 * table in `@ghostai/providers`.
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
  credentialsPresent: z.boolean(),
});
export type ProviderInfo = z.infer<typeof ProviderInfoSchema>;

export const ProvidersResponseSchema = z.object({
  providers: z.array(ProviderInfoSchema),
});
export type ProvidersResponse = z.infer<typeof ProvidersResponseSchema>;

export const ModelInfoSchema = z.object({
  id: z.string().min(1),
  providerId: z.string().min(1),
  displayName: z.string().optional(),
  contextWindowTokens: z.number().int().positive().optional(),
  supportsTools: z.boolean().optional(),
  supportsVision: z.boolean().optional(),
  supportsReasoning: z.boolean().optional(),
});
export type ModelInfo = z.infer<typeof ModelInfoSchema>;

export const ModelsResponseSchema = z.object({
  models: z.array(ModelInfoSchema),
  /** Providers whose model list could not be fetched, id → reason. */
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

export const UploadResponseSchema = z.object({
  path: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  mimeType: z.string(),
  signedUrl: SignedUrlSchema.optional(),
});
export type UploadResponse = z.infer<typeof UploadResponseSchema>;

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
