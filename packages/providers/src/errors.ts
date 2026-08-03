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

  constructor(
    reason: ProviderErrorReason,
    message: string,
    options: ProviderErrorOptions = {},
  ) {
    super(KIND_BY_REASON[reason], message, {
      retryable: options.retryable ?? RETRYABLE_BY_REASON[reason],
      ...(options.cause === undefined ? {} : { cause: options.cause }),
      details: {
        reason,
        ...(options.providerId === undefined
          ? {}
          : { providerId: options.providerId }),
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
    typeof reason === 'string' &&
    (PROVIDER_ERROR_REASONS as readonly string[]).includes(reason)
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
export function classifyStatus(
  status: number,
  body: WireErrorBody | null,
): ProviderErrorReason {
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
    if (code === 'rate_limit_exceeded' || code === 'insufficient_quota') {
      return 'rate_limit';
    }
  }

  // A named parameter on a 4xx is the provider pointing at the field it rejected,
  // which is exactly what the degradation ladder needs to know.
  if (body?.param !== undefined && body.param !== '') {
    return 'unsupported_param';
  }

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
export function parseRetryAfter(
  value: string | null,
  nowMs: number,
): number | null {
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

/**
 * What the socket said, dug out from under `TypeError: fetch failed`.
 *
 * That string is all undici puts on the error it throws; the code that says
 * *why* is on `cause`, sometimes two levels down, and on an `AggregateError`
 * when a host resolved to several addresses and every one of them failed.
 * Walking it is the difference between "fetch failed" and "nothing is listening
 * at http://127.0.0.1:11434".
 *
 * Bounded rather than recursive-until-null: a cause chain is a linked list a
 * library controls, and one that loops would hang the error path.
 */
function transportCode(value: unknown, depth = 0): string | undefined {
  if (depth > 4 || typeof value !== 'object' || value === null) {
    return undefined;
  }

  const code: unknown = (value as { code?: unknown }).code;
  if (typeof code === 'string' && code !== '') return code;

  // Every address for one host failed, each with its own reason. They are
  // almost always the same reason — a server that is down is down on both
  // 127.0.0.1 and ::1 — so the first one is the answer, not a summary.
  const errors: unknown = (value as { errors?: unknown }).errors;
  if (Array.isArray(errors)) {
    for (const nested of errors) {
      const found = transportCode(nested, depth + 1);
      if (found !== undefined) return found;
    }
  }

  return transportCode((value as { cause?: unknown }).cause, depth + 1);
}

/**
 * Socket code → what an operator should read, and whether pressing send again
 * could possibly help.
 *
 * The wording names a thing to *do* wherever the code implies one. "fetch
 * failed" is true of every entry here and useful for none of them: it does not
 * distinguish a model server that was never started from a hostname that no
 * longer resolves from a certificate the machine will not accept, and those are
 * three different afternoons.
 *
 * `retryable` is false where the same request is certain to fail the same way
 * until somebody changes something. It is not a claim about permanence — it is
 * what decides whether the UI offers "sending the message again may work",
 * which under a refused connection is advice to press a button that cannot
 * work.
 */
const TRANSPORT_FAULTS: Readonly<
  Record<string, { readonly detail: string; readonly retryable: boolean }>
> = {
  ECONNREFUSED: { detail: 'nothing is listening there', retryable: false },
  ENOTFOUND: { detail: 'that host name does not resolve', retryable: false },
  EAI_AGAIN: {
    detail: 'the host name could not be looked up',
    retryable: true,
  },
  EHOSTUNREACH: { detail: 'there is no route to that host', retryable: true },
  ENETUNREACH: { detail: 'that network is unreachable', retryable: true },
  ETIMEDOUT: { detail: 'the connection timed out', retryable: true },
  UND_ERR_CONNECT_TIMEOUT: {
    detail: 'the connection timed out',
    retryable: true,
  },
  UND_ERR_HEADERS_TIMEOUT: {
    detail: 'it accepted the request and never replied',
    retryable: true,
  },
  UND_ERR_BODY_TIMEOUT: {
    detail: 'it stopped sending mid-answer',
    retryable: true,
  },
  ECONNRESET: {
    detail: 'it closed the connection before answering',
    retryable: true,
  },
  EPIPE: {
    detail: 'it closed the connection before answering',
    retryable: true,
  },
  UND_ERR_SOCKET: {
    detail: 'it closed the connection before answering',
    retryable: true,
  },
};

/** TLS refusals, which are all the same sentence with a different code in it. */
const TLS_CODE =
  /^(CERT_|ERR_TLS_|DEPTH_ZERO|SELF_SIGNED|UNABLE_TO_(GET|VERIFY))/u;

/** Where the request was aimed, so the message can name it. */
export interface TransportContext {
  /** The full request URL. Reported as its origin — a path adds nothing here. */
  readonly url?: string | undefined;
  /** The provider's display name. Falls back to the id. */
  readonly label?: string | undefined;
}

/** `http://127.0.0.1:11434`, or the whole string if it does not parse. */
function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

/**
 * Normalises anything thrown on the request path into a `ProviderError`.
 *
 * The transport branch is where the message is *built* rather than forwarded,
 * and it is the one case where forwarding is wrong: undici's own message is
 * `fetch failed` for every connection failure there is.
 */
export function toProviderError(
  value: unknown,
  providerId: string,
  context: TransportContext = {},
): ProviderError {
  if (isProviderError(value)) return value;

  if (value instanceof Error && value.name === 'AbortError') {
    return new ProviderError('aborted', 'Request aborted', {
      providerId,
      cause: value,
    });
  }
  if (value instanceof Error && value.name === 'TimeoutError') {
    return new ProviderError('timeout', 'Request timed out', {
      providerId,
      cause: value,
    });
  }

  // Everything else on this path is a failed connection.
  const raw = value instanceof Error ? value.message : String(value);
  const code = transportCode(value);
  const name = context.label ?? providerId;
  const target =
    context.url === undefined ? name : `${name} at ${originOf(context.url)}`;

  const fault = code === undefined ? undefined : TRANSPORT_FAULTS[code];
  const detail =
    fault?.detail ??
    (code !== undefined && TLS_CODE.test(code)
      ? `its TLS certificate was rejected (${code})`
      : // No code, or one this table has never seen: undici's own message, which
        // is at least specific when it is not literally "fetch failed".
        (code ?? raw));

  return new ProviderError(
    'transport',
    `Could not reach ${target} — ${detail}.`,
    {
      providerId,
      cause: value,
      ...(fault === undefined ? {} : { retryable: fault.retryable }),
      details: {
        ...(code === undefined ? {} : { code }),
        ...(context.url === undefined ? {} : { url: context.url }),
      },
    },
  );
}
