/**
 * `ghost serve` — the same agent, behind a port.
 *
 * This is the second composition root, and the only place where every piece of
 * Phase 2 meets: one SQLite connection shared by the session store, the auth
 * tables and the notifications; one `GhostRuntime` over it; one approval gate
 * threaded into the loop *and* into the hub; one hub serving both the WebSocket
 * and every channel; one Fastify instance serving the API and the built UI.
 *
 * The order below is not arbitrary — each step needs the one before it:
 *
 *  1. **Read the config, open the database.** The config names the workspace,
 *     which decides where the database is; everything else shares that one
 *     connection so writes share a WAL.
 *  2. **Build the approval gate.** It has to exist before the runtime, because
 *     the runtime hands it to the loop at construction: without it, a tool
 *     whose policy is `ask` runs unattended behind a browser.
 *  3. **Build the runtime, then the hub over its loop.** The hub reads the loop
 *     through a function, so a settings save moves the next turn onto the new
 *     provider while the running one keeps the loop it started on.
 *  4. **Build the server over the adapter.** `createServer` awaits `ready()`,
 *     so the UI and the socket are options rather than later registrations.
 *  5. **Start the channels.** They bridge to the same hub, so a channel turn is
 *     a web turn that arrived somewhere else.
 *
 * Shutdown runs the same list backwards, and it is not decoration: the channels
 * stop accepting first, then the hub aborts what is running, then the listener
 * closes, and only then does the connection close — the reverse order would
 * close the database under a turn that is still writing to it.
 */

import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import {
  ChannelManager,
  type ChannelFactory,
  type TelegramChannel,
} from '@ghostai/channels';
import {
  GhostError,
  createLogger,
  ensureDir,
  loadConfig,
  silentLogger,
  type LogLevel,
  type Logger,
} from '@ghostai/core';
import { instanceLabel } from '@ghostai/providers';
import {
  createRuntime,
  resolveAgentOrDefault,
  type GhostRuntime,
} from '@ghostai/runtime';
import {
  HubApprovalGate,
  Scheduler,
  SessionHub,
  createAutomationResolver,
  createServer,
  type GhostServer,
  type ServerRuntime,
} from '@ghostai/server';
import type { AutomationResolver } from '@ghostai/tools';
import pc from 'picocolors';

import { translationsFor, type CliT } from './i18n.js';

import { createServerRuntime } from './server-runtime.js';
import {
  CHANNEL_CREDENTIAL_NAMESPACE,
  telegramFactories,
  telegramStatus,
} from './telegram.js';

