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
  ErrorResponseSchema,
  LoginResponseSchema,
  NotificationListResponseSchema,
  SessionListResponseSchema,
  SessionMessagesResponseSchema,
  SignedUrlSchema,
  StatusResponseSchema,
  ToolListResponseSchema,
  UploadResponseSchema,
  type AuthSessionResponse,
  type LoginResponse,
  type NotificationListResponse,
  type SessionListResponse,
  type SessionMessagesResponse,
  type SignedUrl,
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
 * The endpoints the shell itself needs.
 *
 * Deliberately not a client for all 30 routes: Step 18's panels own the ones
 * they call, and a wrapper written before its caller is a wrapper written to
 * the wrong shape — and an untested one, since nothing exercises it. These five
 * are what the shell, the sidebar and the login overlay actually call; the rest
 * arrive beside their callers, over the same `request`.
 */
export const api = {
  me: (signal?: AbortSignal): Promise<AuthSessionResponse> =>
    request('/api/auth/me', AuthSessionResponseSchema, { ...(signal ? { signal } : {}) }),

  login: (password: string): Promise<LoginResponse> =>
    request('/api/auth/login', LoginResponseSchema, { method: 'POST', body: { password } }),

  status: (signal?: AbortSignal): Promise<StatusResponse> =>
    request('/api/status', StatusResponseSchema, { ...(signal ? { signal } : {}) }),

  sessions: (signal?: AbortSignal): Promise<SessionListResponse> =>
    request('/api/sessions', SessionListResponseSchema, { ...(signal ? { signal } : {}) }),

  messages: (key: string, signal?: AbortSignal): Promise<SessionMessagesResponse> =>
    request(`/api/sessions/${encodeURIComponent(key)}/messages`, SessionMessagesResponseSchema, {
      ...(signal ? { signal } : {}),
    }),

  notifications: (signal?: AbortSignal): Promise<NotificationListResponse> =>
    request('/api/notifications', NotificationListResponseSchema, {
      ...(signal ? { signal } : {}),
    }),

  tools: (signal?: AbortSignal): Promise<ToolListResponse> =>
    request('/api/tools', ToolListResponseSchema, { ...(signal ? { signal } : {}) }),

  /**
   * Writes a file into the workspace and returns a URL an `<img>` can load.
   *
   * The body is the raw bytes rather than a `multipart/form-data` envelope,
   * because that is what the route reads: a browser already has the `File`, and
   * a base64 or multipart wrapper would inflate every upload to describe what
   * `Content-Type` already says.
   */
  upload: (path: string, file: Blob, signal?: AbortSignal): Promise<UploadResponse> =>
    request('/api/files/upload', UploadResponseSchema, {
      method: 'POST',
      query: { path },
      body: file,
      ...(signal ? { signal } : {}),
    }),

  /** A short-lived signed URL for a workspace path an `<img>` will load. */
  signUrl: (path: string, signal?: AbortSignal): Promise<SignedUrl> =>
    request('/api/files/signed-url', SignedUrlSchema, {
      method: 'POST',
      body: { path },
      ...(signal ? { signal } : {}),
    }),
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
