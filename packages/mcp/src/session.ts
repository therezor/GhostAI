/**
 * What this package needs from a live MCP server, and nothing else.
 *
 * Five methods, and the reason for the interface rather than passing the SDK's
 * `Client` around is stated once here: **`sdk-connector.ts` is the only module
 * in this package that imports `@modelcontextprotocol/sdk`.** Everything above
 * it — the bridge, the connection's state machine, the manager's reconciliation
 * — is written against these types.
 *
 * That buys two things worth the indirection. A test drives a session that is
 * an object literal, so nothing in CI spawns a subprocess or opens a socket to
 * prove that a backoff timer fires. And a breaking change in the SDK is a
 * change to one file rather than to every file that touched a client.
 *
 * The rule is about what is *loaded*, not what is named: the `import type`
 * below erases at compile time, so this module still pulls no SDK code into
 * anyone's graph while keeping the compiler's opinion about what an auth
 * provider is.
 */

import type { ToolAnnotations } from '@ghostwire/protocol';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';

import type { McpConnectionSpec } from './spec.js';

/** One tool as a server advertises it. Structurally the SDK's `Tool`. */
export interface McpToolDescriptor {
  readonly name: string;
  readonly title?: string | undefined;
  readonly description?: string | undefined;
  /** Raw JSON Schema. Normalised by `schema.ts` before it is advertised. */
  readonly inputSchema: unknown;
  /**
   * Passed through unchanged, because `ToolAnnotationsSchema` in
   * `@ghostwire/protocol` was written to mirror MCP's vocabulary exactly. There
   * is no mapping table here and there should never be one.
   */
  readonly annotations?: ToolAnnotations | undefined;
}

/** One part of a tool result. Structurally the SDK's `ContentBlock`. */
export interface McpContentPart {
  readonly type: string;
  readonly text?: string | undefined;
  readonly data?: string | undefined;
  readonly mimeType?: string | undefined;
  readonly uri?: string | undefined;
  readonly resource?:
    | {
        readonly uri?: string;
        readonly text?: string;
        readonly mimeType?: string;
      }
    | undefined;
}

export interface McpCallResult {
  readonly content?: readonly McpContentPart[] | undefined;
  readonly isError?: boolean | undefined;
  readonly structuredContent?: unknown;
}

export interface McpCallOptions {
  readonly signal: AbortSignal;
  /** `0` means no per-call cap; the registry's own timeout still applies. */
  readonly timeoutMs: number;
}

export interface McpSession {
  readonly serverName: string;
  readonly serverVersion: string;
  listTools(signal: AbortSignal): Promise<readonly McpToolDescriptor[]>;
  callTool(
    name: string,
    args: Record<string, unknown>,
    options: McpCallOptions,
  ): Promise<McpCallResult>;
  /** The server said its tool list moved. Fired at most once per change. */
  onToolListChanged(listener: () => void): void;
  /** The transport went away — a crash, a network drop, a `close()`. */
  onClose(listener: (error?: Error) => void): void;
  close(): Promise<void>;
}

/**
 * The SDK's `OAuthClientProvider`, named here so callers need not import it.
 *
 * A **type-only** import, like the one in `oauth.ts`: the rule this package
 * holds is that no module but `sdk-connector.ts` *loads* the SDK, and
 * `import type` erases entirely. A structural duck-type was the alternative and
 * it is strictly worse — it would let a provider that has drifted from the
 * interface compile here and fail at the one call site that matters.
 */
export type McpAuthProvider = OAuthClientProvider;

export interface McpConnectContext {
  readonly signal: AbortSignal;
  readonly auth?: McpAuthProvider | undefined;
  /**
   * Resolves with an authorization code once the operator has followed the
   * link. Absent means "do not wait" — a connection with no way to ask.
   *
   * The wait lives behind this callback rather than in the caller because
   * finishing the flow means calling `finishAuth` on the *transport*, and the
   * transport is only ever visible inside the connector. Everything above it
   * would otherwise need a handle on an SDK object.
   */
  readonly awaitAuthorizationCode?: (() => Promise<string>) | undefined;
  /** Where a stdio child's stderr goes. */
  readonly onServerLog?: ((line: string) => void) | undefined;
}

/**
 * Opens one connection. The seam a test replaces with a fake.
 *
 * Rejects rather than reporting: a connector's only job is to hand back a
 * session or say why it could not, and `McpConnection` is what turns a
 * rejection into a state and a retry.
 */
export type McpConnector = (
  spec: McpConnectionSpec,
  context: McpConnectContext,
) => Promise<McpSession>;
