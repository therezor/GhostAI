/**
 * The error taxonomy.
 *
 * Every failure that crosses a package boundary carries a `kind` from a closed
 * union. Nothing anywhere may branch on the *text* of an error: a model that
 * legitimately writes "rate limit" in its answer must not trigger a retry, and
 * a tool whose output legitimately begins with "Error" must not be recorded as
 * a failure. The flag is the truth; the message is for humans.
 *
 * `GhostError` is a class rather than a plain object because it has to survive
 * being thrown through code we do not own — `node:sqlite`, `undici`, a plugin's
 * `setup()` — and come back out of a `catch` still identifiable. `toGhostError`
 * is the funnel: every `catch` block normalises through it, so an `unknown` from
 * anywhere becomes a typed value exactly once, at the boundary.
 */

export const ERROR_KINDS = [
  /** Malformed or unloadable configuration. */
  'config',
  /** A caller supplied arguments that failed schema validation. */
  'invalid_input',
  'not_found',
  'conflict',
  /** An approval was refused, or a plugin lacked the declared capability. */
  'permission_denied',
  /** A path resolved outside the workspace jail. Always security-relevant. */
  'jail_escape',
  /** Transport-level failure: DNS, TCP, TLS, a blocked SSRF target. */
  'network',
  /** The provider accepted the connection and rejected the request. */
  'provider',
  'tool',
  'timeout',
  /** The turn's `AbortSignal` fired. Never an error the user needs to see. */
  'aborted',
  'rate_limited',
  /** SQLite, or the filesystem underneath it. */
  'storage',
  'plugin',
  /** An invariant this codebase is supposed to uphold did not hold. */
  'internal',
] as const;

export type ErrorKind = (typeof ERROR_KINDS)[number];

/**
 * Whether a kind is worth trying again *without changing anything*.
 *
 * Deliberately conservative. `provider` is false because the overwhelmingly
 * common cause is a malformed request, and blind retries against a 400 burn
 * quota to reach the same answer; the resilience decorator in
 * `@ghostai/providers` overrides this per response, where the status code is
 * actually known.
 */
const RETRYABLE_BY_KIND: Readonly<Record<ErrorKind, boolean>> = {
  config: false,
  invalid_input: false,
  not_found: false,
  conflict: false,
  permission_denied: false,
  jail_escape: false,
  network: true,
  provider: false,
  tool: false,
  timeout: true,
  aborted: false,
  rate_limited: true,
  storage: false,
  plugin: false,
  internal: false,
};

export interface GhostErrorOptions {
  /** Overrides the kind's default from `RETRYABLE_BY_KIND`. */
  readonly retryable?: boolean;
  /**
   * Structured context for the log line. Must stay JSON-serialisable — it is
   * passed straight to pino, which redacts it by path.
   */
  readonly details?: Readonly<Record<string, unknown>>;
  readonly cause?: unknown;
}

export class GhostError extends Error {
  override readonly name = 'GhostError';
  readonly kind: ErrorKind;
  readonly retryable: boolean;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(kind: ErrorKind, message: string, options: GhostErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.kind = kind;
    this.retryable = options.retryable ?? RETRYABLE_BY_KIND[kind];
    this.details = options.details ?? {};
  }
}

/**
 * Structural, not `instanceof`.
 *
 * A plugin resolving its own copy of `@ghostai/core` produces a `GhostError`
 * from a different class identity, and `instanceof` would silently reclassify
 * every one of them as `internal`.
 */
export function isGhostError(value: unknown): value is GhostError {
  if (!(value instanceof Error)) return false;
  const kind: unknown = (value as { kind?: unknown }).kind;
  return typeof kind === 'string' && (ERROR_KINDS as readonly string[]).includes(kind);
}

/**
 * Whether a value is the abort a caller asked for rather than a real failure.
 *
 * `AbortSignal` produces a `DOMException` named `AbortError`, which is neither
 * a `GhostError` nor reliably an `instanceof DOMException` across realms — so
 * this checks the name. One `AbortSignal` threads from the request through the
 * loop, the provider fetch, tool execution and any child process, and every one
 * of those layers has to recognise its own cancellation as a non-event.
 */
export function isAbortError(value: unknown): boolean {
  if (isGhostError(value)) return value.kind === 'aborted';
  return value instanceof Error && value.name === 'AbortError';
}

/**
 * Normalises anything a `catch` can produce into a `GhostError`.
 *
 * Already-typed errors pass through untouched, so re-normalising at each layer
 * of a call stack cannot degrade a precise kind into `internal`.
 */
export function toGhostError(value: unknown, fallbackKind: ErrorKind = 'internal'): GhostError {
  if (isGhostError(value)) return value;
  if (isAbortError(value)) return new GhostError('aborted', 'Operation aborted', { cause: value });
  if (value instanceof Error) {
    return new GhostError(fallbackKind, value.message, { cause: value });
  }
  return new GhostError(fallbackKind, typeof value === 'string' ? value : String(value), {
    cause: value,
  });
}

/** Constructs an `aborted` error. The one kind produced from many places. */
export function abortedError(what: string): GhostError {
  return new GhostError('aborted', `${what} aborted`);
}
