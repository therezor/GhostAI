/**
 * The only module in this package that loads `@modelcontextprotocol/sdk`.
 *
 * Everything else speaks `McpSession` (see `session.ts`), so a test drives an
 * object literal and CI spawns no subprocess and opens no socket. This file is
 * the adapter, and the whole of the SDK's surface area we depend on:
 * `Client`, three client transports, and `UnauthorizedError`.
 *
 * Two things about the dependency itself, stated so nobody "fixes" them:
 *
 *  - **The SDK ships its server half in the same package**, and that half
 *    depends on express, hono and cors. None of it is loaded here — the imports
 *    below are all under `client/` — but the packages are in the install graph
 *    and an audit tool will notice.
 *  - **`SSEClientTransport` is deprecated upstream.** It is supported because
 *    servers in the wild still speak it and a client that could not reach them
 *    would be the reason someone kept a second tool around. It is never
 *    inferred; see `spec.ts`.
 *
 * ### The stdio decisions
 *
 * A stdio server's `command` and `args` **do not** go through `guardExec`.
 * That guard is built for argv a *model* wrote inside a workspace jail: it
 * refuses absolute paths, refuses shell binaries, and classifies every
 * path-shaped argument against the jail. An MCP `command` is operator
 * configuration in the same trust class as `providers.<id>.apiBase` or a
 * toolbox image, and it is almost always `npx`, `uvx`, `docker`, or an absolute
 * path to a binary that lives outside the workspace on purpose — every one of
 * which the guard refuses by design. Running it through would make the feature
 * unusable while protecting against nothing: anyone able to edit `config.json`
 * can already add a binary to `tools.exec.allowedBinaries`. The model's reach
 * stops at a bridged tool's *arguments*, which are JSON over a pipe and never
 * become argv.
 *
 * What is enforced instead, and is not nothing:
 *
 *  - `env` is the SDK's own safe-to-inherit set plus what the entry names —
 *    never this process's whole environment, so a provider API key in
 *    `ghost serve`'s environment does not silently land inside third-party
 *    code;
 *  - `stderr` is piped to the logger rather than the SDK's default `inherit`,
 *    which would interleave a server's diagnostics into GhostAI's own output;
 *  - the child is killed on `close()`.
 */

import { GhostError, toGhostError, type Logger } from '@ghostai/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

import type {
  McpCallOptions,
  McpCallResult,
  McpConnectContext,
  McpConnector,
  McpSession,
  McpToolDescriptor,
} from './session.js';
import type { McpConnectionSpec } from './spec.js';

/** What GhostAI calls itself in the MCP initialise handshake. */
export const CLIENT_NAME = 'ghostai';
export const CLIENT_VERSION = '0.0.0';

/** Beyond this many stderr bytes per server, logging stops. */
const STDERR_BUDGET_BYTES = 64 * 1024;

export interface SdkConnectorOptions {
  readonly logger: Logger;
  readonly clientName?: string;
  readonly clientVersion?: string;
  /**
   * Where a transport comes from. Defaults to the three real ones.
   *
   * The seam `sdk-connector.test.ts` replaces with
   * `InMemoryTransport.createLinkedPair()`, so the one test that proves this
   * adapter actually speaks the protocol still spawns nothing and dials
   * nothing. Injected the way `RuntimeOptions.fetchImpl` and
   * `containerEngine` are, for the same reason.
   */
  readonly transports?: (
    spec: McpConnectionSpec,
    auth: OAuthClientProvider | undefined,
  ) => Transport;
}

/**
 * The three transports, as a union rather than as `Transport`.
 *
 * `Transport` declares `sessionId?: string` while `StreamableHTTPClientTransport`
 * declares `sessionId: string | undefined`, and under this repo's
 * `exactOptionalPropertyTypes` those are different types — an inconsistency in
 * the SDK's own declarations rather than anything about the objects. Keeping
 * the concrete union here means the one place that has to reconcile them is the
 * `connect` call, with a note, instead of every function that passes one along.
 */
