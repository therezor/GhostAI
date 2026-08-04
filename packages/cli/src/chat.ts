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

import { createInterface, type Interface } from 'node:readline/promises';

import { describeContext, type AgentLoop } from '@ghostai/agent';
import { createLogger, isAbortError, type LogLevel } from '@ghostai/core';
import {
  DEFAULT_AGENT_ID,
  type ContentPart,
  type StopReason,
} from '@ghostai/protocol';
import { findCredential } from '@ghostai/runtime';
import { agentForTurn } from '@ghostai/server';
import {
  columnsOf,
  openBottomBar,
  themeFor,
  type TerminalInput,
  type TerminalOutput,
  type Theme,
} from '@ghostai/tui';

import { runSlashCommand } from './commands.js';
import {
  startupHeader,
  statusBar,
  type ContextUsage,
  type HeaderView,
} from './header.js';
import { completeCommand, pickCommand } from './pickers/palette.js';
import { translationsFor, type CliT, type Env } from './i18n.js';
import { createMenu, menuAvailable, NO_MENU, type Menu } from './menu.js';
import { createModelCatalogue, type ModelCatalogue } from './models.js';
import { TurnRenderer } from './render.js';
import {
  createChatRuntime,
  type ChatRuntime,
  type RuntimeOptions,
} from './runtime.js';

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
  /**
   * Which agent a conversation *started* by this run is bound to.
   *
   * A preference, exactly as `workspaceId` is: it decides the binding of a
   * session that does not exist yet and never moves one that does. `/agent <id>`
   * is the explicit edit — see `agentForTurn`, whose rule this defers to.
   */
  readonly agentId?: string | undefined;
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
  /**
   * The environment the locale is read from, injected rather than read.
   *
   * The same reasoning as `InitOptions.env` and `ServeOptions.env`: a test that
   * has to mutate `process.env` to pick a language is a test that cannot run
   * beside another one.
   */
  readonly env?: Env;
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
  /**
   * Which agent a session *created* by this turn is bound to.
   *
   * `AgentLoop.ensureSession` applies the same stored-wins rule one layer down,
   * so passing it here cannot move an existing conversation — but the caller
   * has to pick the matching *loop*, or the turn would run on one agent's
   * settings and be prompted with another's.
   */
  readonly agentId?: string | undefined;
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
    ...(deps.workspaceId === undefined
      ? {}
      : { workspaceId: deps.workspaceId }),
    ...(deps.agentId === undefined ? {} : { agentId: deps.agentId }),
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
  let agentId = options.agentId;
  const json = options.json === true ? out : undefined;

  // Before the runtime, so `--help`-speed paths never build one; the locale it
  // renders in is refined below once the config can be read.
  const envLang = translationsFor(options.env ?? process.env);
  const renderer = new TurnRenderer({
    out,
    t: envLang.t,
    ...(options.colors === undefined ? {} : { colors: options.colors }),
    ...(options.showReasoning === undefined
      ? {}
      : { showReasoning: options.showReasoning }),
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

  // After the runtime, because this is the first point the install's own answer
  // exists — `config.ui.locale` sits under `GHOSTAI_LANG` and above the shell's
  // `LANG` in the order `resolveCliLocale` applies.
  const lang = translationsFor(
    options.env ?? process.env,
    runtime.config.ui.locale,
  );

  // One controller per turn, replaced each time: an `AbortController` cannot be
  // reset, so reusing an aborted one would make every later turn stop before its
  // first iteration.
  let active: AbortController | null = null;
  const onInterrupt = (): void => {
    active?.abort();
  };
  if (options.handleSignals !== false) process.on('SIGINT', onInterrupt);

  /**
   * The same catalogue `ghost serve` offers its settings panel.
   *
   * Built here rather than reached for through the server port, which would
   * mean constructing a Fastify-shaped object with credential writes and
   * toolbox approvals on it to answer one question. Nothing is dialled until
   * `/model` asks.
   */
  const models: ModelCatalogue = createModelCatalogue(runtime, {
    credentialFor: (instance) =>
      findCredential(
        instance,
        runtime.paths,
        options.env ?? process.env,
        options.vault,
      ),
    ...(options.fetchImpl === undefined
      ? {}
      : { fetchImpl: options.fetchImpl }),
  });

  const resolves = (id: string): boolean =>
    runtime.agents.some((agent) => agent.id === id);

  /**
   * The same precedence `agentForThisTurn` applies, without the warning.
   *
   * That one says so when a stored agent has been deleted, which is right once
   * per turn and wrong every time a prompt is redrawn — and the prompt is
   * redrawn on every keystroke.
   */
  const agentForTurnQuietly = (): string =>
    agentForTurn({
      stored: runtime.store.getSession(sessionKey)?.agentId,
      requested: agentId,
      resolves,
    }) ?? DEFAULT_AGENT_ID;

  /**
   * Which agent this turn runs on.
   *
   * `agentForTurn` is the hub's rule, imported rather than restated: the stored
   * session wins over the flag, because a history built under one agent's
   * prompt, tools and permissions must not silently continue under another's.
   *
   * The fallback below is not optional. `agentForTurn` returns the *stored* id
   * when neither it nor the request resolves, and `requireLoopFor` throws for an
   * id that names nothing runnable — so without this, deleting an agent from
   * `config.json` would turn a working conversation into a hard failure on its
   * next turn. The default runs it instead, and says so every time, because
   * nothing is written down to make the substitution stick.
   */
  const agentForThisTurn = (): string | undefined => {
    const chosen = agentForTurn({
      stored: runtime.store.getSession(sessionKey)?.agentId,
      requested: agentId,
      resolves,
    });
    if (chosen === undefined || resolves(chosen)) return chosen;
    renderer.warn(lang.t('chat.agentGone', { agent: chosen }));
    return undefined;
  };

  const turn = async (
    content: string | readonly ContentPart[],
  ): Promise<TurnOutcome> => {
    const controller = new AbortController();
    active = controller;
    const chosen = agentForThisTurn();
    try {
      return await runTurn(
        // `requireLoopFor` rather than `loop`: an unconfigured install builds a
        // runtime with no loop so that `ghost serve` can come up, and this is
        // the one caller that genuinely cannot proceed without one. The message
        // it throws names what to set.
        {
          loop: runtime.requireLoopFor(chosen),
          renderer,
          sessionKey,
          signal: controller.signal,
          json,
          ...(workspaceId === undefined ? {} : { workspaceId }),
          ...(chosen === undefined ? {} : { agentId: chosen }),
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
    const oneShot =
      options.message ??
      (input.isTTY === true ? undefined : await readAll(input));
    if (oneShot !== undefined) {
      const content = oneShot.trim();
      if (content === '') return 0;
      const outcome = await turn(content);
      if (outcome.aborted) return SIGINT_EXIT_CODE;
      return outcome.failed ? 1 : 0;
    }

    // `TerminalOutput` and `TerminalInput` add only optional members to the
    // stream interfaces these already are, so a plain pipe satisfies both — and
    // `menuAvailable` is what decides whether the extras are actually there.
    const terminal: TerminalOutput = out;
    const keyboard: TerminalInput = input;
    const theme: Theme = themeFor(options.colors);
    const menus = menuAvailable({
      input: keyboard,
      output: terminal,
      json: json !== undefined,
      env: options.env ?? process.env,
    });

    /**
     * What the last turn left in the window.
     *
     * Measured after a turn rather than on every repaint, and that is exact
     * rather than a saving: the context only changes when the history does, and
     * the history only changes when a turn runs. Tokenising the whole
     * conversation on every keystroke would buy the same number at a cost
     * nobody would forgive.
     */
    let context: ContextUsage | undefined;
    const measureContext = async (): Promise<void> => {
      const loop = runtime.loopFor(agentForTurnQuietly());
      if (loop === null) return;
      try {
        const report = await describeContext({
          store: runtime.store,
          loop,
          tools: runtime.tools.definitions(),
          sessionKey,
          channel: 'cli',
          contextWindowTokens:
            runtime.config.agents.defaults.contextWindowTokens,
        });
        context =
          report === undefined
            ? undefined
            : {
                usedTokens: report.estimatedTokens,
                windowTokens: report.contextWindowTokens,
              };
      } catch {
        // A measurement is a nicety. An install whose tokenizer or history
        // upsets it should still get a prompt, and the bar simply says nothing
        // about the context until the next turn.
        context = undefined;
      }
    };

    /**
     * Read fresh every time: all of these move.
     *
     * Deliberately *not* `agentForThisTurn`. That one warns when a stored agent
     * has been deleted, and this is called to redraw a prompt — so borrowing it
     * would print the same notice every time the operator pressed Return on an
     * empty line. The same precedence, without the side effect.
     */
    const view = (): HeaderView => {
      const opened = runtime.store.getSession(sessionKey);
      const id = agentForTurnQuietly();
      const where = opened?.workspaceId ?? workspaceId;
      return {
        agent: runtime.agents.find((one) => one.id === id)?.label ?? id,
        model: runtime.model,
        provider: runtime.spec?.displayName ?? lang.t('chat.noProvider'),
        workspace: runtime.paths.workspace,
        workspaceName:
          where === undefined
            ? lang.t('chat.noWorkspace')
            : (runtime.workspaces.get(where)?.name ?? where),
        session:
          opened === undefined || opened.title === ''
            ? sessionKey
            : opened.title,
        context,
      };
    };

    if (json === undefined) {
      renderer.note(
        startupHeader(view(), columnsOf(terminal), theme, lang.t, menus),
      );
    }

    return await repl({
      input,
      out,
      renderer,
      runtime,
      t: lang.t,
      locale: lang.locale,
      theme,
      menus,
      processHooks: options.handleSignals !== false,
      // A blank line and the caret, and nothing else. The rule that used to sit
      // above the editor is gone: a prompt string is the one part of the frame
      // written *into* the scrollback, so it stayed behind after every turn and
      // the transcript grew a separator between every pair of messages. Taking
      // it back afterwards meant counting rows through readline's own wrapping,
      // and counting wrong blanked a line of the conversation. The rule below
      // the editor is drawn by the bar, is transient by construction, and says
      // the same thing.
      prompt: () => '\n› ',
      // One column short of the window. Writing exactly `columns` characters
      // leaves a terminal in a pending-wrap state that different emulators
      // resolve differently, and every row here is followed by cursor motion
      // that assumes it knows which row it is on.
      status: () => statusBar(view(), columnsOf(terminal) - 1, theme),
      measure: measureContext,
      session: () => sessionKey,
      attach: (key) => {
        sessionKey = key;
        runtime.store.ensureSession(key, { origin: 'cli' });
        renderer.note(lang.t('chat.attachedTo', { key }));
      },
      workspace: () => workspaceId,
      setWorkspace: (id) => {
        workspaceId = id;
      },
      agent: () => agentId,
      setAgent: (id) => {
        agentId = id;
      },
      models,
      modelPinned: options.model !== undefined,
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
  readonly t: CliT;
  readonly locale: string;
  readonly theme: Theme;
  /** Whether this terminal can draw a menu at all. */
  readonly menus: boolean;
  /** Whether this run may register handlers on the process. */
  readonly processHooks: boolean;
  /** Built fresh each iteration, so the prompt follows the state. */
  readonly prompt: () => string;
  /** The rows drawn under the editor, rebuilt whenever the state moves. */
  readonly status: () => string[];
  /** Re-measures the context window. Awaited after a turn, never before a key. */
  readonly measure: () => Promise<void>;
  /** The conversation the prompt is on, read fresh — it moves. */
  readonly session: () => string;
  readonly attach: (sessionKey: string) => void;
  readonly workspace: () => string | undefined;
  readonly setWorkspace: (id: string | undefined) => void;
  readonly agent: () => string | undefined;
  readonly setAgent: (id: string | undefined) => void;
  readonly models: ModelCatalogue;
  /** Whether `--model` pinned the model for this process. */
  readonly modelPinned: boolean;
  readonly turn: (
    content: string | readonly ContentPart[],
  ) => Promise<TurnOutcome>;
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
    // Tab over the same table `/help` prints, and only for a line that starts
    // with a slash: the rest of a prompt is prose, and a completer that guessed
    // at the middle of a sentence would surprise far more often than it helped.
    completer: completeCommand,
  });

  // Built here rather than in `chatCommand` because it needs the interface it
  // suspends, and this is where that interface exists. Everything that is not a
  // terminal gets `NO_MENU`, so no caller below has to remember an `if`.
  const menu = deps.menus
    ? createMenu({
        input: deps.input,
        output: deps.out,
        rl,
        theme: deps.theme,
        // The same flag that governs the SIGINT handler, and for the same
        // reason: a run that does not own the process must not leave handlers
        // on it. A suite that opened ten REPLs would otherwise accumulate ten.
        ...(deps.processHooks
          ? {}
          : {
              onExit: (): void => {
                /* nothing to unwind: this run installed no handlers */
              },
            }),
      })
    : NO_MENU;

  const status = bindStatus({
    input: deps.input,
    output: deps.out,
    rl,
    menus: deps.menus,
    prompt: deps.prompt,
    status: deps.status,
  });

  const offPalette = bindPalette({
    input: deps.input,
    rl,
    menu,
    t: deps.t,
    busy: deps.hasActiveTurn,
    // A menu draws over the bar's rows and erases them on the way out, and the
    // bar is not repainted while readline is detached — so without this the
    // status stays blank until the next keystroke.
    onClose: () => {
      status.repaint();
    },
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
        line = await status.ask((text) =>
          rl.question(text, { signal: prompt.signal }),
        );
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
          t: deps.t,
          locale: deps.locale,
          sessionKey: deps.session(),
          workspaceId: deps.workspace(),
          setWorkspace: deps.setWorkspace,
          agentId: deps.agent(),
          setAgent: deps.setAgent,
          menu,
          models: deps.models,
          modelPinned: deps.modelPinned,
        });

        if (result.kind === 'exit') return 0;
        if (result.kind === 'attach') {
          deps.attach(result.sessionKey);
          // A different conversation is a different context.
          await deps.measure();
          continue;
        }
        // `/clear` and `/branch` change the history without running a turn.
        if (result.kind === 'continue') {
          await deps.measure();
          continue;
        }
        // `/edit` and `/regenerate` truncated, and handed the content back
        // rather than running it — so a re-run takes the same path a typed
        // message does, with the same renderer and the same Ctrl-C.
        const rerun = await deps.turn(result.content);
        if (rerun.aborted) deps.renderer.note(deps.t('chat.interrupted'));
        await deps.measure();
        continue;
      }

      const outcome = await deps.turn(content);
      if (outcome.aborted) deps.renderer.note(deps.t('chat.interrupted'));
      // After the turn, never before a keystroke: the context only changes when
      // the history does, so measuring here is both the cheap answer and the
      // exact one.
      await deps.measure();
    }
  } finally {
    status.close();
    offPalette();
    rl.off('SIGINT', onSigint);
    rl.close();
  }
}

interface StatusBinding {
  /** Runs one prompt with the bar under it, and erases it afterwards. */
  ask(question: (prompt: string) => Promise<string>): Promise<string>;
  /** Redraws the bar, for a caller that has just drawn over it. */
  repaint(): void;
  close(): void;
}

interface StatusOptions {
  readonly input: InputStream;
  readonly output: NodeJS.WritableStream;
  /** Asked where its cursor is, so the frame's top rule can be taken back. */
  readonly rl: Interface;
  /** The same predicate the menu uses: is this an interactive terminal. */
  readonly menus: boolean;
  readonly prompt: () => string;
  readonly status: () => string[];
}

/**
 * The status rows under the editor, and the prompt they sit under.
 *
 * Three things have to happen in order, and the order is the whole of it:
 *
 *  1. **Reserve, before the prompt is written.** A transcript grows, so the
 *     prompt keeps arriving at the bottom of the screen; without pushing it up
 *     first the bar would be drawn over the line the operator is typing on.
 *  2. **Paint, after the prompt is written.** `rl.question` writes
 *     synchronously and then returns a promise, so the paint goes between the
 *     call and the `await`.
 *  3. **Repaint after every keystroke**, on a listener *appended* rather than
 *     prepended: readline's line refresh clears from the prompt row to the end
 *     of the display, which is exactly where the bar is, and it does that
 *     synchronously inside its own handler. Running before it would paint a bar
 *     that readline then erased.
 *
 * Everything that is not an interactive terminal gets a binding that does none
 * of it and simply asks the question, so no caller below has to check.
 */
function bindStatus(options: StatusOptions): StatusBinding {
  // `TerminalOutput` adds only optional members to the stream this already is,
  // so a pipe satisfies it — and `available` is what decides whether the extras
  // were actually there.
  const output: TerminalOutput = options.output;
  const bar = options.menus ? openBottomBar({ output }) : undefined;

  if (bar?.available !== true) {
    return {
      ask: async (question) => await question(options.prompt()),
      repaint: (): void => {
        /* there is no bar to redraw */
      },
      close: (): void => {
        /* nothing was drawn */
      },
    };
  }

  let lines: string[] = [];
  let asking = false;
  /** How many rows the prompt occupies before the editor's own row. */
  let promptRows = 0;

  const repaint = (): void => {
    if (!asking) return;
    const at = options.rl.getCursorPos();

    // A typed line long enough to wrap needs rows the reservation did not
    // account for, and from then on readline and the bar compete for them:
    // readline redraws from its own prompt row downward, the bar draws below
    // the cursor, and a scroll under either one leaves the other a row out.
    // What that looked like was a message losing its second and third lines.
    // Standing aside while the line is wrapped is the only version of this
    // that cannot damage the transcript, and the bar comes back the moment the
    // line fits again or the turn is sent.
    if (at.rows > promptRows) {
      bar.clear();
      return;
    }
    bar.paint(lines, at.cols);
  };
  /**
   * Every key except the one that submits.
   *
   * Return is the exception because readline has, by the time this runs, moved
   * the cursor to the row *below* the editor — which is the bar's first row.
   * Painting from there puts the bar one row lower than the erase that follows
   * expects, and the erase then starts from whatever column the paint left the
   * cursor in. What that looked like was two characters of the rule surviving
   * at the head of the turn's first line of output.
   */
  const onKeypress = (chunk: unknown, key?: { name?: string }): void => {
    if (key?.name === 'return') return;
    repaint();
  };

  // Appended: readline's refresh clears from the prompt row down, synchronously
  // inside its own handler, so a listener running before it would paint a bar
  // readline then erased.
  options.input.on('keypress', onKeypress);

  return {
    async ask(question): Promise<string> {
      const text = options.prompt();
      lines = options.status();

      // The prompt's own lines count too. Reserving only the bar's height
      // guarantees that many rows below the *cursor*, and the prompt then
      // writes its own lines beneath it — so the editor ends up inside the rows
      // the bar is about to claim, and the bar paints over it. That was the
      // first version of this bug.
      promptRows = text.split('\n').length - 1;
      bar.reserve(lines.length + promptRows + 1);

      const pending = question(text);
      asking = true;
      bar.paint(lines, options.rl.getCursorPos().cols);
      try {
        return await pending;
      } finally {
        asking = false;
        bar.clear();
      }
    },
    repaint,
    close(): void {
      asking = false;
      options.input.off('keypress', onKeypress);
      bar.close();
    },
  };
}

interface PaletteBinding {
  readonly input: InputStream;
  readonly rl: Interface;
  readonly menu: Menu;
  readonly t: CliT;
  /** Whether a turn is running, in which case the key belongs to nobody. */
  readonly busy: () => boolean;
  /** Called once the palette has closed, whatever it answered. */
  readonly onClose: () => void;
}

/**
 * Ctrl-G opens the command palette. Returns the unbind.
 *
 * **Ctrl-G, and not Ctrl-L or Ctrl-A.** readline owns almost the whole control
 * alphabet — Ctrl-A and Ctrl-E move the cursor, Ctrl-L clears the screen, Ctrl-U
 * and Ctrl-K kill, Ctrl-R searches, Ctrl-C and Ctrl-D end things. Probing a live
 * interface for keys that leave `rl.line` and `rl.cursor` untouched leaves
 * exactly three: Ctrl-G, Ctrl-O and Ctrl-X. That is the entire budget, so it
 * buys *one* binding — a palette, which contains every command — rather than
 * three feature-specific ones.
 *
 * `prependListener` because readline's own handler is already attached and an
 * EventEmitter has no cancellation: prepending gets this one called *first*,
 * never *instead*. That is exactly why the key has to be one readline ignores.
 *
 * The chosen command is written into the pending `rl.question` rather than run
 * directly, so it flows through the same dispatcher a typed command does — one
 * path, one set of error handling. A cancelled palette puts the half-typed line
 * back where it was.
 */
function bindPalette(binding: PaletteBinding): () => void {
  const { input, rl, menu } = binding;
  if (!menu.available) {
    return (): void => {
      /* nothing was bound, so there is nothing to unbind */
    };
  }

  let open = false;

  const onKeypress = (
    chunk: unknown,
    key?: { name?: string; ctrl?: boolean },
  ) => {
    if (open || binding.busy()) return;
    if (key?.ctrl !== true || key.name !== 'g') return;

    open = true;
    const stash = rl.line;
    void (async (): Promise<void> => {
      try {
        const chosen = await pickCommand({ menu, t: binding.t });
        // Clear whatever was typed either way: the palette drew over the line,
        // and readline will redraw it from its own buffer.
        rl.write(null, { ctrl: true, name: 'u' });
        rl.write(chosen === undefined ? stash : chosen.command);
        if (chosen?.submit === true) rl.write(null, { name: 'return' });
      } finally {
        open = false;
        binding.onClose();
      }
    })();
  };

  input.prependListener('keypress', onKeypress);
  return () => {
    input.off('keypress', onKeypress);
  };
}
