/**
 * The REST client.
 *
 * One `request` function, one error type, and a Zod parse on the way out. The
 * parse is not ceremony: `@ghostai/protocol` is the same module the server
 * builds its responses from, so a field the server stopped sending is a failing
 * request here rather than `undefined` reaching a component three renders
 * later. It costs one schema lookup per response and it is the only reason the
 * types below can be trusted.
 *
 * Two things are deliberate:
 *
 *  - **`credentials: 'same-origin'` and no CSRF header.** The session cookie is
 *    `SameSite=Strict`, which is what stands in for a token — see
 *    `packages/server/src/auth.ts`. A header would be a second mechanism
 *    protecting nothing.
 *  - **401 is a value, not a crash.** It is the normal state of a browser that
 *    has not logged in yet, and `ApiError.status` is what the login overlay
 *    reads to decide whether to show itself.
 */

import {
  AuthSessionResponseSchema,
  ContextResponseSchema,
  ErrorResponseSchema,
  FileEntrySchema,
  FileListResponseSchema,
  FileTextResponseSchema,
  LoginResponseSchema,
  ModelsResponseSchema,
  NotificationListResponseSchema,
  NotificationSchema,
  ProvidersResponseSchema,
  SessionListResponseSchema,
  SessionMessagesResponseSchema,
  SettingsResponseSchema,
  MoveSessionsResponseSchema,
  SignedUrlSchema,
  WorkspaceListResponseSchema,
  WorkspaceSummarySchema,
  StatusResponseSchema,
  ToolListResponseSchema,
  UploadResponseSchema,
  type AuthSessionResponse,
  type ConfigPatch,
  type ContextResponse,
  type FileEntry,
  type FileListResponse,
  type FileTextResponse,
  type LoginResponse,
  type ModelsResponse,
  type Notification,
  type NotificationListResponse,
  type ProvidersResponse,
  type SessionListResponse,
  type SessionMessagesResponse,
  type SetCredentialRequest,
  type SettingsResponse,
  type MoveSessionsResponse,
  type SignedUrl,
  type WorkspaceListResponse,
  type WorkspaceSummary,
  type StatusResponse,
  type ToolListResponse,
  type UploadResponse,
} from '@ghostai/protocol';
import type { z } from 'zod';

/** A non-2xx response, or a body that did not match its schema. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(status: number, code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  /** The one branch every caller writes: is this "log in again" or "it broke"? */
  get isUnauthenticated(): boolean {
    return this.status === 401;
  }
}

export interface RequestOptions {
  readonly method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  readonly body?: unknown;
  readonly signal?: AbortSignal;
  readonly query?: Readonly<Record<string, string | number | boolean | undefined>>;
}

/**
 * One request, parsed against `schema`.
 *
 * Pass `undefined` for a 204 or a response whose body nothing reads — the
 * result is `undefined` rather than a parse of an empty string.
 */
export async function request<T>(
  path: string,
  schema: z.ZodType<T>,
  options: RequestOptions = {},
): Promise<T> {
  const response = await send(path, options);
  const body: unknown = await readJson(response);

  if (!response.ok) throw toApiError(response.status, body);

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    // A shape mismatch is a server the client cannot trust, so it is an error
    // rather than a cast. The issues go in `details` for the console.
    throw new ApiError(response.status, 'invalid_response', `Unexpected response from ${path}`, {
      issues: parsed.error.issues,
    });
  }

  return parsed.data;
}

/** A request whose response body is not read — a 204, or a fire-and-forget POST. */
export async function requestVoid(path: string, options: RequestOptions = {}): Promise<void> {
  const response = await send(path, options);
  if (response.ok) return;

  throw toApiError(response.status, await readJson(response));
}

/**
 * The endpoints something in this package actually calls.
 *
 * Still not a client for all thirty routes: a wrapper written before its caller
 * is a wrapper written to the wrong shape, and an untested one, since nothing
 * exercises it. Everything here has a caller, and the routes that do not appear
 * — session rename, session delete, the automation surface — are the ones whose
 * panels arrive in a later phase.
 *
 * One rule holds across the whole object and is the reason `setCredential`
 * returns `void`: **no response body ever carries a credential.** The vault is
 * write-only over HTTP, so a key goes in through `PUT /api/settings/credentials`
 * and the only thing that comes back out anywhere is the per-provider boolean
 * in `SettingsResponse.credentialsPresent`. A client method that returned what
 * it stored would be a read path for a store that has none.
 */