type ClientTransport =
  | StdioClientTransport
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- deliberate; see the module header
  | SSEClientTransport
  | StreamableHTTPClientTransport;

function buildTransport(
  spec: McpConnectionSpec,
  auth: OAuthClientProvider | undefined,
): ClientTransport {
  if (spec.kind === 'stdio') {
    return new StdioClientTransport({
      command: spec.command,
      args: [...spec.args],
      env: { ...getDefaultEnvironment(), ...spec.env },
      stderr: 'pipe',
    });
  }

  const url = new URL(spec.url);
  // `headers` is what an operator typed, and it stays in `config.json` in the
  // clear by the same policy `providers.<id>.extraHeaders` follows. It is set
  // on every request, including the SSE stream's own.
  const requestInit: RequestInit = { headers: { ...spec.headers } };

  if (spec.kind === 'sse') {
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- deliberate; see the module header
    return new SSEClientTransport(url, {
      requestInit,
      ...(auth === undefined ? {} : { authProvider: auth }),
    });
  }
  return new StreamableHTTPClientTransport(url, {
    requestInit,
    ...(auth === undefined ? {} : { authProvider: auth }),
  });
}

/**
 * Drains a stdio child's stderr into the log, under a budget.
 *
 * A server that writes a line per request would otherwise fill the log with
 * somebody else's diagnostics; a server that crashes writes its reason there
 * and it is the only place that reason exists.
 */
function pipeStderr(
  transport: StdioClientTransport,
  onServerLog: (line: string) => void,
): void {
  const stream = transport.stderr;
  if (stream === null) return;
  let spent = 0;
  stream.on('data', (chunk: Buffer | string) => {
    if (spent >= STDERR_BUDGET_BYTES) return;
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    spent += text.length;
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (trimmed !== '') onServerLog(trimmed);
    }
  });
}

/**
 * `UnauthorizedError` as something the connection can act on.
 *
 * It is the SDK's signal that `redirectToAuthorization` has been called and the
 * operator now has to go somewhere — a state, not a failure to retry — so it is
 * tagged rather than folded into the general error path.
 */
export const NEEDS_AUTHORIZATION = 'needsAuthorization';

function asGhostError(error: unknown): GhostError {
  if (error instanceof UnauthorizedError) {
    return new GhostError(
      'permission_denied',
      'The MCP server requires authorization',
      { cause: error, details: { [NEEDS_AUTHORIZATION]: true } },
    );
  }
  return toGhostError(error, 'network');
}

export function isNeedsAuthorization(error: unknown): boolean {
  return (
    error instanceof GhostError && error.details[NEEDS_AUTHORIZATION] === true
  );
}

/**
 * Exchanges the authorization code, through whichever transport can.
 *
 * `finishAuth` is on both HTTP transports and on neither the `Transport`
 * interface nor `StdioClientTransport` — a stdio server has no OAuth to finish.
 * Narrowing by class rather than by a `'finishAuth' in transport` check keeps
 * the reason legible: this is the set of transports that can authorize.
 */
async function finishAuthorization(
  transport: Transport,
  code: string,
): Promise<void> {
  if (
    transport instanceof StreamableHTTPClientTransport ||
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- deliberate; see the module header
    transport instanceof SSEClientTransport
  ) {
    await transport.finishAuth(code);
    return;
  }
  throw new GhostError(
    'config',
    'This MCP transport cannot complete an authorization',
  );
}

