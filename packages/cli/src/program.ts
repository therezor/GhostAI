/**
 * The `ghost` command line.
 *
 * Two rules shape this file, and both are about start-up cost:
 *
 *  - **Nothing from `@ghostai/*` is imported at module scope.** Only `commander`
 *    and types, which erase. `@ghostai/core` alone pulls in pino, zod and
 *    `node:sqlite`, and the agent behind it pulls the provider adapters and the
 *    tool registry — none of which `ghost --help` has any use for. The
 *    subcommand is loaded inside its action handler, and even `isGhostError` is
 *    imported inside the `catch` that needs it, on a path that has already
 *    failed. tsup's ESM code splitting makes that a real second chunk rather
 *    than a stylistic gesture.
 *  - **Nothing here runs at module scope either.** `buildProgram` constructs,
 *    `runCli` parses and returns an exit code, and neither touches
 *    `process.exit` — which is what lets a test drive the whole parser
 *    in-process, and what stops a half-written stdout from being discarded.
 *
 * Errors become exit codes here and nowhere else. A `GhostError` from a
 * misconfigured provider is a message an operator can act on, not a stack
 * trace, so the stack is shown only when `GHOSTAI_DEBUG` asks for it.
 */

import { Command, CommanderError } from 'commander';

import type { LogLevel } from '@ghostai/core';

import type { ChatOptions } from './chat.js';
import type { ServeCommandOptions } from './serve.js';

/**
 * Kept in step with `package.json` by `program.test.ts`.
 *
 * Read from a constant rather than from the manifest at runtime: the bundle
 * lands in `dist/`, so a relative read resolves differently in development and
 * in the published package, and the failure mode is a version string that is
 * wrong rather than absent.
 */
export const VERSION = '0.0.0';

const LOG_LEVELS: readonly string[] = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];

export interface CliDeps {
  readonly out?: NodeJS.WritableStream;
  readonly errOut?: NodeJS.WritableStream;
  /** Injected so a test can drive the parser without booting an agent. */
  readonly runChat?: (options: ChatOptions) => Promise<number>;
  /** Injected so a test can drive the parser without binding a port. */
  readonly runServe?: (options: ServeCommandOptions) => Promise<number>;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

interface GlobalOptions {
  readonly home?: string;
  readonly logLevel?: string;
  readonly color: boolean;
}

interface ServeCliOptions {
  readonly host?: string;
  readonly port?: string;
  readonly workspace?: string;
  readonly password?: string;
  readonly ui?: string;
}

interface ChatCliOptions {
  readonly session: string;
  readonly model?: string;
  readonly provider?: string;
  readonly workspace?: string;
  readonly new: boolean;
  readonly json: boolean;
  readonly reasoning: boolean;
  readonly tools: boolean;
}

/** `chatCommand` is loaded here, inside the action, and not before. */
async function defaultRunChat(options: ChatOptions): Promise<number> {
  const { chatCommand } = await import('./chat.js');
  return await chatCommand(options);
}

/** Likewise `serveCommand`, which pulls Fastify, argon2id and the whole server. */
async function defaultRunServe(options: ServeCommandOptions): Promise<number> {
  const { serveCommand } = await import('./serve.js');
  return await serveCommand(options);
}

/** A port from the command line, refused before anything binds. */
function resolvePort(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new CommanderError(1, 'ghost.port', `"${value}" is not a port number`);
  }
  return port;
}

function resolveLogLevel(value: string | undefined): LogLevel | undefined {
  if (value === undefined) return undefined;
  if (!LOG_LEVELS.includes(value)) {
    throw new CommanderError(1, 'ghost.logLevel', `Unknown log level "${value}"`);
  }
  return value as LogLevel;
}

