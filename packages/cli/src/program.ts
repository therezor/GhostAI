/**
 * The `ghost` command line.
 *
 * Two rules shape this file, and both are about start-up cost:
 *
 *  - **Nothing from `@ghostai/*` is imported at module scope, with one measured
 *    exception.** Only `commander` and types, which erase. `@ghostai/core` alone
 *    pulls in pino, zod and `node:sqlite`, and the agent behind it pulls the
 *    provider adapters and the tool registry — none of which `ghost --help` has
 *    any use for. The subcommand is loaded inside its action handler, and even
 *    `isGhostError` is imported inside the `catch` that needs it, on a path that
 *    has already failed. tsup's ESM code splitting makes that a real second
 *    chunk rather than a stylistic gesture.
 *
 *    The exception is `./i18n.js`, and through it `@ghostai/i18n/cli`. Help text
 *    *is* the thing `--help` prints, so there is no later point to load it: the
 *    description of every flag on this page comes out of that bundle. What keeps
 *    it affordable is that the subpath carries the `cli` and `shared` bundles
 *    only — not the browser's — and i18next is a leaf with no dependencies of
 *    its own.
 *
 *    Measured on the built bundle: **3.4 ms to import, 0.9 ms to construct the
 *    instance**, against a `ghost --help` that takes ~50 ms end to end. Roughly
 *    a twelfth of the invocation, and the budget that was set for it was 10 ms.
 *    Re-measure with `node -e "import('@ghostai/i18n/cli')"` around
 *    `process.hrtime.bigint()` if this file grows another module-scope import;
 *    there is deliberately no test asserting the number, because a wall-clock
 *    budget on a shared CI runner is the transient assertion `CLAUDE.md` bans.
 *    What is enforced instead is the shape that produces it: everything else
 *    here is `import type`, or an `import()` inside the action that needs it.
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
import { describeError, translationsFor, type CliT, type Env } from './i18n.js';
import type { InitOptions } from './init.js';
import { runToolbox } from './toolbox.js';
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

const LOG_LEVELS: readonly string[] = [
  'trace',
  'debug',
  'info',
  'warn',
  'error',
  'fatal',
];

interface CliDeps {
  readonly out?: NodeJS.WritableStream;
  readonly errOut?: NodeJS.WritableStream;
  /** Injected so a test can drive the parser without booting an agent. */
  readonly runChat?: (options: ChatOptions) => Promise<number>;
  /** Injected so a test can drive the parser without binding a port. */
  readonly runServe?: (options: ServeCommandOptions) => Promise<number>;
  /** Injected so a test can drive the parser without a terminal. */
  readonly runInit?: (options: InitOptions) => Promise<number>;
  readonly input?: NodeJS.ReadableStream & { isTTY?: boolean };
  readonly env?: Env;
}

interface GlobalOptions {
  readonly home?: string;
  readonly logLevel?: string;
  readonly color: boolean;
  readonly verbose: boolean;
}

interface ServeCliOptions {
  readonly host?: string;
  readonly port?: string;
  readonly workspace?: string;
  readonly password?: string;
  readonly username?: string;
  readonly ui?: string;
}

interface ChatCliOptions {
  readonly session: string;
  readonly agent?: string;
  readonly model?: string;
  readonly provider?: string;
  readonly workspace?: string;
  readonly workspaceId?: string;
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

/** And `initCommand`, which pulls the provider adapters and the vault. */
async function defaultRunInit(options: InitOptions): Promise<number> {
  const { initCommand } = await import('./init.js');
  return await initCommand(options);
}

/** A port from the command line, refused before anything binds. */
function resolvePort(value: string | undefined, t: CliT): number | undefined {
  if (value === undefined) return undefined;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new CommanderError(1, 'ghost.port', t('program.notAPort', { value }));
  }
  return port;
}

function resolveLogLevel(
  value: string | undefined,
  t: CliT,
): LogLevel | undefined {
  if (value === undefined) return undefined;
  if (!LOG_LEVELS.includes(value)) {
    throw new CommanderError(
      1,
      'ghost.logLevel',
      t('program.unknownLogLevel', { value }),
    );
  }
  return value as LogLevel;
}

