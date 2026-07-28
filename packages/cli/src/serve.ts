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
import { createRuntime, type GhostRuntime } from '@ghostai/runtime';
import { HubApprovalGate, SessionHub, createServer, type GhostServer } from '@ghostai/server';
import pc from 'picocolors';

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

  let runtime: GhostRuntime | undefined;
  let hub: SessionHub | undefined;
  let server: GhostServer | undefined;
  let channels: ChannelManager | undefined;

  try {
    const built = createRuntime({
      database,
      approvals,
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
      loop: () => built.loop,
      store: built.store,
      approvals,
      logger,
    });

    const ui = resolveUiRoot(options.ui);

    server = await createServer({
      config: built.config,
      runtime: createServerRuntime(built, { env }),
      hub,
      database,
      logger,
      ...(options.password === undefined ? {} : { password: options.password }),
      ...(options.username === undefined ? {} : { username: options.username }),
      ...(ui === undefined ? {} : { ui: { root: ui } }),
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

    let closed = false;
    const listener = server;
    const bridge = channels;
    const sessions = hub;
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
        // Backwards through the list above: channels stop accepting, the hub
        // aborts what is running, the listener closes, and the connection goes
        // last — closing it first would pull the database out from under a turn
        // that is still writing to it.
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
    // a listener, a WAL or a channel connection behind.
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
export function banner(running: RunningServer, colors: boolean | undefined): string {
  const c = pc.createColors(colors);
  const authEnabled = running.server.config.server.auth.enabled;
  const host = running.server.config.server.host;
  const instance = running.runtime.instance;

  const rows: [string, string][] = [
    ['URL', c.cyan(running.url)],
    [
      'Auth',
      authEnabled
        ? c.green('enabled')
        : // Not a warning for its own sake: `assertBootPolicy` already refused
          // the dangerous version of this, so what is left is a loopback bind
          // that anyone with an account on this machine can drive.
          c.yellow(`disabled — anything that can reach ${host} can drive this agent`),
    ],
    [
      'Agent',
      running.runtime.configured && instance !== null
        ? `${instanceLabel(instance)} · ${running.runtime.model}`
        : c.yellow('not configured — add a provider in the UI, or run `ghost init`'),
    ],
    ['Workspace', running.runtime.jail.root],
    ['UI', running.ui ?? c.dim('not built — serving the API only (build @ghostai/web to add it)')],
  ];

  const channels = running.channels.channels.map((channel) => channel.id);
  if (channels.length > 0) rows.push(['Channels', channels.join(', ')]);

  const width = Math.max(...rows.map(([label]) => label.length));
  const lines = rows.map(([label, value]) => `  ${c.dim(label.padEnd(width))}  ${value}`);
  const body = `${c.bold('GhostAI is listening.')}\n\n${lines.join('\n')}\n`;

  // Below the table rather than in it, because it is the one thing the operator
  // has to *act* on and a row in a list of five reads as another status line.
  // This is the whole reason the server starts unclaimed instead of refusing:
  // the code is the only way in, and the terminal printing it is the only place
  // it will ever appear.
  const setup =
    running.setupCode === undefined
      ? ''
      : `\n${c.bold('First run.')} Open the URL above and enter this one-time code:\n\n` +
        `      ${c.cyan(c.bold(running.setupCode))}\n\n` +
        `  ${c.dim('It works once, and stops working as soon as you set a password.')}\n`;

  return `${body}${setup}\n${c.dim('Press Ctrl-C to stop.')}\n`;
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
  out.write(banner(running, options.colors));

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
  out.write('Stopped.\n');
  return 0;
}