export const api = {
  me: (signal?: AbortSignal): Promise<AuthSessionResponse> =>
    request('/api/auth/me', AuthSessionResponseSchema, { ...(signal ? { signal } : {}) }),

  login: (password: string): Promise<LoginResponse> =>
    request('/api/auth/login', LoginResponseSchema, { method: 'POST', body: { password } }),

  status: (signal?: AbortSignal): Promise<StatusResponse> =>
    request('/api/status', StatusResponseSchema, { ...(signal ? { signal } : {}) }),

  /** Every session, or only the ones in one workspace. */
  sessions: (workspaceId?: string, signal?: AbortSignal): Promise<SessionListResponse> =>
    request('/api/sessions', SessionListResponseSchema, {
      ...(workspaceId === undefined ? {} : { query: { workspace: workspaceId } }),
      ...(signal ? { signal } : {}),
    }),

  messages: (key: string, signal?: AbortSignal): Promise<SessionMessagesResponse> =>
    request(`/api/sessions/${encodeURIComponent(key)}/messages`, SessionMessagesResponseSchema, {
      ...(signal ? { signal } : {}),
    }),

  notifications: (signal?: AbortSignal): Promise<NotificationListResponse> =>
    request('/api/notifications', NotificationListResponseSchema, {
      ...(signal ? { signal } : {}),
    }),

  /** The updated row rather than a 204, so one item reconciles without a refetch. */
  readNotification: (id: string): Promise<Notification> =>
    request(`/api/notifications/${encodeURIComponent(id)}/read`, NotificationSchema, {
      method: 'POST',
    }),

  readAllNotifications: (): Promise<void> =>
    requestVoid('/api/notifications/read', { method: 'POST' }),

  deleteNotification: (id: string): Promise<void> =>
    requestVoid(`/api/notifications/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  tools: (signal?: AbortSignal): Promise<ToolListResponse> =>
    request('/api/tools', ToolListResponseSchema, { ...(signal ? { signal } : {}) }),

  settings: (signal?: AbortSignal): Promise<SettingsResponse> =>
    request('/api/settings', SettingsResponseSchema, { ...(signal ? { signal } : {}) }),

  /**
   * A deep-partial patch, never the whole tree.
   *
   * `ConfigPatch` is what makes saving one panel leave the others alone: it is
   * built by `patchOf()` with every default stripped, so a field this request
   * does not mention is a field the server does not touch.
   */
  patchSettings: (patch: ConfigPatch): Promise<SettingsResponse> =>
    request('/api/settings', SettingsResponseSchema, { method: 'PATCH', body: patch }),

  /** Write-only. `value: null` clears the entry; nothing reads one back. */
  setCredential: (body: SetCredentialRequest): Promise<void> =>
    requestVoid('/api/settings/credentials', { method: 'PUT', body }),

  providers: (signal?: AbortSignal): Promise<ProvidersResponse> =>
    request('/api/providers', ProvidersResponseSchema, { ...(signal ? { signal } : {}) }),

  models: (signal?: AbortSignal): Promise<ModelsResponse> =>
    request('/api/models', ModelsResponseSchema, { ...(signal ? { signal } : {}) }),

  /** What a turn on this session would actually send, for the context inspector. */
  context: (key: string, signal?: AbortSignal): Promise<ContextResponse> =>
    request(`/api/sessions/${encodeURIComponent(key)}/context`, ContextResponseSchema, {
      ...(signal ? { signal } : {}),
    }),

  files: (workspace: string, path: string, signal?: AbortSignal): Promise<FileListResponse> =>
    request('/api/files', FileListResponseSchema, {
      query: { path, workspace },
      ...(signal ? { signal } : {}),
    }),

  /**
   * Deletes a file, or a directory.
   *
   * `recursive` is only sent when it is true, and it is what lets a directory
   * take its contents with it. Without it the server removes an empty directory
   * and refuses a full one — so emptying a tree is never something a request
   * happens to do.
   */
  deleteFile: (workspace: string, path: string, recursive = false): Promise<void> =>
    requestVoid('/api/files', {
      method: 'DELETE',
      query: { path, workspace, ...(recursive ? { recursive: 'true' } : {}) },
    }),

  /**
   * Writes a file into the workspace and returns a URL an `<img>` can load.
   *
   * The body is the raw bytes rather than a `multipart/form-data` envelope,
   * because that is what the route reads: a browser already has the `File`, and
   * a base64 or multipart wrapper would inflate every upload to describe what
   * `Content-Type` already says.
   */
  upload: (
    workspace: string,
    path: string,
    file: Blob,
    signal?: AbortSignal,
  ): Promise<UploadResponse> =>
    request('/api/files/upload', UploadResponseSchema, {
      method: 'POST',
      query: { path, workspace },
      body: file,
      ...(signal ? { signal } : {}),
    }),

  /**
   * One file as text, for the editor.
   *
   * Not the signed URL, and not a duplicate of it. A signature exists so an
   * `<img>` can fetch bytes without a header; this returns characters, plus the
   * `modifiedAtMs` that `writeText` sends back to prove nothing moved. It also
   * answers for the source files the MIME table does not know — `.py`, `.ts`,
   * `.css` — which the media route serves as attachments.
   */
  readText: (
    workspace: string,
    path: string,
    signal?: AbortSignal,
  ): Promise<FileTextResponse> =>
    request('/api/files/text', FileTextResponseSchema, {
      query: { path, workspace },
      ...(signal ? { signal } : {}),
    }),

  /**
   * Saves text, refusing when the file moved under the editor.
   *
   * `expectedModifiedAtMs` is the timestamp the editor loaded. Omitting it is
   * how a new file is created — there is nothing yet to conflict with.
   */
  writeText: (
    workspaceId: string,
    path: string,
    content: string,
    expectedModifiedAtMs?: number,
  ): Promise<FileEntry> =>
    request('/api/files/text', FileEntrySchema, {
      method: 'PUT',
      body: {
        path,
        content,
        workspaceId,
        ...(expectedModifiedAtMs === undefined ? {} : { expectedModifiedAtMs }),
      },
    }),

  createDirectory: (workspaceId: string, path: string): Promise<FileEntry> =>
    request('/api/files/directory', FileEntrySchema, {
      method: 'POST',
      body: { path, workspaceId },
    }),

  /** A short-lived signed URL for a workspace path an `<img>` will load. */
  signUrl: (workspaceId: string, path: string, signal?: AbortSignal): Promise<SignedUrl> =>
    request('/api/files/signed-url', SignedUrlSchema, {
      method: 'POST',
      body: { path, workspaceId },
      ...(signal ? { signal } : {}),
    }),

  // -------------------------------------------------------------------------
  // Workspaces
  // -------------------------------------------------------------------------

  workspaces: (signal?: AbortSignal): Promise<WorkspaceListResponse> =>
    request('/api/workspaces', WorkspaceListResponseSchema, { ...(signal ? { signal } : {}) }),

  /** The id is derived from the name unless one is given. Never a path. */
  createWorkspace: (name: string, id?: string): Promise<WorkspaceSummary> =>
    request('/api/workspaces', WorkspaceSummarySchema, {
      method: 'POST',
      body: { name, ...(id === undefined ? {} : { id }) },
    }),

  renameWorkspace: (id: string, name: string): Promise<WorkspaceSummary> =>
    request(`/api/workspaces/${encodeURIComponent(id)}`, WorkspaceSummarySchema, {
      method: 'PATCH',
      body: { name },
    }),

  /** Detaches it. The folder and everything in it stays on disk. */
  deleteWorkspace: (id: string): Promise<void> =>
    requestVoid(`/api/workspaces/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  moveWorkspaceSessions: (from: string, to: string): Promise<MoveSessionsResponse> =>
    request(
      `/api/workspaces/${encodeURIComponent(from)}/sessions/move`,
      MoveSessionsResponseSchema,
      { method: 'POST', body: { to } },
    ),
};

async function send(path: string, options: RequestOptions): Promise<Response> {
  const { method = 'GET', body, signal, query } = options;

  const url = query === undefined ? path : `${path}?${searchParams(query)}`;
  const hasBody = body !== undefined;
  // A `Blob` is an upload: it goes as its own bytes, and the browser sets the
  // `Content-Type` from the file. Anything else is JSON.
  const raw = body instanceof Blob;

  return await fetch(url, {
    method,
    // The cookie is the credential, and it is `SameSite=Strict`.
    credentials: 'same-origin',
    ...(hasBody && !raw ? { headers: { 'content-type': 'application/json' } } : {}),
    ...(hasBody ? { body: raw ? body : JSON.stringify(body) } : {}),
    ...(signal ? { signal } : {}),
  });
}

function searchParams(
  query: Readonly<Record<string, string | number | boolean | undefined>>,
): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value));
  }
  return params.toString();
}

/** A body that is not JSON is not a protocol error worth a stack trace. */
async function readJson(response: Response): Promise<unknown> {
  if (response.status === 204) return undefined;
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function toApiError(status: number, body: unknown): ApiError {
  const parsed = ErrorResponseSchema.safeParse(body);
  if (parsed.success) {
    const { code, message, details } = parsed.data.error;
    return new ApiError(status, code, message, details);
  }

  // A proxy, a gateway or a crash — anything that answered without going
  // through the error serialiser.
  return new ApiError(status, 'http_error', `Request failed with ${status.toString()}`);
}