export interface ServeOptions {
  /** Overrides `server.host` for this run. */
  readonly host?: string | undefined;
  /** Overrides `server.port`. `0` asks the OS for a free one. */
  readonly port?: number | undefined;
  /** `GHOSTAI_HOME` override. */
  readonly home?: string | undefined;
  readonly workspace?: string | undefined;
  /**
   * Sets or rotates the login password, then is not retained.
   *
   * Reading `--password` and `GHOSTAI_PASSWORD` is this layer's job by design:
   * `createServer` takes the value so that it stays testable without anyone
   * mutating `process.env`.
   */
  readonly password?: string | undefined;
  /**
   * Sets the login name, and only together with `password`.
   *
   * `--username` and `GHOSTAI_USERNAME`. On its own it is refused rather than
   * ignored — see `ServerOptions.username` for why a name cannot move without
   * the sessions minted under the old credential moving with it.
   */
  readonly username?: string | undefined;
  /** A built SPA to serve. Absent looks for `@ghostai/web`, then serves the API alone. */
  readonly ui?: string | undefined;
  /**
   * Registered before the pumps start, ahead of the built-ins.
   *
   * The built-in Telegram channel is added here too, but only when a bot token
   * resolves — see `telegramFactories`. A test that passes its own factory
   * still gets exactly that one, because no token resolves in a test
   * environment.
   */
  readonly channels?: readonly ChannelFactory[];
  readonly logger?: Logger;
  readonly logLevel?: LogLevel;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/** A server that is up, and the one call that takes it down again. */
export interface RunningServer {
  /** The bound address, as an operator would type it. */
  readonly url: string;
  readonly server: GhostServer;
  readonly runtime: GhostRuntime;
  readonly hub: SessionHub;
  /**
   * The channels that are up, or `undefined` when a rebuild failed.
   *
   * A getter rather than a field: a settings save replaces the manager, because
   * `ChannelManager` fixes its factories at construction. `undefined` is
   * reachable only after boot — a channel that will not start at boot fails the
   * boot — and it means the last save left nothing running, with the reason on
   * the settings panel.
   */
  readonly channels: ChannelManager | undefined;
  /** The directory the SPA is served from, or `undefined` for API-only. */
  readonly ui: string | undefined;
  /**
   * The one-time code that claims an install with no password.
   *
   * Present only on a first run. It exists here rather than only inside the
   * server because the terminal is the one place it can safely appear: it is
   * printed to whoever started the process and nowhere else, which is the
   * property that lets the server come up unclaimed instead of refusing to
   * start and leaving the UI that would set a password unreachable.
   */
  readonly setupCode: string | undefined;
  /** Idempotent, and safe to call from a signal handler. */
  close(): Promise<void>;
}

/**
 * Finds the built UI.
 *
 * An explicit `--ui` must exist — pointing at the wrong directory and getting a
 * silently API-only server is a worse afternoon than an error at startup. The
 * implicit path resolves `@ghostai/web` from this package's own dependencies,
 * so an install that shipped the bundle serves it and one that did not says so.
 */
export function resolveUiRoot(
  explicit: string | undefined,
): string | undefined {
  if (explicit !== undefined) {
    const root = resolve(explicit);
    if (!existsSync(join(root, 'index.html'))) {
      throw new GhostError(
        'config',
        `No index.html in ${root}. Is that the built UI directory?`,
      );
    }
    return root;
  }

  try {
    const require = createRequire(import.meta.url);
    const root = join(
      dirname(require.resolve('@ghostai/web/package.json')),
      'dist',
    );
    return existsSync(join(root, 'index.html')) ? root : undefined;
  } catch {
    // Not installed. Phase 2 builds the server before the UI exists, and a
    // headless install has no use for one either.
    return undefined;
  }
}

/**
 * Runs `act` once per turn of the microtask queue, however many times it is asked.
 *
 * The tool registry notifies per *mutation*, and a mutation is one tool: an MCP
 * server registering forty is forty notifications, and a settings save
 * unregisters every built-in and registers them again before it is done. A
 * frame per mutation would be a `tools.changed` storm on every save, and the
 * client cannot tell forty frames from one meaningful change.
 *
 * `queueMicrotask` rather than a timer, so the batch closes before anything can
 * observe the intermediate state and nothing has to be cleaned up on shutdown.
 */
function coalesce(act: () => void): () => void {
  let queued = false;
  return () => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      act();
    });
  };
}

/**
 * Reads a heartbeat's task file, through the jail.
 *
 * `payload.file` is operator-authored and workspace-relative, so it goes
 * through `WorkspaceJail` rather than `node:fs` directly — the jail is what
 * turns `../../.ssh/id_rsa` into a refusal instead of a file the heartbeat
 * model then reads aloud.
 *
 * A missing file becomes `GhostError('not_found')`, which the scheduler reads
 * as "nothing to do" rather than a fault: an install with no `TASK.md` is the
 * normal case, not a broken one.
 *
 * Capped rather than read whole, because this runs every interval forever and
 * a large file would be paid for on each one.
 */
