/**
 * One error shape for every non-2xx response.
 *
 * A client has one branch to write, and the code it switches on comes from the
 * `ErrorCode` vocabulary the WebSocket already uses — never from a substring of
 * a message. Deriving a code by searching text for "429" or "not found" is how
 * a model that legitimately writes about rate limiting ends up triggering a
 * retry in the client rendering its answer.
 *
 * The mapping runs in one direction only: a `GhostError`'s `kind` decides the
 * status and the code. Nothing here inspects a message, and nothing constructs
 * a response body outside `errorBody`.
 */

import { GhostError, isGhostError, toGhostError, type ErrorKind } from '@ghostai/core';
import type { ErrorCode, ErrorResponse } from '@ghostai/protocol';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/** Status and wire code for each kind in the core taxonomy. */
const BY_KIND: Readonly<Record<ErrorKind, { status: number; code: ErrorCode }>> = {
  config: { status: 500, code: 'config_invalid' },
  invalid_input: { status: 422, code: 'bad_request' },
  not_found: { status: 404, code: 'not_found' },
  conflict: { status: 409, code: 'bad_request' },
  permission_denied: { status: 403, code: 'unauthorized' },
  // A path that resolved outside the workspace is a refusal, not a 404: saying
  // "not found" would let a caller map the filesystem by probing for the
  // difference between the two answers.
  jail_escape: { status: 403, code: 'unauthorized' },
  network: { status: 502, code: 'provider_error' },
  provider: { status: 502, code: 'provider_error' },
  tool: { status: 500, code: 'tool_error' },
  timeout: { status: 504, code: 'internal' },
  // The client hung up or the turn was stopped. Nothing is listening for this
  // body; the status exists so the access log tells the two cases apart.
  aborted: { status: 499, code: 'internal' },
  rate_limited: { status: 429, code: 'rate_limited' },
  storage: { status: 500, code: 'internal' },
  plugin: { status: 500, code: 'internal' },
  internal: { status: 500, code: 'internal' },
};

/**
 * A `GhostError` that also names its HTTP status.
 *
 * The kind mapping above covers everything thrown from below the transport,
 * where HTTP does not exist. This covers the cases HTTP itself defines — a
 * missing credential is a 401 and nothing in the core taxonomy is — without
 * adding transport concepts to a package that must not know about them.
 */
export class HttpError extends GhostError {
  override readonly name: string = 'HttpError';
  readonly status: number;
  readonly code: ErrorCode;

  constructor(
    status: number,
    code: ErrorCode,
    kind: ErrorKind,
    message: string,
    details?: Readonly<Record<string, unknown>>,
  ) {
    super(kind, message, details === undefined ? {} : { details });
    this.status = status;
    this.code = code;
  }
}

function isHttpError(value: unknown): value is HttpError {
  return (
    isGhostError(value) &&
    typeof (value as { status?: unknown }).status === 'number' &&
    typeof (value as { code?: unknown }).code === 'string'
  );
}

/** No credential, or one that does not check out. Always 401, never 403. */
export function unauthorized(message: string): HttpError {
  return new HttpError(401, 'unauthorized', 'permission_denied', message);
}

export function badRequest(
  message: string,
  details?: Readonly<Record<string, unknown>>,
): HttpError {
  return new HttpError(400, 'bad_request', 'invalid_input', message, details);
}

/** A request body, query or param that failed its schema. */
export function unprocessable(
  message: string,
  details: Readonly<Record<string, unknown>>,
): HttpError {
  return new HttpError(422, 'bad_request', 'invalid_input', message, details);
}

export function notFound(message: string): HttpError {
  return new HttpError(404, 'not_found', 'not_found', message);
}

/**
 * The request was legal and the current state refuses it.
 *
 * Distinct from `badRequest`, and the distinction is what a client does next: a
 * 400 means "fix the request", a 409 means "look again and decide". Saving a
 * file the agent rewrote since it was loaded is the second, not the first.
 */
export function conflict(
  message: string,
  details?: Readonly<Record<string, unknown>>,
): HttpError {
  return new HttpError(409, 'bad_request', 'conflict', message, details);
}

