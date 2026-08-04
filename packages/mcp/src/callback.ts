/**
 * The loopback listener an OAuth redirect lands on.
 *
 * **Why a listener of our own rather than a route on the GhostAI server.**
 * Three reasons, and any one of them is sufficient. This package sits below
 * `@ghostai/server` in the layer graph and may not reach it. `ghost chat` in a
 * terminal has no HTTP server at all and still has to be able to authorize a
 * server. And the route manifest's `public` list is three entries long on
 * purpose — an OAuth redirect cannot carry the session cookie, because it
 * arrives as a cross-site navigation and the cookie is `SameSite=Strict`, so a
 * route would have to be unauthenticated. A loopback bind is what every desktop
 * OAuth client does, and it is reachable only from this machine.
 *
 * The `state` parameter is the authentication. It is minted per attempt from
 * the same CSPRNG the tool-output nonce uses, checked against what was stored,
 * and consumed once — which is exactly the job `state` exists for in the OAuth
 * spec, rather than a mechanism invented here.
 *
 * One listener serves every server, and it stays up only while at least one
 * authorization is outstanding.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { GhostError, type Clock, type Logger } from '@ghostai/core';
import { systemRandom, type RandomSource } from '@ghostai/security';

/**
 * Tried first so the redirect URI is stable across attempts.
 *
 * An authorization server that requires an exact pre-registered redirect URI —
 * which is most of them, for a confidential client — cannot work with an
 * ephemeral port. Falling back to one is still better than failing outright:
 * dynamic registration, which is the common case for MCP, registers whatever
 * this reports.
 */
export const DEFAULT_CALLBACK_PORT = 33_418;

export const CALLBACK_PATH = '/mcp/callback';

/** Twelve bytes of CSPRNG, hex. Long enough that guessing is not a strategy. */
const STATE_BYTES = 12;

const PAGE = (message: string): string =>
  `<!doctype html><meta charset="utf-8"><title>GhostAI</title>` +
  `<body style="font:16px system-ui;padding:3rem;max-width:32rem;margin:auto">` +
  `<p>${message}</p></body>`;

interface Pending {
  readonly serverId: string;
  readonly resolve: (code: string) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<Clock['setTimeout']>;
}

export interface CallbackListenerOptions {
  readonly clock: Clock;
  readonly logger: Logger;
  readonly random?: RandomSource;
  /** `0` asks the OS for any free port. Defaults to `DEFAULT_CALLBACK_PORT`. */
  readonly port?: number;
}

export interface AuthorizationHandle {
  readonly state: string;
  readonly redirectUrl: string;
  /** Resolves with the authorization code, or rejects on timeout or cancel. */
  readonly code: Promise<string>;
  cancel(reason: string): void;
}

/**
 * One listener, shared by every server that needs to authorize.
 *
 * `begin` is what a connection calls before it hands a provider to a transport;
 * the listener is started on the first call and stopped when the last
 * authorization settles.
 */
export class CallbackListener {
  private server: Server | undefined;
  private redirectBase = '';
  private readonly pending = new Map<string, Pending>();
  private starting: Promise<void> | undefined;

  constructor(private readonly options: CallbackListenerOptions) {}

  /** Where a provider should tell the authorization server to send the user. */
  get redirectUrl(): string {
    return this.redirectBase;
  }

  async begin(
    serverId: string,
    timeoutMs: number,
  ): Promise<AuthorizationHandle> {
    await this.start();
    const random = this.options.random ?? systemRandom;
    const state = random(STATE_BYTES).toString('hex');

    let settle: {
      resolve: (code: string) => void;
      reject: (error: Error) => void;
    };
    const code = new Promise<string>((resolve, reject) => {
      settle = { resolve, reject };
    });
    // `code` rejecting is a legitimate outcome — a timeout, an operator who
    // never followed the link — and the connection awaits it. Without this the
    // rejection would be unhandled for as long as it takes the caller to get
    // there, which under Node's default is a process exit.
    void code.catch(() => undefined);

    const timer = this.options.clock.setTimeout(
      () => {
        this.settle(state, (entry) => {
          entry.reject(
            new GhostError(
              'timeout',
              `Authorization for MCP server "${serverId}" was not completed in time`,
            ),
          );
        });
      },
      // A zero here means "the schema's no-limit convention", and an
      // authorization that can never expire holds a listener open forever.
      timeoutMs > 0 ? timeoutMs : 5 * 60_000,
    );

    this.pending.set(state, {
      serverId,
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- the executor above runs synchronously
      resolve: settle!.resolve,
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- likewise
      reject: settle!.reject,
      timer,
    });

    return {
      state,
      redirectUrl: this.redirectBase,
      code,
      cancel: (reason: string) => {
        this.settle(state, (entry) => {
          entry.reject(new GhostError('aborted', reason));
        });
      },
    };
  }

