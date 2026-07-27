/**
 * Typed provider failures.
 *
 * The rule this file exists to enforce: **nothing decides what to do about a
 * failure by searching text for it.** Matching `"429"` or `"rate limit"` or
 * `"overloaded"` in a response is wrong in both directions — a model that
 * legitimately writes the words "rate limit" in its answer triggers a retry, and
 * a provider that phrases its 429 differently does not. Every decision the
 * resilience decorator makes is driven by the HTTP status and the provider's own
 * structured `error` object.
 *
 * The one concession is `code`. OpenAI-compatible endpoints return
 * `{"error": {"message", "type", "param", "code"}}`, and `code` is a
 * machine-readable enum — `context_length_exceeded`, `unsupported_parameter`.
 * Reading it is not substring sniffing; it is reading the field the protocol
 * provides for exactly this. Local servers frequently omit it, which is why a
 * bare 400 still degrades: the ladder drops parameters that were sent rather
 * than parameters that were named, so it works without the hint.
 *
 * `ProviderError` extends `GhostError` so a failure crossing into the agent loop
 * keeps a `kind` from the core taxonomy and survives `toGhostError` intact. The
 * finer `reason` is what the ladder switches on.
 */

import { GhostError, type ErrorKind } from '@ghostai/core';

export const PROVIDER_ERROR_REASONS = [
  /** 401/403. The key is missing, wrong, or lacks access to the model. */
  'auth',
  /** 429, or a provider's own quota response. */
  'rate_limit',
  /** A parameter this model does not accept. The ladder can drop it. */
  'unsupported_param',
  /** The request exceeded the model's context window. */
  'context_length',
  /** Any other 4xx the caller has to fix. */
  'invalid_request',
  'model_not_found',
  'content_filter',
  /** 5xx. */
  'server',
  /** 503/529, or an explicit "overloaded" status. Retry is the right answer. */
  'overloaded',
  /** DNS, TCP, TLS — the request never reached the provider. */
  'transport',
  /** The response body was not the event stream it claimed to be. */
  'stream_parse',
  'timeout',
  'aborted',
  'unknown',
] as const;

export type ProviderErrorReason = (typeof PROVIDER_ERROR_REASONS)[number];

/**
 * Reason → the core taxonomy kind.
 *
 * Mapped rather than collapsed to `provider`, so a rate limit is still
 * `rate_limited` and a DNS failure is still `network` once the error leaves this
 * package — the channel layer and the UI branch on `kind`, not on `reason`.
 */
const KIND_BY_REASON: Readonly<Record<ProviderErrorReason, ErrorKind>> = {
  auth: 'permission_denied',
  rate_limit: 'rate_limited',
  unsupported_param: 'provider',
  context_length: 'provider',
  invalid_request: 'provider',
  model_not_found: 'not_found',
  content_filter: 'provider',
  server: 'provider',
  overloaded: 'provider',
  transport: 'network',
  stream_parse: 'provider',
  timeout: 'timeout',
  aborted: 'aborted',
  unknown: 'provider',
};

/**
 * Whether trying the identical request again could succeed.
 *
 * `stream_parse` is retryable in a specific sense: not as another stream, but as
 * a non-streaming request. `withResilience` is what knows that distinction; here
 * it only says the request itself was not the problem.
 */
const RETRYABLE_BY_REASON: Readonly<Record<ProviderErrorReason, boolean>> = {
  auth: false,
  rate_limit: true,
  unsupported_param: false,
  context_length: false,
  invalid_request: false,
  model_not_found: false,
  content_filter: false,
  server: true,
  overloaded: true,
  transport: true,
  stream_parse: true,
  timeout: true,
  aborted: false,
  unknown: false,
};

/** `?: T | undefined` throughout, so a caller can forward a field it may not have. */
export interface ProviderErrorOptions {
  readonly providerId?: string | undefined;
  readonly status?: number | undefined;
  /** The parameter the provider named as the problem, when it named one. */
  readonly param?: string | undefined;
  /** The provider's machine-readable error code. */
  readonly code?: string | undefined;
  /** From `Retry-After`, already converted to a delay. */
  readonly retryAfterMs?: number | undefined;
  readonly retryable?: boolean | undefined;
  readonly cause?: unknown;
  readonly details?: Readonly<Record<string, unknown>> | undefined;
}

export class ProviderError extends GhostError {
  override readonly name = 'ProviderError';
  readonly reason: ProviderErrorReason;
  readonly providerId: string;
  readonly status: number | undefined;
  readonly param: string | undefined;
  readonly code: string | undefined;
  readonly retryAfterMs: number | undefined;

  constructor(reason: ProviderErrorReason, message: string, options: ProviderErrorOptions = {}) {
    super(KIND_BY_REASON[reason], message, {
      retryable: options.retryable ?? RETRYABLE_BY_REASON[reason],
      ...(options.cause === undefined ? {} : { cause: options.cause }),
      details: {
        reason,
        ...(options.providerId === undefined ? {} : { providerId: options.providerId }),
        ...(options.status === undefined ? {} : { status: options.status }),
        ...(options.code === undefined ? {} : { code: options.code }),
        ...(options.param === undefined ? {} : { param: options.param }),
        ...options.details,
      },
    });
    this.reason = reason;
    this.providerId = options.providerId ?? '';
    this.status = options.status;
    this.param = options.param;
    this.code = options.code;
    this.retryAfterMs = options.retryAfterMs;
  }
}