export interface ResolvedError {
  readonly status: number;
  /**
   * The wire code, still narrowed to the union.
   *
   * `body.error.code` is the same value widened to `string`, because the
   * response schema types it that way — a document generated from it must not
   * pin clients to today's list. The WebSocket's `error` event does carry the
   * union, and a failing turn resolves through here rather than deriving a
   * second mapping from a kind to a code.
   */
  readonly code: ErrorCode;
  readonly body: ErrorResponse;
  /** The error to log, normalised. Never the body — the body is redacted. */
  readonly cause: GhostError;
}

/**
 * A generic message for anything that reached 500 without being a `GhostError`.
 *
 * An unexpected throw carries a message written for a developer reading a
 * stack trace — a file path, a SQL fragment, a stringified row — and that is
 * not a thing to hand to whoever made the request. The real message goes to
 * the log line beside it.
 */
const OPAQUE_500 = 'Internal server error';

/**
 * A 4xx Fastify raised itself — malformed JSON, an unsupported content type, a
 * body over the limit.
 *
 * These arrive as plain errors carrying `statusCode`, and mapping them through
 * the kind table would report a client mistake as a 500. Only 4xx is honoured:
 * a 5xx from a plugin is an internal failure whose message is not for the
 * caller.
 */
function clientErrorStatus(value: unknown): number | undefined {
  if (!(value instanceof Error)) return undefined;
  const status: unknown = (value as { statusCode?: unknown }).statusCode;
  if (typeof status !== 'number' || status < 400 || status >= 500) return undefined;
  return status;
}

function codeForStatus(status: number): ErrorCode {
  if (status === 401 || status === 403) return 'unauthorized';
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limited';
  return 'bad_request';
}

/** Normalises anything thrown into a status, a body and something to log. */
export function resolveError(value: unknown): ResolvedError {
  if (isHttpError(value)) {
    return {
      status: value.status,
      code: value.code,
      body: errorBody(value.code, value.message, value.details),
      cause: value,
    };
  }

  const clientStatus = clientErrorStatus(value);
  if (clientStatus !== undefined && !isGhostError(value)) {
    const code = codeForStatus(clientStatus);
    return {
      status: clientStatus,
      code,
      body: errorBody(code, (value as Error).message),
      cause: toGhostError(value, 'invalid_input'),
    };
  }

  const ghost = toGhostError(value);
  const mapped = BY_KIND[ghost.kind];
  // A `GhostError` is written for an operator; anything else at 5xx is not.
  const expected = isGhostError(value);
  const message = mapped.status >= 500 && !expected ? OPAQUE_500 : ghost.message;
  return {
    status: mapped.status,
    code: mapped.code,
    body: errorBody(mapped.code, message),
    cause: ghost,
  };
}

export function errorBody(
  code: ErrorCode,
  message: string,
  details?: Readonly<Record<string, unknown>>,
): ErrorResponse {
  return {
    error: {
      code,
      message,
      ...(details === undefined || Object.keys(details).length === 0 ? {} : { details }),
    },
  };
}

export interface ErrorHandlerOptions {
  /**
   * A last chance to answer a request no route matched.
   *
   * Returning `true` means it was handled — this is how the single-page app's
   * shell is served for a client-routed path. Returning `false` falls through
   * to the 404 envelope. It is a callback rather than a flag because Fastify
   * allows exactly one not-found handler per instance, and what belongs in it
   * (which paths are the API's, which document is the shell) is the caller's
   * knowledge, not this module's.
   */
  readonly onNotFound?: (request: FastifyRequest, reply: FastifyReply) => boolean;
}

/**
 * Installs the error and not-found handlers.
 *
 * Both go through `resolveError`, so there is exactly one place a non-2xx body
 * is constructed and no route can invent a second shape.
 */
export function registerErrorHandler(
  app: FastifyInstance,
  options: ErrorHandlerOptions = {},
): void {
  app.setErrorHandler((error: unknown, request: FastifyRequest, reply: FastifyReply) => {
    const resolved = resolveError(error);
    // Structured, not interpolated: pino redacts by path, and a message built
    // with template literals is past the point where redaction can reach it.
    const log = { err: resolved.cause, url: request.url, method: request.method };
    if (resolved.status >= 500) request.log.error(log, 'request failed');
    else request.log.warn(log, 'request rejected');
    void reply.status(resolved.status).send(resolved.body);
  });

  app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
    if (options.onNotFound?.(request, reply) === true) return;
    void reply
      .status(404)
      .send(errorBody('not_found', `No route for ${request.method} ${request.url}`));
  });
}
