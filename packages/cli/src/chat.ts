/**
 * `ghost chat` — a turn, or a conversation of them.
 *
 * Three shapes over one implementation: a message on the command line runs a
 * single turn and exits, a piped stdin is read as that message, and an
 * interactive terminal opens a REPL. All three drive the same `runTurn`, so an
 * interruption, an error and a stop reason behave identically whether they
 * happen in a pipeline or at a prompt.
 *
 * Cancellation is the part worth reading. There is exactly one `AbortSignal`
 * per turn, and it runs from the Ctrl-C handler here through the loop, the
 * provider request, `ToolRegistry.execute` and into `child.kill()` — so
 * interrupting a build under `exec` stops the build rather than orphaning it and
 * returning to a prompt that lies about being idle. What differs between the
 * modes is only what happens *after* the abort:
 *
 *  - **One-shot:** the turn stops and the process exits `130`, the conventional
 *    "terminated by SIGINT" code, so a script can tell an interruption from a
 *    failure.
 *  - **REPL:** the turn stops and the prompt comes back. A second Ctrl-C, with
 *    no turn running, exits. Making the first one exit would throw away the
 *    session for a mistyped question.
 *
 * The turn's final text is not re-printed at the end: `assistant.delta` already
 * streamed it, and a driver that also printed `result.text` would show every
 * answer twice.
 */

import { createInterface } from 'node:readline/promises';

import type { AgentLoop } from '@ghostai/agent';
import { createLogger, isAbortError, type LogLevel } from '@ghostai/core';
import type { ContentPart, StopReason } from '@ghostai/protocol';

import { runSlashCommand } from './commands.js';
import { TurnRenderer } from './render.js';
import { createChatRuntime, type ChatRuntime, type RuntimeOptions } from './runtime.js';

/** Conventional exit code for "terminated by SIGINT". */
export const SIGINT_EXIT_CODE = 130;

export const DEFAULT_SESSION_KEY = 'cli:default';

/** Node's stdin, narrowed to what the REPL needs to know about it. */
export type InputStream = NodeJS.ReadableStream & { isTTY?: boolean };

export interface ChatOptions extends RuntimeOptions {
  /** Present for one-shot mode; absent reads stdin or opens the REPL. */
  readonly message?: string | undefined;
  readonly sessionKey?: string;
  /**
   * Which workspace a conversation *created* by this run lands in.
   *
   * Distinct from `RuntimeOptions.workspace`, which is a directory and moves
   * the whole tree. A workspace is an id in the registry whose directory is
   * derived — see `workspace-store.ts` on why it holds no path — so accepting
   * either on one flag and telling them apart by whether the string happens to
   * exist on disk would turn a typo'd id into a path.
   */
  readonly workspaceId?: string;
  /** Drop the session's history before the first turn. */
  readonly fresh?: boolean;
  readonly colors?: boolean | undefined;
  readonly showReasoning?: boolean;
  /** One JSON object per event instead of prose. */
  readonly json?: boolean;
  readonly out?: NodeJS.WritableStream;
  /** Diagnostics, never the answer — so `--json` on stdout stays parseable. */
  readonly errOut?: NodeJS.WritableStream;
  /** Ignored when a `logger` is supplied. Defaults to `warn`. */
  readonly logLevel?: LogLevel;
  readonly input?: InputStream;
  /** Installs the Ctrl-C handler. `false` in tests, which own the signal. */
  readonly handleSignals?: boolean;
}

export interface TurnOutcome {
  /** The loop's own reason, not one re-derived from the signal. */
  readonly stopReason: StopReason;
  readonly aborted: boolean;
  readonly failed: boolean;
}

export interface RunTurnDeps {
  readonly loop: AgentLoop;
  readonly renderer: TurnRenderer;
  /**
   * A plain string, read once per call.
   *
   * The REPL's attachment moves — `/new`, `/session` and `/branch` all change
   * it — but that is the caller's problem: the closure in `chatCommand` reads
   * its holder at call time, so this stays the tested unit it was.
   */
  readonly sessionKey: string;
  /** Where a session *created* by this turn lands. Never moves an existing one. */
  readonly workspaceId?: string | undefined;
  readonly signal: AbortSignal;
  /** Raw event JSON instead of prose, for scripts consuming the stream. */
  readonly json?: NodeJS.WritableStream | undefined;
}

