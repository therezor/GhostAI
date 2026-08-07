/**
 * Structured logging.
 *
 * The redaction list is the point of this module. An agent runtime logs
 * provider requests, tool arguments, extension config and channel payloads, and
 * every one of those is a plausible carrier for an API key, a bearer token or a
 * Telegram bot secret. Redaction is applied by *path* rather than by scanning
 * values, because scanning cannot tell a key from any other opaque string and
 * would either miss secrets or mangle legitimate output.
 *
 * Paths are matched against the object passed as the first argument to a log
 * method, so the convention is to log structured context — `log.info({ tool },
 * 'executing')` — rather than interpolating it into the message string, where
 * no redaction can reach it.
 */

import pino from 'pino';

export type Logger = pino.Logger;
export type LogLevel = pino.Level;

/**
 * Wildcards cover the shapes secrets actually arrive in: a bare field, one
 * level inside a named bag (`provider.apiKey`), and one level inside a keyed
 * record (`providers.openai.apiKey`). Deeper nesting is not enumerated —
 * instead, callers log the specific sub-object they mean, which is better
 * practice anyway and keeps this list short enough to audit.
 */
const REDACT_PATHS: readonly string[] = [
  'apiKey',
  'api_key',
  'token',
  'accessToken',
  'refreshToken',
  'clientSecret',
  'password',
  'passphrase',
  'secret',
  'authorization',
  'cookie',
  '*.apiKey',
  '*.api_key',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
  '*.clientSecret',
  '*.password',
  '*.passphrase',
  '*.secret',
  '*.authorization',
  '*.cookie',
  '*.*.apiKey',
  '*.*.token',
  '*.*.secret',
  'headers.authorization',
  'headers.cookie',
  'headers["set-cookie"]',
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
];

export const REDACT_CENSOR = '[redacted]';

interface CreateLoggerOptions {
  /** Defaults to `GHOSTAI_LOG_LEVEL`, then `LOG_LEVEL`, then `info`. */
  readonly level?: LogLevel;
  /** Component name, emitted as `name` on every line. */
  readonly name?: string;
  /** Defaults to stdout. Tests pass a memory stream and assert on the JSON. */
  readonly destination?: pino.DestinationStream;
  /** Extra fields on every line — session key, turn id, channel. */
  readonly base?: Readonly<Record<string, unknown>>;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

function resolveLevel(
  explicit: LogLevel | undefined,
  env: Readonly<Record<string, string | undefined>>,
): LogLevel {
  if (explicit !== undefined) return explicit;
  const fromEnv = env.GHOSTAI_LOG_LEVEL ?? env.LOG_LEVEL;
  // An unrecognised level must not take the process down at boot; pino would
  // throw on an unknown level, and losing the logger loses the diagnostics
  // needed to work out why.
  if (fromEnv !== undefined && fromEnv in pino.levels.values) {
    return fromEnv as LogLevel;
  }
  return 'info';
}

export function createLogger(options: CreateLoggerOptions = {}): Logger {
  const env = options.env ?? process.env;

  const pinoOptions: pino.LoggerOptions = {
    level: resolveLevel(options.level, env),
    redact: { paths: [...REDACT_PATHS], censor: REDACT_CENSOR },
    // Epoch milliseconds rather than pino's default, so log timestamps are
    // directly comparable with the `createdAtMs` columns in the database.
    timestamp: () => `,"time":${String(Date.now())}`,
    base: {
      ...(options.name === undefined ? {} : { name: options.name }),
      ...options.base,
    },
  };

  return options.destination === undefined
    ? pino(pinoOptions)
    : pino(pinoOptions, options.destination);
}

/**
 * A logger that discards everything.
 *
 * Every component takes a `Logger` rather than an optional one, so there is a
 * single code path instead of `this.log?.info(...)` at every call site. This is
 * the default those components use, and what tests pass when the assertion is
 * about behaviour rather than output.
 */
export const silentLogger: Logger = pino({ level: 'silent' });