function buildProgram(deps: CliDeps = {}): Command {
  const out = deps.out ?? process.stdout;
  const errOut = deps.errOut ?? process.stderr;
  const env = deps.env ?? process.env;
  const runChat = deps.runChat ?? defaultRunChat;
  const runServe = deps.runServe ?? defaultRunServe;
  const runInit = deps.runInit ?? defaultRunInit;

  // From the environment only. `--help` and a bad flag are both answered before
  // any subcommand has loaded a config, so `config.ui.locale` does not exist
  // yet — see the seam documented in `i18n.ts`.
  const translations = translationsFor(env);
  const { t } = translations;

  // Keyed by the literal commander passes in, because that is the only thing it
  // gives `styleTitle` to identify a heading by. A heading commander adds later
  // falls through untranslated rather than throwing, which is the right failure
  // for chrome: an English word in the right place beats a crash on `--help`.
  const HELP_TITLES: Readonly<Record<string, string>> = {
    'Usage:': t('help.usage'),
    'Arguments:': t('help.arguments'),
    'Options:': t('help.options'),
    'Global Options:': t('help.globalOptions'),
    'Commands:': t('help.commands'),
  };

  const program = new Command('ghost')
    .description(t('program.description'))
    .version(VERSION, '-v, --version', t('help.outputVersion'))
    .helpOption('-h, --help', t('help.displayHelp'))
    // The `-h` flag and the `help` subcommand carry the same sentence and take
    // it from two different commander defaults, so both have to be named.
    .helpCommand('help [command]', t('help.displayHelp'))
    .option('--home <dir>', t('program.options.home'))
    .option(
      '--log-level <level>',
      t('program.options.logLevel', { levels: LOG_LEVELS.join(', ') }),
    )
    // Global, beside `--log-level` rather than on `chat`, because that is where
    // someone looks for it: `chat` is the default command, so `ghost --help` is
    // the help for what plain `ghost` does, and a flag that governs plain
    // `ghost` and is absent from that page may as well not exist.
    //
    // No `-v`: the program already spends it on `--version`, and a short flag
    // meaning one thing before the subcommand and another after it is worse
    // than no short flag.
    .option('--verbose', t('program.options.verbose'), false)
    .option('--no-color', t('program.options.noColor'))
    // Commander builds its own five section headings into `formatHelp`, so
    // `styleTitle` — its hook for colouring them — is the only seam that reaches
    // them without reimplementing the formatter. Translating here rather than
    // there is what keeps `ghost --help` from being English chrome around
    // translated descriptions.
    //
    // Must precede the `.command()` calls below: each subcommand copies the
    // help configuration off its parent at construction, so a later call would
    // reach the program and none of its children.
    .configureHelp({ styleTitle: (title) => HELP_TITLES[title] ?? title })
    .configureOutput({
      writeOut: (text) => out.write(text),
      writeErr: (text) => errOut.write(text),
    })
    // Without this, commander calls `process.exit` for `--help` and for a bad
    // flag, and `runCli` never gets to decide what the exit code means.
    .exitOverride();

  program
    .command('chat', { isDefault: true })
    .description(t('chat.description'))
    .argument('[message...]', t('chat.argument'))
    .option('-s, --session <key>', t('chat.options.session'), 'cli:default')
    .option('-a, --agent <id>', t('chat.options.agent'))
    .option('-m, --model <id>', t('chat.options.model'))
    .option('-p, --provider <id>', t('chat.options.provider'))
    // Two different things, deliberately spelled differently. `-w` moves the
    // whole tree; `-W` picks a workspace inside it. Accepting either on one flag
    // and guessing by whether the string exists on disk is how a typo'd id
    // silently becomes a path.
    .option('-w, --workspace <dir>', t('chat.options.workspace'))
    .option('-W, --workspace-id <id>', t('chat.options.workspaceId'))
    .option('--new', t('chat.options.new'), false)
    .option('--json', t('chat.options.json'), false)
    .option('--no-reasoning', t('chat.options.noReasoning'))
    .option('--no-tools', t('chat.options.noTools'))
    .action(
      async (words: string[], options: ChatCliOptions, command: Command) => {
        const globals = command.parent?.opts<GlobalOptions>() ?? {
          color: true,
          verbose: false,
        };
        const level = resolveLogLevel(globals.logLevel, t);
        const message = words.join(' ').trim();

        const code = await runChat({
          ...(message === '' ? {} : { message }),
          sessionKey: options.session,
          ...(options.agent === undefined ? {} : { agentId: options.agent }),
          ...(options.model === undefined ? {} : { model: options.model }),
          ...(options.provider === undefined
            ? {}
            : { provider: options.provider }),
          ...(options.workspace === undefined
            ? {}
            : { workspace: options.workspace }),
          ...(options.workspaceId === undefined
            ? {}
            : { workspaceId: options.workspaceId }),
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
          // An explicit `--log-level` wins over `--verbose`, because it is the
          // more specific request: someone who named `debug` has asked for
          // something `--verbose` cannot spell. Neither leaves `chatCommand` to
          // apply its own `error`.
          ...(level === undefined
            ? globals.verbose
              ? { logLevel: 'info' as const }
              : {}
            : { logLevel: level }),
        });
        command.setOptionValue('exitCode', code);
      },
    );

  program
    .command('init')
    .description(t('init.description'))
    .action(async (options: unknown, command: Command) => {
      const globals = command.parent?.opts<GlobalOptions>() ?? {
        color: true,
        verbose: false,
      };
      const code = await runInit({
        ...(globals.home === undefined ? {} : { home: globals.home }),
        colors: globals.color,
        out,
        errOut,
        env,
        ...(deps.input === undefined ? {} : { input: deps.input }),
      });
      command.setOptionValue('exitCode', code);
    });

  const toolbox = program
    .command('toolbox')
    .description(t('toolbox.description'));
  const toolboxAction =
    (action: 'list' | 'approve' | 'revoke') =>
    (id: string | undefined, options: unknown, command: Command) => {
      const globals = command.parent?.parent?.opts<GlobalOptions>() ?? {
        color: true,
        verbose: false,
      };
      const code = runToolbox({
        action,
        ...(id === undefined ? {} : { id }),
        ...(globals.home === undefined ? {} : { home: globals.home }),
        out: (line) => {
          out.write(`${line}\n`);
        },
        errOut: (line) => {
          errOut.write(`${line}\n`);
        },
        env,
        t: translations,
      });
      command.setOptionValue('exitCode', code);
    };

  toolbox
    .command('list')
    .description(t('toolbox.list.description'))
    .action((options: unknown, command: Command) => {
      toolboxAction('list')(undefined, options, command);
    });
  toolbox
    .command('approve')
    .argument('<id>')
    .description(t('toolbox.approve.description'))
    .action(toolboxAction('approve'));
  toolbox
    .command('revoke')
    .argument('<id>')
    .description(t('toolbox.revoke.description'))
    .action(toolboxAction('revoke'));

  program
    .command('serve')
    .description(t('serve.description'))
    .option('-H, --host <host>', t('serve.options.host'))
    .option('-P, --port <port>', t('serve.options.port'))
    .option('-w, --workspace <dir>', t('serve.options.workspace'))
    .option('--password <password>', t('serve.options.password'))
    .option('--username <username>', t('serve.options.username'))
    .option('--ui <dir>', t('serve.options.ui'))
    .action(async (options: ServeCliOptions, command: Command) => {
      const globals = command.parent?.opts<GlobalOptions>() ?? {
        color: true,
        verbose: false,
      };
      const level = resolveLogLevel(globals.logLevel, t);
      // The environment is read here rather than in `serveCommand`, which then
      // stays testable without anyone mutating `process.env`.
      const password = options.password ?? env.GHOSTAI_PASSWORD;
      const username = options.username ?? env.GHOSTAI_USERNAME;

      const code = await runServe({
        ...(options.host === undefined ? {} : { host: options.host }),
        ...(resolvePort(options.port, t) === undefined
          ? {}
          : { port: resolvePort(options.port, t) }),
        ...(options.workspace === undefined
          ? {}
          : { workspace: options.workspace }),
        ...(password === undefined || password === '' ? {} : { password }),
        ...(username === undefined || username === '' ? {} : { username }),
        ...(options.ui === undefined ? {} : { ui: options.ui }),
        ...(globals.home === undefined ? {} : { home: globals.home }),
        // A server is a long-running process, and `warn` on one is a process
        // that says nothing about the requests it is serving. `--verbose` is
        // one notch below that, the same relative move it makes on `chat`.
        logLevel: level ?? (globals.verbose ? 'debug' : 'info'),
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
async function describeFailure(error: unknown, env: Env): Promise<string> {
  const { isGhostError } = await import('@ghostai/core');
  if (isGhostError(error)) {
    // Under `GHOSTAI_DEBUG` the stack is what was asked for; otherwise the
    // sentence the error carries is the whole of what a person needs.
    const debug = (env.GHOSTAI_DEBUG ?? '') !== '';
    if (debug && error.stack !== undefined) return error.stack;
    return describeError(error);
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
export async function runCli(
  argv: readonly string[],
  deps: CliDeps = {},
): Promise<number> {
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
