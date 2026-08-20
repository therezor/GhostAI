/**
 * `ghostai chat` — a turn, or a conversation of them.
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

import { describeContext, type AgentLoop } from '@ghostwire/agent';
import {
  DEFAULT_WORKSPACE_ID,
  createLogger,
  isAbortError,
  type LogLevel,
} from '@ghostwire/core';
import {
  DEFAULT_AGENT_ID,
  type ContentPart,
  type StopReason,
} from '@ghostwire/protocol';
import { findCredential } from '@ghostwire/runtime';
import { findProvider } from '@ghostwire/providers';
import { agentForTurn } from '@ghostwire/server';
import {
  CHROME_ROWS,
  columnsOf,
  createEditor,
  createRenderer,
  createSelect,
  createTranscript,
  DEFAULT_MAX_ROWS,
  isCtrl,
  openKeyboard,
  paletteFor,
  spinnerFrame,
  themeFor,
  SPINNER_INTERVAL_MS,
  type Component,
  type Select,
  type TerminalInput,
  type TerminalOutput,
  type Theme,
} from '@ghostwire/tui';

import { commandRowsFor, runSlashCommand } from './commands.js';
import {
  inputRule,
  startupHeader,
  statusBar,
  type ContextUsage,
  type HeaderView,
} from './header.js';
import { completeCommand, pickCommand } from './pickers/palette.js';
import { translationsFor, type CliT, type Env } from './i18n.js';
import { formatLogLine } from './log-line.js';
import {
  createMenu,
  menuAvailable,
  NO_MENU,
  type Menu,
  type MenuRequest,
} from './menu.js';
import { createModelCatalogue, type ModelCatalogue } from './models.js';
import { TurnRenderer } from './render.js';
import {
  createChatRuntime,
  settingsOf,
  type ChatRuntime,
  type RuntimeOptions,
} from './runtime.js';

/** Conventional exit code for "terminated by SIGINT". */
export const SIGINT_EXIT_CODE = 130;

const DEFAULT_SESSION_KEY = 'cli:default';

/** Node's stdin, narrowed to what the REPL needs to know about it. */
type InputStream = NodeJS.ReadableStream & { isTTY?: boolean };

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

interface RunTurnDeps {
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

/** Everything piped in, for `ghostai chat < prompt.txt`. */
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
  // A sink the turn can take over. `TurnRenderer` is untouched and knows
  // nothing about a footer: while a turn runs, its writes go through the bar so
  // that the editor and the status stay put underneath them.
  let sink: ((text: string) => void) | undefined;
  const target = {
    write: (text: string): void => {
      if (sink === undefined) out.write(text);
      else sink(text);
    },
  };

  const renderer = new TurnRenderer({
    out: target,
    t: envLang.t,
    ...(options.colors === undefined ? {} : { colors: options.colors }),
    ...(options.showReasoning === undefined
      ? {}
      : { showReasoning: options.showReasoning }),
  });

  // The renderer keeps its own palette private, so this is a second one built
  // from the same flag. `paletteFor(false)` is the identity, which is what
  // makes `--no-color` and `NO_COLOR` one branch here rather than two — and
  // `undefined` is what lets picocolors answer for itself, which is the whole
  // point of the flag no longer defaulting to `true`.
  const logColors = paletteFor(options.colors);

  // Logs go to stderr at `warn` by default. On stdout they would interleave
  // with the answer, and at `info` a local model's per-request lines would bury
  // it — so the CLI is quieter than the library default rather than the same.
  // Diagnostics go through the footer too, when they are going to the same
  // terminal. A pino line written straight to the fd lands wherever the cursor
  // is, which while a turn is streaming is the middle of the status bar — and
  // the bar has no idea it happened, so the damage stays on screen. Only when
  // stderr *is* this terminal: a redirected stderr belongs in its file, not
  // interleaved into stdout.
  const errOut = options.errOut ?? process.stderr;
  const shareTerminal = (errOut as { isTTY?: boolean }).isTTY === true;
  const logTarget = {
    write: (text: string): boolean => {
      // A redirected stderr keeps the JSON: the thing reading it then is a
      // program, and `ghostai chat 2>chat.log | jq` has to keep working.
      if (sink === undefined || !shareTerminal) return errOut.write(text);
      // Through the renderer rather than straight at the sink, because only it
      // knows whether a line is half-written — and a log line arriving in the
      // middle of one splices itself into a word.
      renderer.aside(formatLogLine(text, logColors));
      return true;
    },
  } as unknown as NodeJS.WritableStream;

