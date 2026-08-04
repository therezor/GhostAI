/**
 * An MCP server that is an object literal.
 *
 * Every test above `sdk-connector.ts` uses this rather than the SDK, which is
 * the whole point of `McpSession` existing: proving that a backoff timer fires
 * on the right cadence should not require a subprocess, and a suite that spawns
 * one is a suite that is slow on a laptop and flaky on a shared runner.
 *
 * `sdk-connector.test.ts` is the one exception and uses a real client over the
 * SDK's linked in-memory transports — the only test that proves the adapter
 * actually speaks the protocol, and it still opens nothing.
 */

import type {
  McpCallOptions,
  McpCallResult,
  McpConnectContext,
  McpConnector,
  McpSession,
  McpToolDescriptor,
} from '#src/session.js';

export interface FakeCall {
  readonly name: string;
  readonly args: Record<string, unknown>;
}

export interface FakeServer {
  /** Hand this to a connection or a manager. */
  readonly connect: McpConnector;
  readonly calls: readonly FakeCall[];
  /** How many times the connector has been asked for a session. */
  readonly attempts: number;
  /** The context of the most recent attempt, for the OAuth assertions. */
  readonly lastContext: McpConnectContext | undefined;
  /** Replaces the advertised list and fires `tools/list_changed`. */
  setTools(tools: readonly McpToolDescriptor[]): void;
  /** The next `connect` rejects with this, then normal service resumes. */
  failNextConnect(error: Error): void;
  /** Every `connect` rejects until `recover()`. */
  failConnects(error: Error): void;
  recover(): void;
  /** What `callTool` answers. Defaults to echoing the arguments. */
  onCall(
    handler: (call: FakeCall) => Promise<McpCallResult> | McpCallResult,
  ): void;
  /** Simulates the server going away mid-session. */
  drop(error?: Error): void;
  /** Whether the session this server last handed out has been closed. */
  readonly closed: boolean;
}

export const ECHO_TOOL: McpToolDescriptor = {
  name: 'echo',
  description: 'Repeats what it is given.',
  inputSchema: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'What to repeat.' },
      times: {
        type: 'integer',
        minimum: 1,
        description: 'How many times to repeat it.',
      },
    },
    required: ['text'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true },
};

export function fakeServer(
  initialTools: readonly McpToolDescriptor[] = [ECHO_TOOL],
): FakeServer {
  const calls: FakeCall[] = [];
  let tools = initialTools;
  let attempts = 0;
  let lastContext: McpConnectContext | undefined;
  let closed = false;
  let oneShotFailure: Error | undefined;
  let standingFailure: Error | undefined;
  let handler: (call: FakeCall) => Promise<McpCallResult> | McpCallResult = (
    call,
  ) => ({ content: [{ type: 'text', text: JSON.stringify(call.args) }] });

  const toolListListeners = new Set<() => void>();
  const closeListeners = new Set<(error?: Error) => void>();

  const connect: McpConnector = async (spec, context) => {
    attempts += 1;
    lastContext = context;
    const failure = oneShotFailure ?? standingFailure;
    oneShotFailure = undefined;
    if (failure !== undefined) throw failure;

    closed = false;
    toolListListeners.clear();
    closeListeners.clear();

    const session: McpSession = {
      serverName: `fake-${spec.serverId}`,
      serverVersion: '1.0.0',
      listTools: async () => await Promise.resolve(tools),
      callTool: async (
        name: string,
        args: Record<string, unknown>,
        options: McpCallOptions,
      ) => {
        void options;
        const call = { name, args };
        calls.push(call);
        return await handler(call);
      },
      onToolListChanged: (listener) => toolListListeners.add(listener),
      onClose: (listener) => closeListeners.add(listener),
      close: async () => {
        closed = true;
        toolListListeners.clear();
        closeListeners.clear();
        await Promise.resolve();
      },
    };
    return session;
  };

  return {
    connect,
    calls,
    get attempts() {
      return attempts;
    },
    get lastContext() {
      return lastContext;
    },
    get closed() {
      return closed;
    },
    setTools(next) {
      tools = next;
      for (const listener of [...toolListListeners]) listener();
    },
    failNextConnect(error) {
      oneShotFailure = error;
    },
    failConnects(error) {
      standingFailure = error;
    },
    recover() {
      standingFailure = undefined;
      oneShotFailure = undefined;
    },
    onCall(next) {
      handler = next;
    },
    drop(error) {
      for (const listener of [...closeListeners]) listener(error);
    },
  };
}