export function buildProgram(deps: CliDeps = {}): Command {
  const out = deps.out ?? process.stdout;
  const errOut = deps.errOut ?? process.stderr;
  const env = deps.env ?? process.env;
  const runChat = deps.runChat ?? defaultRunChat;
  const runServe = deps.runServe ?? defaultRunServe;

  const program = new Command('ghost')
    .description('A self-hosted agent that runs where your files are.')
    .version(VERSION, '-v, --version')
    .option('--home <dir>', 'GhostAI home directory (default: $GHOSTAI_HOME or ~/.ghostai)')
    .option('--log-level <level>', `one of ${LOG_LEVELS.join(', ')} (default: warn)`)
    .option('--no-color', 'disable colour output')
    .configureOutput({
      writeOut: (text) => out.write(text),
      writeErr: (text) => errOut.write(text),
    })
    // Without this, commander calls `process.exit` for `--help` and for a bad
    // flag, and `runCli` never gets to decide what the exit code means.
    .exitOverride();

  program
    .command('chat', { isDefault: true })
    .description('Talk to the agent. With no message, opens a prompt.')
    .argument('[message...]', 'a single turn to run, instead of the prompt')
    .option('-s, --session <key>', 'session to continue', 'cli:default')
    .option('-m, --model <id>', 'model id, overriding the configured default')
    .option('-p, --provider <id>', 'provider id, overriding the configured default')
    .option('-w, --workspace <dir>', 'workspace root, overriding the configured default')
    .option('--new', 'clear the session before this turn', false)
    .option('--json', 'emit one agent event per line as JSON', false)
    .option('--no-reasoning', 'hide the model’s reasoning stream')
    .option('--no-tools', 'run the turn with no tools registered')
    .action(async (words: string[], options: ChatCliOptions, command: Command) => {
      const globals = command.parent?.opts<GlobalOptions>() ?? { color: true };
      const level = resolveLogLevel(globals.logLevel);
      const message = words.join(' ').trim();

      const code = await runChat({
        ...(message === '' ? {} : { message }),
        sessionKey: options.session,
        ...(options.model === undefined ? {} : { model: options.model }),
        ...(options.provider === undefined ? {} : { provider: options.provider }),
        ...(options.workspace === undefined ? {} : { workspace: options.workspace }),
        ...(globals.home === undefined ? {} : { home: globals.home }),
        fresh: options.new,
        json: options.json,
        showReasoning: options.reasoning,
        tools: options.tools,
        // `--json` writes machine-readable output to the same stream; colouring
        // it would corrupt the JSON for the script reading it.
        colors: options.json ? false : globals.color,
        out,
        errOut,
        ...(level === undefined ? {} : { logLevel: level }),
      });
      command.setOptionValue('exitCode', code);
    });

  program
    .command('serve')
    .description('Serve the web UI and the API on one port.')
    .option('-H, --host <host>', 'bind address, overriding the configured default')
    .option('-P, --port <port>', 'port, overriding the configured default')
    .option('-w, --workspace <dir>', 'workspace root, overriding the configured default')
    .option('--password <password>', 'set or rotate the login password (or GHOSTAI_PASSWORD)')
    .option('--ui <dir>', 'a built UI to serve, instead of the bundled one')
    .action(async (options: ServeCliOptions, command: Command) => {
      const globals = command.parent?.opts<GlobalOptions>() ?? { color: true };
      const level = resolveLogLevel(globals.logLevel);
      // The environment is read here rather than in `serveCommand`, which then
      // stays testable without anyone mutating `process.env`.
      const password = options.password ?? env.GHOSTAI_PASSWORD;

      const code = await runServe({
        ...(options.host === undefined ? {} : { host: options.host }),
        ...(resolvePort(options.port) === undefined ? {} : { port: resolvePort(options.port) }),
        ...(options.workspace === undefined ? {} : { workspace: options.workspace }),
        ...(password === undefined || password === '' ? {} : { password }),
        ...(options.ui === undefined ? {} : { ui: options.ui }),
        ...(globals.home === undefined ? {} : { home: globals.home }),
        // A server is a long-running process, and `warn` on one is a process
        // that says nothing about the requests it is serving.
        logLevel: level ?? 'info',
        colors: globals.color,
        out,
        errOut,
        env,
      });
      command.setOptionValue('exitCode', code);
    });

  return program;
}

/**
 * Turns a failure into the message an operator can act on.
 *
 * `isGhostError` is imported here rather than at the top of the file: this runs
 * only on a path that has already failed, so the cost of loading
 * `@ghostai/core` is one nobody is waiting on — and keeping it off module scope
 * is what keeps `ghost --help` free of the whole dependency graph.
 */
async function describeFailure(
  error: unknown,
  env: Readonly<Record<string, string | undefined>>,
): Promise<string> {
  const { isGhostError } = await import('@ghostai/core');
  if (isGhostError(error)) {
    const debug = (env.GHOSTAI_DEBUG ?? '') !== '';
    return debug && error.stack !== undefined ? error.stack : error.message;
  }
  if (error instanceof Error) return error.stack ?? error.message;
  return String(error);
}

/**
 * Parses `argv` and returns the process exit code.
 *
 * Never calls `process.exit`: the caller sets `process.exitCode` and lets Node
 * drain stdout on its own, which is the difference between a piped answer
 * arriving in full and being truncated at whatever the pipe had flushed.
 */
export async function runCli(argv: readonly string[], deps: CliDeps = {}): Promise<number> {
  const errOut = deps.errOut ?? process.stderr;
  const env = deps.env ?? process.env;
  const program = buildProgram(deps);

  try {
    await program.parseAsync([...argv]);
  } catch (error) {
    if (error instanceof CommanderError) {
      // `--help` and `--version` are successful exits that arrive as throws.
      if (error.exitCode === 0) return 0;
      return error.exitCode;
    }
    errOut.write(`✖ ${await describeFailure(error, env)}\n`);
    return 1;
  }

  // Whichever subcommand ran set it; the others left theirs unset. Reading the
  // one that has a number is what keeps this from having to know which ran.
  for (const command of program.commands) {
    const code: unknown = command.getOptionValue('exitCode');
    if (typeof code === 'number') return code;
  }
  return 0;
}
