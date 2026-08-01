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

import { ChannelManager, type ChannelFactory } from '@ghostai/channels';
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
import { createRuntime, resolveAgentOrDefault, type GhostRuntime } from '@ghostai/runtime';
import {
  HubApprovalGate,
  Scheduler,
  SessionHub,
  createAutomationResolver,
  createServer,
  type GhostServer,
} from '@ghostai/server';
import type { AutomationResolver } from '@ghostai/tools';
import pc from 'picocolors';

import { translationsFor, type CliT } from './i18n.js';

import { createServerRuntime } from './server-runtime.js';

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
  /** Registered before the pumps start. Empty until Telegram lands in Phase 3. */
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
  readonly channels: ChannelManager;
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
export function resolveUiRoot(explicit: string | undefined): string | undefined {
  if (explicit !== undefined) {
    const root = resolve(explicit);
    if (!existsSync(join(root, 'index.html'))) {
      throw new GhostError('config', `No index.html in ${root}. Is that the built UI directory?`);
    }
    return root;
  }

  try {
    const require = createRequire(import.meta.url);
    const root = join(dirname(require.resolve('@ghostai/web/package.json')), 'dist');
    return existsSync(join(root, 'index.html')) ? root : undefined;
  } catch {
    // Not installed. Phase 2 builds the server before the UI exists, and a
    // headless install has no use for one either.
    return undefined;
  }
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
  path: string,
  maxBytes: number,
): Promise<string> {
  const verdict = runtime.jail.check(path);
  if (!verdict.ok) {
    throw new GhostError('jail_escape', `Cannot read ${path}: ${verdict.message}`, {
      details: { path },
    });
  }

  let handle;
  try {
    handle = await open(verdict.path, 'r');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new GhostError('not_found', `No ${path} in the workspace.`, { details: { path } });
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
export async function startServer(options: ServeOptions = {}): Promise<RunningServer> {
  const logger =
    options.logger ??
    (options.logLevel === undefined ? silentLogger : createLogger({ level: options.logLevel }));
  const env = options.env ?? process.env;

  // Read once, here, only for the database path: `createRuntime` loads it again
  // for itself, and the config it ends up with is the one everything else uses.
  const loaded = loadConfig({
    ...(options.home === undefined ? {} : { root: options.home }),
    ...(options.workspace === undefined ? {} : { workspace: options.workspace }),
    env,
  });
  ensureDir(dirname(loaded.paths.dbFile));
  const database = new DatabaseSync(loaded.paths.dbFile);

  // Before the runtime, because the runtime hands it to the loop.
  const approvals = new HubApprovalGate({ logger });

  // The `automation` tool's reach into the scheduler, late-bound for the same
  // knot `scheduler` has: the store it writes through is built by
  // `createServer`, which needs a runtime that is built here. The loop resolves
  // through this indirection once per turn, so filling it in below is enough.
  const automationHolder: { current: AutomationResolver | undefined } = { current: undefined };
  const automation: AutomationResolver = {
    forTurn: (request) => automationHolder.current?.forTurn(request),
  };

  let runtime: GhostRuntime | undefined;
  let hub: SessionHub | undefined;
  let server: GhostServer | undefined;
  let channels: ChannelManager | undefined;
  // Declared out here so the catch below can stop a timer a later step failed
  // after arming.
  let scheduler: Scheduler | undefined;

  try {
    const built = createRuntime({
      database,
      approvals,
      automation,
      logger,
      env,
      ...(options.home === undefined ? {} : { home: options.home }),
      ...(options.workspace === undefined ? {} : { workspace: options.workspace }),
    });
    runtime = built;

    // The host is folded into the settings; the port is not, and the asymmetry
    // is the point. `assertBootPolicy` refuses a non-loopback bind with
    // authentication off, and it reads the config it was handed — so a
    // `--host 0.0.0.0` applied only at `listen` time would walk straight past
    // the one check that exists to stop it. A port carries no such decision,
    // and `--port 0` (ask the OS for a free one) is not even expressible in the
    // config, whose schema requires a real port number.
    if (options.host !== undefined) built.reconfigure({ server: { host: options.host } });

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

    const ui = resolveUiRoot(options.ui);
    const serverRuntime = createServerRuntime(built, { env });
    // Captured rather than reached through the object at call time, so the
    // optional-method check and the call cannot disagree.
    const directChat = serverRuntime.chat?.bind(serverRuntime);

    // `scheduler` is still undefined here and is filled in below.
    // `createServer` builds the stores the engine runs over, so the engine
    // cannot exist before the call — the getter is what unties that, the same
    // way `openapiDocument` is untied inside `createServer`.
    server = await createServer({
      config: built.config,
      runtime: serverRuntime,
      hub,
      database,
      logger,
      scheduler: () => scheduler,
      ...(options.password === undefined ? {} : { password: options.password }),
      ...(options.username === undefined ? {} : { username: options.username }),
      ...(ui === undefined ? {} : { ui: { root: ui } }),
    });

    const sessionHub = hub;
    const listener = server;
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
      readFile: async (path, maxBytes) => await readWorkspaceFile(built, path, maxBytes),
      ...(directChat === undefined ? {} : { chat: directChat }),
      logger,
    });

    channels = new ChannelManager({
      hub,
      channels: built.config.channels,
      factories: options.channels ?? [],
      logger,
    });
    await channels.start();

    // After `createServer`, which is where `--password` is applied: minting a
    // code for an install that was just given a password would print a
    // credential nobody needs.
    const setupCode =
      built.config.server.auth.enabled && !server.auth.hasPassword()
        ? server.auth.issueSetupCode()
        : undefined;

    const url = await server.listen(options.port === undefined ? {} : { port: options.port });

    // After `listen`, so a job that fires immediately — a missed one-shot the
    // boot sweep picks up — reaches a server that can already answer for it.
    scheduler.start();

    let closed = false;
    const bridge = channels;
    const sessions = hub;
    const engine = scheduler;
    const running: RunningServer = {
      url,
      server: listener,
      runtime: built,
      hub: sessions,
      channels: bridge,
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
        await bridge.stop();
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
export function banner(running: RunningServer, colors: boolean | undefined, t: CliT): string {
  const c = pc.createColors(colors);
  const authEnabled = running.server.config.server.auth.enabled;
  const host = running.server.config.server.host;
  const instance = running.runtime.instance;

  const rows: [string, string][] = [
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

  const channels = running.channels.channels.map((channel) => channel.id);
  if (channels.length > 0) rows.push([t('serve.channels'), channels.join(', ')]);

  const width = Math.max(...rows.map(([label]) => label.length));
  const lines = rows.map(([label, value]) => `  ${c.dim(label.padEnd(width))}  ${value}`);
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
export async function serveCommand(options: ServeCommandOptions = {}): Promise<number> {
  const out = options.out ?? process.stdout;
  const running = await startServer(options);
  // After the server, so the install's own `ui.locale` is available — the same
  // order `chatCommand` uses and for the same reason.
  const { t } = translationsFor(options.env ?? process.env, running.runtime.config.ui.locale);
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