async function readWorkspaceFile(
  runtime: GhostRuntime,
  input: {
    readonly workspaceId: string;
    readonly path: string;
    readonly maxBytes: number;
  },
): Promise<string> {
  const { workspaceId, path, maxBytes } = input;
  // The job's own workspace, not `runtime.jail` — that one is the default
  // workspace's, so a heartbeat in a named workspace used to read the default
  // one's `TASK.md` and skip forever on the file it could not see.
  const verdict = runtime.jails.forWorkspace(workspaceId).check(path);
  if (!verdict.ok) {
    throw new GhostError(
      'jail_escape',
      `Cannot read ${path}: ${verdict.message}`,
      {
        details: { path },
      },
    );
  }

  let handle;
  try {
    handle = await open(verdict.path, 'r');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new GhostError('not_found', `No ${path} in the workspace.`, {
        details: { path },
      });
    }
    throw error;
  }

  try {
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

/**
 * Brings the whole stack up and returns it. Does not block.
 *
 * Separate from `serveCommand` so a test can start a real server, drive it, and
 * shut it down — without a signal handler, a banner, or a process that never
 * returns.
 */
export async function startServer(
  options: ServeOptions = {},
): Promise<RunningServer> {
  const logger =
    options.logger ??
    (options.logLevel === undefined
      ? silentLogger
      : createLogger({ level: options.logLevel }));
  const env = options.env ?? process.env;

  // Read once, here, only for the database path: `createRuntime` loads it again
  // for itself, and the config it ends up with is the one everything else uses.
  const loaded = loadConfig({
    ...(options.home === undefined ? {} : { root: options.home }),
    ...(options.workspace === undefined
      ? {}
      : { workspace: options.workspace }),
    env,
  });
  ensureDir(dirname(loaded.paths.dbFile));
  const database = new DatabaseSync(loaded.paths.dbFile);

  // The `automation` tool's reach into the scheduler, late-bound for the same
  // knot `scheduler` has: the store it writes through is built by
  // `createServer`, which needs a runtime that is built here. The loop resolves
  // through this indirection once per turn, so filling it in below is enough.
  const automationHolder: { current: AutomationResolver | undefined } = {
    current: undefined,
  };
  const automation: AutomationResolver = {
    forTurn: (request) => automationHolder.current?.forTurn(request),
  };

  let runtime: GhostRuntime | undefined;
  let hub: SessionHub | undefined;
  let server: GhostServer | undefined;
  let channels: ChannelManager | undefined;
  /**
   * Why the last rebuild failed, when one did.
   *
   * Held rather than thrown, because a rebuild happens *after* a settings save
   * has been written and answered — see `rebuildChannels`. This is what carries
   * the reason to the panel that caused it.
   */
  let channelError: string | undefined;
  /** Detaches the `tools.changed` producer. Declared out here so `catch` can. */
  let releaseTools: (() => void) | undefined;
  // Declared out here so the catch below can stop a timer a later step failed
  // after arming.
  let scheduler: Scheduler | undefined;

  // Before the runtime, because the runtime hands it to the loop — but after the
  // bindings above, because it reads two things that do not exist yet. Both are
  // reached through the closure rather than a holder object: they are already
  // `let`s in this scope, and a second indirection would only be a second thing
  // to keep in step.
  const approvals = new HubApprovalGate({
    logger,
    // One watcher when the hub is not up: during boot there is no turn, and the
    // safe reading of "I cannot tell" is "somebody is there", which raises
    // nothing rather than raising a notification for every request.
    watchers: (sessionKey) => hub?.watchers(sessionKey) ?? 1,
    // A scheduled run's prompt goes to an empty room. This is what sends
    // somebody to look at it while it is still open — the row so it survives a
    // closed tab, the frame so an open one updates without a poll.
    onUnattended: ({ sessionKey, agentId, toolName }) => {
      const raised = server?.notifications.create({
        title: `Approval needed for "${toolName}"`,
        body:
          `The "${agentId}" agent asked to run "${toolName}" on a session nobody was watching. ` +
          'Open the session to answer it — an unanswered request is denied when it expires.',
        level: 'warning',
        sessionKey,
      });
      if (raised === undefined) return;
      hub?.broadcast({
        type: 'notification',
        id: raised.id,
        title: raised.title,
        body: raised.body,
        level: raised.level,
        createdAtMs: raised.createdAtMs,
        sessionKey,
      });
    },
  });

  try {
    const built = createRuntime({
      database,
      approvals,
      automation,
      logger,
      env,
      ...(options.home === undefined ? {} : { home: options.home }),
      ...(options.workspace === undefined
        ? {}
        : { workspace: options.workspace }),
    });
    runtime = built;

    // The host is folded into the settings; the port is not, and the asymmetry
    // is the point. `assertBootPolicy` refuses a non-loopback bind with
    // authentication off, and it reads the config it was handed — so a
    // `--host 0.0.0.0` applied only at `listen` time would walk straight past
    // the one check that exists to stop it. A port carries no such decision,
    // and `--port 0` (ask the OS for a free one) is not even expressible in the
    // config, whose schema requires a real port number.
    if (options.host !== undefined) {
      built.reconfigure({ server: { host: options.host } });
    }

    hub = new SessionHub({
      config: built.config,
      // A function, so a settings save moves the *next* turn onto the rebuilt
      // loop while the running one keeps the one it started on.
      loop: (agentId) => built.loopFor(agentId),
      // A function for the same reason, and for one more: an agent deleted a
      // moment ago must stop resolving, rather than living on because the hub
      // was constructed before the delete.
      resolveAgentId: (agentId) => {
        const { agent, miss } = resolveAgentOrDefault(built.config, agentId);
        return { agentId: agent.id, miss };
      },
      store: built.store,
      approvals,
      logger,
    });

    const sessionHub = hub;
    const ui = resolveUiRoot(options.ui);
    const serverRuntime = createServerRuntime(built, { env });
    // Captured rather than reached through the object at call time, so the
    // optional-method check and the call cannot disagree.
    const directChat = serverRuntime.chat?.bind(serverRuntime);

    /**
     * Rebuilds the channels from the settings as they now stand.
     *
     * A new manager rather than a restart of the old one: `ChannelManager`
     * fixes its factories at construction and `register` refuses to run after
     * `start`, which is the property that stops a channel appearing halfway
     * through a process's life without anyone deciding it should.
     *
     * `fatal` is the difference between the two callers. At boot a channel that
     * will not start is a startup error. Afterwards the settings have already
     * been written and answered, so throwing would report a save that did
     * happen as one that did not — and the thing the operator actually needs,
     * the reason, reaches them through `telegramStatus` on the panel they are
     * looking at.
     */
    const rebuildChannels = async (fatal: boolean): Promise<void> => {
      await channels?.stop();
      channelError = undefined;
      const next = new ChannelManager({
        hub: sessionHub,
        channels: built.config.channels,
        factories: [
          ...(options.channels ?? []),
          ...telegramFactories({
            runtime: built,
            server: serverRuntime,
            paths: loaded.paths,
            env,
            logger,
          }),
        ],
        logger,
      });
      try {
        await next.start();
        channels = next;
      } catch (error) {
        channels = undefined;
        channelError = error instanceof Error ? error.message : String(error);
        // At boot it is fatal, and deliberately: a bad token should stop the
        // process rather than leave a channel silently dead, which is what
        // `channel.ts` documents. After boot it must not be — the server is
        // already serving, and taking it down over a mistyped token in a
        // settings panel would be a far worse answer than a red line in it.
        if (fatal) throw error;
        logger.error({ err: error }, 'channels could not be restarted');
      }
    };

    /**
     * The port `createServer` gets, with the two writes that move a channel
     * decorated.
     *
     * A decorator here rather than an option on `createServerRuntime`, because
     * only this file knows a channel manager exists — the adapter is about
     * config, credentials and the model catalogue, and handing it a channel to
     * restart would be handing it a second job.
     *
     * The rebuild is not awaited: `applySettings` answers a Config
     * synchronously, and a save that blocked on a Telegram round trip would be
     * a settings panel that hangs on someone else's network. The panel reads
     * `running` back on its next fetch.
     */
    const runtimeForServer: ServerRuntime = {
      ...serverRuntime,
      applySettings: (patch) => {
        const saved = serverRuntime.applySettings(patch);
        void rebuildChannels(false);
        return saved;
      },
      setCredential: (request) => {
        serverRuntime.setCredential(request);
        // Only a channel's own credential moves a channel. A provider key
        // save must not bounce a bot that has nothing to do with it.
        if (request.namespace === CHANNEL_CREDENTIAL_NAMESPACE) {
          void rebuildChannels(false);
        }
      },
      channels: () => [
        telegramStatus({
          runtime: built,
          paths: loaded.paths,
          env,
          channel: channels?.channel('telegram') as TelegramChannel | undefined,
          startError: channelError,
        }),
      ],
    };

    // `scheduler` is still undefined here and is filled in below.
    // `createServer` builds the stores the engine runs over, so the engine
    // cannot exist before the call — the getter is what unties that, the same
    // way `openapiDocument` is untied inside `createServer`.
    server = await createServer({
      config: built.config,
      runtime: runtimeForServer,
      hub,
      database,
      logger,
      scheduler: () => scheduler,
      ...(options.password === undefined ? {} : { password: options.password }),
      ...(options.username === undefined ? {} : { username: options.username }),
      ...(ui === undefined ? {} : { ui: { root: ui } }),
    });

    const listener = server;

    // The producer for `tools.changed`, and the reason it hangs off the
    // *registry* rather than off the MCP manager: a plugin host will need the
    // same seam in Phase 4, and the registry is the thing they have in common.
    // `@ghostai/mcp` calls `sink.replace`, the registry's revision moves, and
    // every open tab learns without either of them knowing a socket exists.
    //
    // It also closes a gap that predates MCP: switching `exec` off in the
    // settings panel already mutated the registry, and nothing told the
    // browser until the next reload.
    releaseTools = built.tools.subscribe(
      coalesce(() => {
        sessionHub.broadcast({
          type: 'tools.changed',
          tools: [...serverRuntime.registeredTools()],
        });
      }),
    );
    automationHolder.current = createAutomationResolver({
      jobs: listener.automation,
      sessions: built.store,
      timezone: () => built.config.ui.timezone,
      refresh: () => {
        scheduler?.refresh();
      },
    });

    scheduler = new Scheduler({
      jobs: listener.automation,
      config: () => built.config,
      // Through the hub, not straight to a loop: a job may name a session a
      // browser is also in, and the hub is the only thing that serialises one.
      connect: (connectOptions) => sessionHub.connect(connectOptions),
      broadcast: (event) => {
        sessionHub.broadcast(event);
      },
      raise: (input) => listener.notifications.create(input),
      deleteSession: (sessionKey) => {
        built.store.deleteSession(sessionKey);
      },
      readFile: async (input) => await readWorkspaceFile(built, input),
      ...(directChat === undefined ? {} : { chat: directChat }),
      logger,
    });

    await rebuildChannels(true);

    // After `createServer`, which is where `--password` is applied: minting a
    // code for an install that was just given a password would print a
    // credential nobody needs.
    const setupCode =
      built.config.server.auth.enabled && !server.auth.hasPassword()
        ? server.auth.issueSetupCode()
        : undefined;

    const url = await server.listen(
      options.port === undefined ? {} : { port: options.port },
    );

    // After `listen`, so a job that fires immediately — a missed one-shot the
    // boot sweep picks up — reaches a server that can already answer for it.
    scheduler.start();

    let closed = false;
    const sessions = hub;
    const engine = scheduler;
    const running: RunningServer = {
      url,
      server: listener,
      runtime: built,
      hub: sessions,
      get channels() {
        return channels;
      },
      ui,
      setupCode,
      close: async (): Promise<void> => {
        if (closed) return;
        closed = true;
        // Backwards through the list above: the scheduler stops starting work,
        // channels stop accepting, the hub aborts what is running, the listener
        // closes, and the connection goes last — closing it first would pull
        // the database out from under a turn that is still writing to it.
        //
        // The scheduler goes first *and* is awaited, because it drives its
        // turns through the hub: stopping the hub underneath an in-flight run
        // would leave the run row `pending` with nothing to close it.
        await engine.stop();
        await channels?.stop();
        // Before the hub, so a registry mutation during `built.close()` — an
        // MCP server's tools going as it disconnects — does not try to
        // broadcast to sockets that are being torn down.
        releaseTools?.();
        sessions.close();
        await listener.close();
        built.close();
        database.close();
      },
    };
    return running;
  } catch (error) {
    // Anything already built is taken back down: a failed start must not leave
    // a listener, a WAL, a timer or a channel connection behind.
    await scheduler?.stop();
    await channels?.stop();
    releaseTools?.();
    hub?.close();
    await server?.close();
    runtime?.close();
    database.close();
    throw error;
  }
}

export interface ServeCommandOptions extends ServeOptions {
  readonly out?: NodeJS.WritableStream;
  readonly errOut?: NodeJS.WritableStream;
  readonly colors?: boolean | undefined;
  /** Installs the SIGINT/SIGTERM handlers. `false` in tests, which own signals. */
  readonly handleSignals?: boolean;
  /** Stops the server when it fires. The seam a test shuts down through. */
  readonly signal?: AbortSignal;
}

/** What an operator needs to know in the second after it starts. */
export function banner(
  running: RunningServer,
  colors: boolean | undefined,
  t: CliT,
): string {
  const c = pc.createColors(colors);
  const authEnabled = running.server.config.server.auth.enabled;
  const host = running.server.config.server.host;
  const instance = running.runtime.instance;

  const rows: Array<[string, string]> = [
    [t('serve.url'), c.cyan(running.url)],
    [
      t('serve.auth'),
      authEnabled
        ? c.green(t('serve.authEnabled'))
        : // Not a warning for its own sake: `assertBootPolicy` already refused
          // the dangerous version of this, so what is left is a loopback bind
          // that anyone with an account on this machine can drive.
          c.yellow(t('serve.authDisabled', { host })),
    ],
    [
      t('serve.agent'),
      running.runtime.configured && instance !== null
        ? `${instanceLabel(instance)} · ${running.runtime.model}`
        : c.yellow(t('serve.agentUnconfigured')),
    ],
    [t('serve.workspace'), running.runtime.jail.root],
    [t('serve.ui'), running.ui ?? c.dim(t('serve.uiUnbuilt'))],
  ];

  const channels = (running.channels?.channels ?? []).map(
    (channel) => channel.id,
  );
  if (channels.length > 0) {
    rows.push([t('serve.channels'), channels.join(', ')]);
  }

  const width = Math.max(...rows.map(([label]) => label.length));
  const lines = rows.map(
    ([label, value]) => `  ${c.dim(label.padEnd(width))}  ${value}`,
  );
  const body = `${c.bold(t('serve.listening'))}\n\n${lines.join('\n')}\n`;

  // Below the table rather than in it, because it is the one thing the operator
  // has to *act* on and a row in a list of five reads as another status line.
  // This is the whole reason the server starts unclaimed instead of refusing:
  // the code is the only way in, and the terminal printing it is the only place
  // it will ever appear.
  const setup =
    running.setupCode === undefined
      ? ''
      : `\n${c.bold(t('serve.firstRun'))} ${t('serve.firstRunBody')}\n\n` +
        `      ${c.cyan(c.bold(running.setupCode))}\n\n` +
        `  ${c.dim(t('serve.codeOnce'))}\n`;

  return `${body}${setup}\n${c.dim(t('serve.pressCtrlC'))}\n`;
}

/**
 * Starts the server and stays up until it is asked to stop.
 *
 * Returns an exit code rather than calling `process.exit`, like every other
 * subcommand — the listener has to close before the process ends, or the last
 * responses are dropped on a socket that is already gone.
 */
export async function serveCommand(
  options: ServeCommandOptions = {},
): Promise<number> {
  const out = options.out ?? process.stdout;
  const running = await startServer(options);
  // After the server, so the install's own `ui.locale` is available — the same
  // order `chatCommand` uses and for the same reason.
  const { t } = translationsFor(
    options.env ?? process.env,
    running.runtime.config.ui.locale,
  );
  out.write(banner(running, options.colors, t));

  await new Promise<void>((finish) => {
    let done = false;
    const stop = (): void => {
      if (done) return;
      done = true;
      cleanup();
      finish();
    };

    const onSignal = (): void => {
      // A newline first: Ctrl-C echoes `^C` at the cursor, and the shutdown
      // line would otherwise be appended to it.
      (options.out ?? process.stdout).write('\n');
      stop();
    };

    const cleanup = (): void => {
      if (options.handleSignals !== false) {
        process.off('SIGINT', onSignal);
        process.off('SIGTERM', onSignal);
      }
      options.signal?.removeEventListener('abort', stop);
    };

    if (options.handleSignals !== false) {
      process.on('SIGINT', onSignal);
      process.on('SIGTERM', onSignal);
    }
    if (options.signal?.aborted === true) stop();
    else options.signal?.addEventListener('abort', stop);
  });

  await running.close();
  out.write(`${t('serve.stopped')}\n`);
  return 0;
}