  const logger =
    options.logger ??
    createLogger({
      name: 'ghost',
      // `error`, where `serve` uses `info`. A warning here is worth reading and
      // worth acting on, but this is the one surface where it interrupts a
      // conversation to say something about the install rather than about the
      // answer — and the ones that recur do so on *every turn*, because the
      // catalogue they warn about is re-read on every turn. `--verbose` brings
      // them back, now legible.
      level: options.logLevel ?? 'error',
      destination: logTarget,
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
   * The same catalogue `ghostai serve` offers its settings panel.
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
        // runtime with no loop so that `ghostai serve` can come up, and this is
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
      const id = agentForTurnQuietly();
      const loop = runtime.loopFor(id);
      if (loop === null) return;
      try {
        const report = await describeContext({
          store: runtime.store,
          loop,
          tools: runtime.tools.definitions(),
          sessionKey,
          channel: 'cli',
          // This agent's budget, not the install's. There is no install-wide
          // one to fall back to: a window is a property of the model, and the
          // model is a property of the agent.
          contextWindowTokens: settingsOf(runtime, id).contextWindowTokens,
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
      /**
       * Falls through to `default`, and the last step is the point.
       *
       * Nothing is stored until the first message, so `getSession` is
       * `undefined` on a prompt nobody has typed into yet — and without a third
       * fallback the bar said `no workspace`, which reports a state the store
       * cannot hold. `sessions.workspace_id` is `NOT NULL DEFAULT 'default'`
       * and `WorkspaceStore` seeds that row on construction, so the session is
       * going to land in `Default` the moment it exists. The browser already
       * says so — `workspace-context.tsx` falls back to the same constant — and
       * two surfaces of one install disagreeing about which workspace you are
       * in is worse than either answer.
       */
      const where = opened?.workspaceId ?? workspaceId ?? DEFAULT_WORKSPACE_ID;
      const agent = runtime.agents.find((one) => one.id === id);
      /**
       * This conversation's agent, not the install's.
       *
       * `runtime.model` and `runtime.spec` describe the *default* agent, and
       * the line above names the session's — so on a conversation moved onto
       * another agent they would disagree, and the bar would report one agent's
       * label over another's model.
       *
       * Off the loop rather than through a fresh resolve: `loopFor` hits the
       * `LoopCache`, while `resolveProvider` opens the credential vault — and
       * opening the vault can mint a keychain entry, which is far too much to
       * do to redraw a status bar on every keystroke. `loopFor` throws for an
       * id that names nothing runnable; `agentForTurnQuietly` has already
       * ruled that out.
       */
      const loop = runtime.loopFor(id);
      // `AgentLoop.provider` is the *spec* id — `ollama`, not the instance —
      // so this is the same lookup `runtime.spec` does, asked about this
      // agent's loop instead of the default one's.
      const spec = loop === null ? null : findProvider(loop.provider);
      return {
        agent: agent?.label ?? id,
        model: loop?.model ?? agent?.settings.model ?? '',
        provider:
          spec?.displayName ?? loop?.provider ?? lang.t('chat.noProvider'),
        workspace: runtime.paths.workspace,
        workspaceName: runtime.workspaces.get(where)?.name ?? where,
        session:
          opened === undefined || opened.title === ''
            ? sessionKey
            : opened.title,
        context,
      };
    };

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
      // Built at the width the renderer asks for, not at the width the stream
      // reported when the frame was last drawn. That is the difference between
      // a status bar and a status bar that survives a resize: the renderer
      // re-renders at the new width and every row is rebuilt for it.
      header: () =>
        startupHeader(view(), columnsOf(terminal), theme, lang.t, menus),
      status: (width) => statusBar(view(), width, theme),
      inputRule: (width) => inputRule(width, theme),
      measure: measureContext,
      setSink: (next) => {
        sink = next;
      },
      echo: (content) => {
        renderer.echo(content);
      },
      // `unref` so an animation frame never keeps the process alive: a turn
      // that ends between two ticks must not leave `ghostai` running.
      ticker: (tick) => {
        const timer = setInterval(tick, SPINNER_INTERVAL_MS);
        timer.unref();
        return () => {
          clearInterval(timer);
        };
      },
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
  /** The banner, written into the transcript once the frame owns the screen. */
  readonly header: () => string;
  /** The rule above the editor, at whatever width the frame is being drawn at. */
  readonly inputRule: (width: number) => string;
  /** The rows drawn under the editor, rebuilt whenever the state moves. */
  readonly status: (width: number) => string[];
  /** Re-measures the context window. Awaited after a turn, never before a key. */
  readonly measure: () => Promise<void>;
  /** Routes `TurnRenderer`'s writes through the footer for the turn's duration. */
  readonly setSink: (sink: ((text: string) => void) | undefined) => void;
  /** Prints the message into the transcript, since the prompt block is gone. */
  readonly echo: (content: string) => void;
  /** Drives the generating indicator. Injected so tests need no wall clock. */
  readonly ticker: (tick: () => void) => () => void;
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
 * What the prompt loop talks to, so that it does not have to know which one it
 * got.
 *
 * There are two, and the difference is whether the output is a terminal. On one
 * it is the frame below; on a pipe it is a prompt and a newline, because
 * escape sequences written into a file are not a status bar, they are noise in
 * somebody's log.
 */
interface Surface {
  readonly menu: Menu;
  /** Blocks until a line is submitted, or `undefined` to leave. */
  next(): Promise<string | undefined>;
  /** Runs the turn, with whatever the surface shows while one is running. */
  run(body: () => Promise<TurnOutcome>): Promise<TurnOutcome>;
  /** Something changed that the surface draws. */
  refresh(): void;
  close(): void;
}

/**
 * The prompt loop.
 *
 * Everything about *what* a line means lives here — a slash command, a message,
 * a re-run — and everything about how it is drawn lives in the surface. That
 * split is what lets a piped stdout keep working unchanged while the terminal
 * gets a frame.
 */
async function repl(deps: ReplDeps): Promise<number> {
  const surface = deps.menus ? framed(deps) : plain(deps);

  try {
    for (;;) {
      const line = await surface.next();
      if (line === undefined) return 0;

      const content = line.trim();
      if (content === '') continue;
      deps.echo(content);
      surface.refresh();

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
          menu: surface.menu,
          models: deps.models,
          modelPinned: deps.modelPinned,
        });

        if (result.kind === 'exit') return 0;
        if (result.kind === 'attach') {
          deps.attach(result.sessionKey);
          // A different conversation is a different context.
          await deps.measure();
          surface.refresh();
          continue;
        }
        // `/clear` and `/branch` change the history without running a turn.
        if (result.kind === 'continue') {
          await deps.measure();
          surface.refresh();
          continue;
        }
        // `/edit` and `/regenerate` truncated, and handed the content back
        // rather than running it — so a re-run takes the same path a typed
        // message does, with the same renderer and the same Ctrl-C.
        const rerun = await surface.run(
          async () => await deps.turn(result.content),
        );
        if (rerun.aborted) deps.renderer.note(deps.t('chat.interrupted'));
        await deps.measure();
        surface.refresh();
        continue;
      }

      const outcome = await surface.run(async () => await deps.turn(content));
      if (outcome.aborted) deps.renderer.note(deps.t('chat.interrupted'));
      // After the turn, never before a keystroke: the context only changes when
      // the history does, so measuring here is both the cheap answer and the
      // exact one.
      await deps.measure();
      surface.refresh();
    }
  } finally {
    surface.close();
  }
}

/**
 * Lines in, lines out, for a stdout that is not a terminal.
 *
 * `ghostai chat > log` and `ghostai chat | tee` still open a prompt, because stdin
 * is still a keyboard — but nothing here moves a cursor. There is no frame, no
 * status bar and no menu, and `NO_MENU` is what makes that last part a property
 * of the type rather than an `if` at every call site.
 */
function plain(deps: ReplDeps): Surface {
  const keyboard = openKeyboard({ input: deps.input, raw: false });
  const queued: string[] = [];
  let pendingLine = '';
  let waiting: ((line: string | undefined) => void) | undefined;
  let leaving = false;

  const deliver = (line: string | undefined): void => {
    if (waiting === undefined) {
      if (line !== undefined) queued.push(line);
      return;
    }
    const resume = waiting;
    waiting = undefined;
    resume(line);
  };

  keyboard.onKey((key) => {
    if (isCtrl(key, 'c') || isCtrl(key, 'd')) {
      if (deps.hasActiveTurn() && isCtrl(key, 'c')) deps.abortActive();
      else {
        leaving = true;
        deliver(undefined);
      }
      return;
    }
    if (key.name === 'enter') {
      const line = pendingLine;
      pendingLine = '';
      deliver(line);
      return;
    }
    if (key.name === 'backspace') pendingLine = pendingLine.slice(0, -1);
    else if (key.name === 'char' && !key.ctrl) pendingLine += key.char;
  });

  deps.out.write(deps.header());

  return {
    menu: NO_MENU,
    async next(): Promise<string | undefined> {
      const held = queued.shift();
      if (held !== undefined) return held;
      if (leaving) return undefined;
      deps.out.write('\n› ');
      return await new Promise<string | undefined>((resolve) => {
        waiting = resolve;
      });
    },
    async run(body): Promise<TurnOutcome> {
      return await body();
    },
    refresh(): void {
      /* nothing on this surface is drawn twice */
    },
    close(): void {
      keyboard.stop();
    },
  };
}

/**
 * The frame, on a terminal.
 *
 *     …the conversation so far…
 *     (blank)
 *     ───────────────────────────────
 *     › what is being typed
 *     ───────────────────────────────
 *     Default                 default
 *     3.6%/66k          Ollama/qwen3
 *
 * There is no `readline` in it, and that is the substance of the change rather
 * than a detail of it. readline draws its own line, at a row it measured for
 * itself, by moving up over a row count it cached — and every one of those
 * numbers is invalidated by a resize before the process is told the window
 * moved. A frame with readline inside it is a frame nobody owns, which is why
 * resizing used to leave a stranded copy of the footer behind every time.
 *
 * Here one renderer owns all of it. A keystroke changes the editor row and the
 * renderer rewrites the editor row; a resize changes every row, and the
 * renderer prints the frame again at the new width — which it can only do
 * because the conversation is in the frame too.
 *
 * Three things fall out of that, all of them simplifications:
 *
 *  - **A menu is rows, not a mode.** It replaces the editor and the status
 *    while it is open and the same renderer draws it, so there is no region to
 *    open, no stdin to hand over and nothing to erase afterwards.
 *  - **A turn changes nothing structural.** The editor stays where it is,
 *    typing keeps working, and a message submitted while the answer streams is
 *    queued for the moment it finishes. What used to be a second editor for the
 *    duration of a turn is now the same frame with a spinner row in it.
 *  - **Ctrl-C is a key.** Raw mode delivers `0x03` rather than raising SIGINT,
 *    so one handler covers "stop this turn" and "leave" whether or not a menu
 *    happens to be open.
 */
function framed(deps: ReplDeps): Surface {
  const output: TerminalOutput = deps.out;
  // The frame takes the window on the way in, the way it already did on the
  // way through a resize. `framed` is only reached when `menuAvailable` has
  // already said both streams are a terminal, `TERM` is not `dumb` and the
  // window is at least twelve columns — so nothing that is not a terminal can
  // reach this, and `plain` writes no escapes at all.
  const frame = createRenderer({ output, clearOnFirstFrame: true });
  const transcript = createTranscript();
  const editor = createEditor({ theme: deps.theme });
  const keyboard = openKeyboard({ input: deps.input });

  /** The menu currently in the frame, and the promise it will answer. */
  let overlay:
    | {
        readonly select: Select<unknown>;
        readonly settle: (value: unknown) => void;
      }
    | undefined;
  /** Spinner frame while a turn has said nothing yet; `undefined` once it has. */
  let thinking: number | undefined;
  let stopTicking: (() => void) | undefined;

  const queued: string[] = [];
  let waiting: ((line: string | undefined) => void) | undefined;
  let leaving = false;

  const menuRows = (): number =>
    Math.max(1, Math.min(DEFAULT_MAX_ROWS, frame.rows - CHROME_ROWS));

  const view: Component = {
    render(width: number): readonly string[] {
      const rows = [...transcript.render(width)];
      // One blank row between the conversation and the frame, always — the
      // transcript's last line may or may not have ended in a newline.
      if (!transcript.atLineStart) rows.push('');
      rows.push('');

      if (overlay !== undefined) {
        return [...rows, ...overlay.select.render(width)];
      }

      return [
        ...rows,
        ...(thinking === undefined
          ? []
          : [
              deps.theme.dim(
                `${spinnerFrame(thinking)} ${deps.t('chat.generating')}`,
              ),
            ]),
        deps.inputRule(width),
        ...editor.render(width),
        ...deps.status(width),
      ];
    },
  };

  frame.setRoot(view);

  const deliver = (line: string | undefined): void => {
    if (waiting === undefined) {
      if (line !== undefined) queued.push(line);
      return;
    }
    const resume = waiting;
    waiting = undefined;
    resume(line);
  };

  const menu: Menu = createMenu({
    open: <T>(request: MenuRequest<T>): Promise<T | undefined> =>
      new Promise<T | undefined>((resolve) => {
        overlay = {
          select: createSelect<T>({
            items: request.items,
            labels: request.labels,
            theme: deps.theme,
            ...(request.index === undefined ? {} : { index: request.index }),
            maxRows: menuRows(),
          }),
          settle: resolve as (value: unknown) => void,
        };
        frame.requestRender();
      }),
  });

  const openPalette = (): void => {
    void (async (): Promise<void> => {
      const chosen = await pickCommand({
        menu,
        t: deps.t,
        rows: commandRowsFor(deps.runtime),
      });
      if (chosen !== undefined) {
        if (chosen.submit) deliver(chosen.command);
        else editor.setText(chosen.command);
      }
      frame.requestRender();
    })();
  };

  keyboard.onKey((key) => {
    if (overlay !== undefined) {
      const outcome = overlay.select.handleKey(key);
      if (outcome.kind !== 'open') {
        const settle = overlay.settle;
        overlay = undefined;
        settle(outcome.kind === 'chosen' ? outcome.value : undefined);
      }
      frame.requestRender();
      return;
    }

    // Ctrl-G is the palette, and it is still the only shortcut. It was one
    // binding when readline owned all but three control keys, and there is no
    // reason to spend more now that it does not: the palette lists every
    // command, and every other control key means what a shell says it means.
    if (isCtrl(key, 'g') && !deps.hasActiveTurn()) {
      openPalette();
      return;
    }

    // Tab completes a slash command and nothing else: the rest of a prompt is
    // prose, and a completer guessing at the middle of a sentence would surprise
    // far more often than it helped. A command is a token with a known
    // vocabulary — the table `/help` prints — rather than a guess at a word.
    if (key.name === 'tab') {
      const [matches] = completeCommand(
        editor.text,
        commandRowsFor(deps.runtime),
      );
      if (matches.length === 1) editor.setText(`${matches[0] ?? ''} `);
      frame.requestRender();
      return;
    }

    const outcome = editor.handleKey(key);
    if (outcome.kind === 'submit') {
      const line = outcome.text.trim();
      if (line !== '') {
        editor.remember(line);
        deliver(line);
      }
    } else if (outcome.kind === 'interrupt') {
      // While a turn runs Ctrl-C belongs to the turn. At an idle prompt it
      // means "leave", which is what readline's own SIGINT used to mean.
      if (deps.hasActiveTurn()) deps.abortActive();
      else {
        leaving = true;
        deliver(undefined);
      }
    } else if (outcome.kind === 'eof' && !deps.hasActiveTurn()) {
      leaving = true;
      deliver(undefined);
    }
    frame.requestRender();
  });

  const offResize = frame.onResize(() => {
    overlay?.select.setRows(menuRows());
    frame.render();
  });

  const restore = (): void => {
    keyboard.stop();
    frame.stop();
  };
  if (deps.processHooks) process.once('exit', restore);

  // Every write for the rest of the session — the banner, a turn's answer, a
  // slash command's note, a log line — lands in the transcript rather than on
  // the stream, because the renderer has to be able to print it again.
  deps.setSink((text) => {
    transcript.write(text);
    // The first word of an answer is what the spinner was standing in for.
    thinking = undefined;
    frame.requestRender();
  });
  transcript.write(deps.header());
  frame.render();

  return {
    menu,

    async next(): Promise<string | undefined> {
      const held = queued.shift();
      if (held !== undefined) return held;
      if (leaving) return undefined;
      return await new Promise<string | undefined>((resolve) => {
        waiting = resolve;
      });
    },

    async run(body): Promise<TurnOutcome> {
      thinking = 0;
      // Nothing to point at until the answer starts: the caret would otherwise
      // sit on the blank row beside the spinner and read as a stray block.
      frame.setCursorVisible(false);
      stopTicking = deps.ticker(() => {
        if (thinking === undefined) return;
        thinking += 1;
        frame.render();
      });
      frame.requestRender();
      try {
        return await body();
      } finally {
        thinking = undefined;
        stopTicking();
        stopTicking = undefined;
        frame.setCursorVisible(true);
        frame.requestRender();
      }
    },

    refresh(): void {
      frame.requestRender();
    },

    close(): void {
      offResize();
      stopTicking?.();
      deps.setSink(undefined);
      restore();
    },
  };
}