/** The real connector. Injected everywhere so a test can supply another. */
export function sdkConnector(options: SdkConnectorOptions): McpConnector {
  const name = options.clientName ?? CLIENT_NAME;
  const version = options.clientVersion ?? CLIENT_VERSION;
  // The one cast, for the `sessionId` discrepancy noted on `ClientTransport`.
  // Every member the client actually uses is identical.
  const makeTransport =
    options.transports ??
    ((spec: McpConnectionSpec, auth: OAuthClientProvider | undefined) =>
      buildTransport(spec, auth) as Transport);

  return async (
    spec: McpConnectionSpec,
    context: McpConnectContext,
  ): Promise<McpSession> => {
    const toolListListeners = new Set<() => void>();
    const closeListeners = new Set<(error?: Error) => void>();

    const auth = context.auth;

    /** One client over one transport, connected. Both are discarded on failure. */
    const attempt = async (): Promise<{ client: Client }> => {
      const client = new Client(
        { name, version },
        {
          capabilities: {},
          // The SDK debounces and re-lists for us. Doing it by hand with
          // `setNotificationHandler` would be a second copy of behaviour the
          // client already has, and a worse one — it re-lists on our behalf so
          // the notification and the fetch cannot race.
          listChanged: {
            tools: {
              onChanged: () => {
                for (const listener of [...toolListListeners]) listener();
              },
            },
          },
        },
      );
      const transport = makeTransport(spec, auth);
      if (transport instanceof StdioClientTransport) {
        const onServerLog =
          context.onServerLog ??
          ((line: string) => {
            options.logger.debug({ server: spec.serverId, line }, 'mcp stderr');
          });
        pipeStderr(transport, onServerLog);
      }
      try {
        await client.connect(transport, { signal: context.signal });
      } catch (error) {
        // The transport may be half-open; leaving it behind would leak a
        // subprocess or a socket for every failed attempt, and attempts are on
        // a retry loop.
        await transport.close().catch(() => undefined);
        throw error;
      }
      return { client };
    };

    let connected: { client: Client };
    try {
      connected = await attempt();
    } catch (error) {
      const wait = context.awaitAuthorizationCode;
      if (!(error instanceof UnauthorizedError) || wait === undefined) {
        throw asGhostError(error);
      }
      // By now the provider's `redirectToAuthorization` has run, so the
      // operator has a link. This resolves when they follow it.
      const code = await wait();
      const failed = makeTransport(spec, auth);
      try {
        // On a fresh transport rather than the one that just failed: the
        // exchange only needs the provider, which holds the verifier, and the
        // failed one has already been closed above.
        await finishAuthorization(failed, code);
      } finally {
        await failed.close().catch(() => undefined);
      }
      // The provider has saved the tokens, so this attempt carries them.
      connected = await attempt().catch((retryError: unknown) => {
        throw asGhostError(retryError);
      });
    }

    const { client } = connected;
    client.onclose = (): void => {
      for (const listener of [...closeListeners]) listener();
    };
    client.onerror = (error: Error): void => {
      for (const listener of [...closeListeners]) listener(error);
    };

    const info = client.getServerVersion();

    return {
      serverName: info?.name ?? spec.serverId,
      serverVersion: info?.version ?? '',

      async listTools(
        signal: AbortSignal,
      ): Promise<readonly McpToolDescriptor[]> {
        try {
          const page = await client.listTools(undefined, { signal });
          return page.tools;
        } catch (error) {
          throw asGhostError(error);
        }
      },

      async callTool(
        toolName: string,
        args: Record<string, unknown>,
        callOptions: McpCallOptions,
      ): Promise<McpCallResult> {
        try {
          const result = await client.callTool(
            { name: toolName, arguments: args },
            undefined,
            {
              signal: callOptions.signal,
              ...(callOptions.timeoutMs > 0
                ? {
                    timeout: callOptions.timeoutMs,
                    // A tool reporting progress is a tool that is working. The
                    // timeout is for a server that has stopped answering, not
                    // for one doing something slow and saying so.
                    resetTimeoutOnProgress: true,
                  }
                : {}),
            },
          );
          return result as McpCallResult;
        } catch (error) {
          throw asGhostError(error);
        }
      },

      onToolListChanged(listener: () => void): void {
        toolListListeners.add(listener);
      },

      onClose(listener: (error?: Error) => void): void {
        closeListeners.add(listener);
      },

      async close(): Promise<void> {
        // Listeners first: `close()` fires `onclose`, and a connection that has
        // been told to shut down must not read its own teardown as a drop and
        // arm a reconnect.
        toolListListeners.clear();
        closeListeners.clear();
        await client.close().catch(() => undefined);
      },
    };
  };
}