/**
 * Structural, like `isGhostError` and for the same reason: a plugin bundling its
 * own copy of this package produces a different class identity, and `instanceof`
 * would silently reclassify every error it raised.
 */
export function isProviderError(value: unknown): value is ProviderError {
  if (!(value instanceof Error)) return false;
  const reason: unknown = (value as { reason?: unknown }).reason;
  return (
    typeof reason === 'string' && (PROVIDER_ERROR_REASONS as readonly string[]).includes(reason)
  );
}

/** The provider's `error` object, as far as anything here relies on it. */
export interface WireErrorBody {
  readonly message?: string | undefined;
  readonly type?: string | undefined;
  readonly code?: string | undefined;
  readonly param?: string | undefined;
}

/**
 * Codes that mean the request was too long.
 *
 * A `Set` of exact values, not a substring scan: `context_length_exceeded` is an
 * enum member, and treating it as prose is how a model discussing context
 * windows ends up truncating its own history.
 */
const CONTEXT_LENGTH_CODES: ReadonlySet<string> = new Set([
  'context_length_exceeded',
  'context_window_exceeded',
  'string_above_max_length',
  'invalid_prompt_length',
]);

const UNSUPPORTED_PARAM_CODES: ReadonlySet<string> = new Set([
  'unsupported_parameter',
  'unsupported_value',
  'unknown_parameter',
  'invalid_parameter',
  'parameter_not_supported',
]);

const MODEL_NOT_FOUND_CODES: ReadonlySet<string> = new Set([
  'model_not_found',
  'model_not_available',
  'invalid_model',
]);

/**
 * HTTP status plus the structured error body → a reason.
 *
 * The 400 branch carries the weight, because "the request was wrong" is the only
 * failure the ladder can actually repair. Where the provider names a code or a
 * param, that is used; where it does not — every local inference server, most of
 * the time — the reason stays `invalid_request` and the ladder falls back to
 * dropping whatever optional parameters the request happened to carry.
 */
export function classifyStatus(status: number, body: WireErrorBody | null): ProviderErrorReason {
  const code = body?.code;

  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'model_not_found';
  if (status === 408) return 'timeout';
  if (status === 429) return 'rate_limit';
  // 529 is Anthropic's overloaded status; it is not in the IANA registry and no
  // client library special-cases it, which is precisely why it is here.
  if (status === 503 || status === 529) return 'overloaded';
  if (status >= 500) return 'server';

  if (code !== undefined) {
    if (CONTEXT_LENGTH_CODES.has(code)) return 'context_length';
    if (UNSUPPORTED_PARAM_CODES.has(code)) return 'unsupported_param';
    if (MODEL_NOT_FOUND_CODES.has(code)) return 'model_not_found';
    if (code === 'content_filter') return 'content_filter';
    if (code === 'rate_limit_exceeded' || code === 'insufficient_quota') return 'rate_limit';
  }

  // A named parameter on a 4xx is the provider pointing at the field it rejected,
  // which is exactly what the degradation ladder needs to know.
  if (body?.param !== undefined && body.param !== '') return 'unsupported_param';

  if (status >= 400) return 'invalid_request';
  return 'unknown';
}

/**
 * `Retry-After` as a delay in milliseconds.
 *
 * Both forms are specified — delta-seconds and an HTTP date — and providers use
 * both. `null` for anything else, so a malformed header falls back to the
 * decorator's own backoff rather than to `NaN`.
 */
export function parseRetryAfter(value: string | null, nowMs: number): number | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;

  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;

  // Every HTTP-date form carries a three-letter weekday and month, and requiring
  // them is what keeps `Date.parse` from accepting garbage: it reads `-5` as a
  // year in antiquity, which would clamp to a zero delay and retry immediately.
  if (!/[a-z]{3}/i.test(trimmed)) return null;
  const dateMs = Date.parse(trimmed);
  if (Number.isNaN(dateMs)) return null;
  return Math.max(0, dateMs - nowMs);
}

/** Normalises anything thrown on the request path into a `ProviderError`. */
export function toProviderError(value: unknown, providerId: string): ProviderError {
  if (isProviderError(value)) return value;

  if (value instanceof Error && value.name === 'AbortError') {
    return new ProviderError('aborted', 'Request aborted', { providerId, cause: value });
  }
  if (value instanceof Error && value.name === 'TimeoutError') {
    return new ProviderError('timeout', 'Request timed out', { providerId, cause: value });
  }
  // Everything else on this path is a failed connection: undici raises
  // `TypeError: fetch failed` with the real cause nested underneath.
  const message = value instanceof Error ? value.message : String(value);
  return new ProviderError('transport', message, { providerId, cause: value });
}