/**
 * One turn, rendered.
 *
 * Separate from all three drivers because it is the whole of what the CLI does
 * with the event stream, and a test can hand it a loop and a string buffer
 * without a terminal, a database or a provider.
 */
export async function runTurn(
  deps: RunTurnDeps,
  content: string | readonly ContentPart[],
): Promise<TurnOutcome> {
  const { renderer } = deps;
  let failed = false;
  // The generator's return value is unreachable from `for await`, so the
  // outcome is read off `turn.end` — which is deliberately the same information
  // every other transport will have, rather than something only the CLI can see.
  let stopReason: StopReason | undefined;

  const turn = deps.loop.run({
    sessionKey: deps.sessionKey,
    content,
    signal: deps.signal,
    channel: 'cli',
    ...(deps.workspaceId === undefined ? {} : { workspaceId: deps.workspaceId }),
  });

  try {
    for await (const event of turn) {
      if (event.type === 'error') failed = true;
      if (event.type === 'turn.end') stopReason = event.stopReason;
      if (deps.json === undefined) renderer.handle(event);
      else deps.json.write(`${JSON.stringify(event)}\n`);
    }
  } catch (error) {
    // An abort unwinds the generator through its own `finally`; anything else
    // is a real failure and must not be reported as a completed turn.
    if (!isAbortError(error)) throw error;
    return { stopReason: 'aborted', aborted: true, failed: false };
  } finally {
    if (deps.json === undefined) renderer.finish();
  }

  // A stream that ended without `turn.end` is a broken loop, not a clean turn.
  const reason = stopReason ?? 'error';
  return {
    stopReason: reason,
    aborted: reason === 'aborted',
    failed: failed || reason === 'error',
  };
}

/** Everything piped in, for `ghost chat < prompt.txt`. */
async function readAll(input: NodeJS.ReadableStream): Promise<string> {
  const chunks: string[] = [];
  input.setEncoding('utf8');
  for await (const chunk of input) chunks.push(String(chunk));
  return chunks.join('');
}

export async function chatCommand(options: ChatOptions = {}): Promise<number> {
  const out = options.out ?? process.stdout;
  const input = options.input ?? process.stdin;
  // Holders, not constants: `/new`, `/session <key>` and `/branch` all move the
  // prompt to another conversation, and `/workspace` moves where the next new
  // one lands. The closures below read them at call time.
  let sessionKey = options.sessionKey ?? DEFAULT_SESSION_KEY;
  let workspaceId = options.workspaceId;
  const json = options.json === true ? out : undefined;

  const renderer = new TurnRenderer({
    out,
    ...(options.colors === undefined ? {} : { colors: options.colors }),
    ...(options.showReasoning === undefined ? {} : { showReasoning: options.showReasoning }),
  });

  // Logs go to stderr at `warn` by default. On stdout they would interleave
  // with the answer, and at `info` a local model's per-request lines would bury
  // it — so the CLI is quieter than the library default rather than the same.
  const logger =
    options.logger ??
    createLogger({
      name: 'ghost',
      level: options.logLevel ?? 'warn',
      destination: options.errOut ?? process.stderr,
    });

  const runtime = createChatRuntime({ ...options, logger });
  if (options.fresh === true) runtime.store.clearMessages(sessionKey);

  // One controller per turn, replaced each time: an `AbortController` cannot be
  // reset, so reusing an aborted one would make every later turn stop before its
  // first iteration.
  let active: AbortController | null = null;
  const onInterrupt = (): void => {
    active?.abort();
  };
  if (options.handleSignals !== false) process.on('SIGINT', onInterrupt);

  const turn = async (content: string | readonly ContentPart[]): Promise<TurnOutcome> => {
    const controller = new AbortController();
    active = controller;
    try {
      return await runTurn(
        // `requireLoop` rather than `loop`: an unconfigured install builds a
        // runtime with no loop so that `ghost serve` can come up, and this is
        // the one caller that genuinely cannot proceed without one. The message
        // it throws names what to set.
        {
          loop: runtime.requireLoop(),
          renderer,
          sessionKey,
          signal: controller.signal,
          json,
          ...(workspaceId === undefined ? {} : { workspaceId }),
        },
        content,
      );
    } finally {
      active = null;
    }
  };

  try {
    // A message argument, then anything piped in. A REPL on a stdin that is not
    // a terminal would read its first line as a question and then see EOF.
    const oneShot = options.message ?? (input.isTTY === true ? undefined : await readAll(input));
    if (oneShot !== undefined) {
      const content = oneShot.trim();
      if (content === '') return 0;
      const outcome = await turn(content);
      if (outcome.aborted) return SIGINT_EXIT_CODE;
      return outcome.failed ? 1 : 0;
    }

    if (json === undefined) {
      renderer.note(
        `ghost · ${runtime.model} @ ${runtime.spec?.displayName ?? 'no provider'} · ${runtime.paths.workspace}`,
      );
      const opened = runtime.store.getSession(sessionKey);
      const title = opened === undefined || opened.title === '' ? sessionKey : opened.title;
      renderer.note(`${title} · /help for commands`);
    }

    return await repl({
      input,
      out,
      renderer,
      runtime,
      session: () => sessionKey,
      attach: (key) => {
        sessionKey = key;
        runtime.store.ensureSession(key, { origin: 'cli' });
        renderer.note(`attached to ${key}`);
      },
      workspace: () => workspaceId,
      setWorkspace: (id) => {
        workspaceId = id;
      },
      turn,
      hasActiveTurn: () => active !== null,
      abortActive: onInterrupt,
    });
  } finally {
    if (options.handleSignals !== false) process.off('SIGINT', onInterrupt);
    runtime.close();
  }
}