  /** Stops listening and refuses everything outstanding. */
  async close(): Promise<void> {
    for (const state of [...this.pending.keys()]) {
      this.settle(state, (entry) => {
        entry.reject(
          new GhostError('aborted', 'The MCP client is shutting down'),
        );
      });
    }
    await this.stop();
  }

  private settle(state: string, act: (entry: Pending) => void): void {
    const entry = this.pending.get(state);
    if (entry === undefined) return;
    this.pending.delete(state);
    this.options.clock.clearTimeout(entry.timer);
    act(entry);
    // The listener exists for the duration of an authorization and no longer:
    // an open port nobody is using is a surface with no purpose.
    if (this.pending.size === 0) void this.stop();
  }

  private async start(): Promise<void> {
    if (this.server !== undefined) return;
    // Two servers authorizing at once must not each bind a port. The promise is
    // the lock, and it is cleared on both outcomes so a failure can be retried.
    this.starting ??= this.listen().finally(() => {
      this.starting = undefined;
    });
    await this.starting;
  }

  private async listen(): Promise<void> {
    const server = createServer((request, response) => {
      this.handle(request.url ?? '', response);
    });
    const wanted = this.options.port ?? DEFAULT_CALLBACK_PORT;

    const bind = async (port: number): Promise<void> => {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => {
          reject(error);
        };
        server.once('error', onError);
        // Loopback only, always. This port accepts an authorization code; it
        // has no business being reachable from the network.
        server.listen(port, '127.0.0.1', () => {
          server.removeListener('error', onError);
          resolve();
        });
      });
    };

    try {
      await bind(wanted);
    } catch (error) {
      if (wanted === 0) throw error;
      // Something else already holds the fixed port — commonly a second GhostAI
      // on the same machine. An ephemeral port still works wherever the
      // authorization server accepts a dynamically registered redirect URI.
      this.options.logger.debug(
        { port: wanted, error },
        'mcp callback port unavailable, falling back to an ephemeral one',
      );
      await bind(0);
    }

    const address: string | AddressInfo | null = server.address();
    const port =
      address !== null && typeof address === 'object' ? address.port : wanted;
    server.unref();
    this.server = server;
    this.redirectBase = `http://127.0.0.1:${String(port)}${CALLBACK_PATH}`;
  }

  private async stop(): Promise<void> {
    const server = this.server;
    if (server === undefined) return;
    this.server = undefined;
    this.redirectBase = '';
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }

  private handle(
    url: string,
    response: {
      writeHead(status: number, headers: Record<string, string>): void;
      end(body?: string): void;
    },
  ): void {
    const answer = (status: number, message: string): void => {
      response.writeHead(status, {
        'content-type': 'text/html; charset=utf-8',
      });
      response.end(PAGE(message));
    };

    const parsed = new URL(url, 'http://127.0.0.1');
    if (parsed.pathname !== CALLBACK_PATH) {
      answer(404, 'Not found.');
      return;
    }

    const state = parsed.searchParams.get('state') ?? '';
    const entry = this.pending.get(state);
    if (entry === undefined) {
      // One answer for "no such state" and "already used", so a caller cannot
      // probe for the difference.
      answer(400, 'This authorization link is not one GhostAI is waiting for.');
      return;
    }

    const failure = parsed.searchParams.get('error');
    if (failure !== null) {
      const description =
        parsed.searchParams.get('error_description') ?? failure;
      this.settle(state, (pending) => {
        pending.reject(
          new GhostError(
            'permission_denied',
            `Authorization for MCP server "${pending.serverId}" was refused: ${description}`,
          ),
        );
      });
      answer(200, `Authorization was refused: ${description}`);
      return;
    }

    const code = parsed.searchParams.get('code');
    if (code === null || code === '') {
      this.settle(state, (pending) => {
        pending.reject(
          new GhostError(
            'invalid_input',
            `The authorization redirect for "${pending.serverId}" carried no code`,
          ),
        );
      });
      answer(400, 'That redirect carried no authorization code.');
      return;
    }

    const serverId = entry.serverId;
    this.settle(state, (pending) => {
      pending.resolve(code);
    });
    answer(
      200,
      `GhostAI is now connected to <b>${serverId}</b>. You can close this tab.`,
    );
  }
}