interface ReplDeps {
  readonly input: InputStream;
  readonly out: NodeJS.WritableStream;
  readonly renderer: TurnRenderer;
  readonly runtime: ChatRuntime;
  /** The conversation the prompt is on, read fresh — it moves. */
  readonly session: () => string;
  readonly attach: (sessionKey: string) => void;
  readonly workspace: () => string | undefined;
  readonly setWorkspace: (id: string | undefined) => void;
  readonly turn: (content: string | readonly ContentPart[]) => Promise<TurnOutcome>;
  readonly hasActiveTurn: () => boolean;
  readonly abortActive: () => void;
}

/**
 * The prompt loop.
 *
 * `question` is given an `AbortSignal` rather than being cancelled with
 * `rl.close()`: closing a readline interface while a question is pending leaves
 * that promise unsettled forever, so the process would hang on the very Ctrl-C
 * meant to end it.
 */
async function repl(deps: ReplDeps): Promise<number> {
  const rl = createInterface({
    input: deps.input,
    output: deps.out,
    terminal: deps.input.isTTY === true,
  });

  const prompt = new AbortController();
  const onSigint = (): void => {
    // While a turn runs, Ctrl-C belongs to the turn. At an idle prompt it means
    // "leave", which is what aborting the pending question does.
    if (deps.hasActiveTurn()) deps.abortActive();
    else prompt.abort();
  };
  rl.on('SIGINT', onSigint);

  try {
    for (;;) {
      let line: string;
      try {
        line = await rl.question('\n› ', { signal: prompt.signal });
      } catch (error) {
        // Ctrl-C at the prompt, or Ctrl-D closing stdin. Both mean "done".
        if (isAbortError(error)) return 0;
        throw error;
      }

      const content = line.trim();
      if (content === '') continue;
      if (content.startsWith('/')) {
        const result = await runSlashCommand(content, {
          renderer: deps.renderer,
          runtime: deps.runtime,
          sessionKey: deps.session(),
          workspaceId: deps.workspace(),
          setWorkspace: deps.setWorkspace,
        });

        if (result.kind === 'exit') return 0;
        if (result.kind === 'attach') {
          deps.attach(result.sessionKey);
          continue;
        }
        // `/edit` and `/regenerate` truncated, and handed the content back
        // rather than running it — so a re-run takes the same path a typed
        // message does, with the same renderer and the same Ctrl-C.
        if (result.kind === 'continue') continue;

        const rerun = await deps.turn(result.content);
        if (rerun.aborted) deps.renderer.note('interrupted — the prompt is yours again');
        continue;
      }

      const outcome = await deps.turn(content);
      if (outcome.aborted) deps.renderer.note('interrupted — the prompt is yours again');
    }
  } finally {
    rl.off('SIGINT', onSigint);
    rl.close();
  }
}
