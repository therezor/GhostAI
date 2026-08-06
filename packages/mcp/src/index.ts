/**
 * @ghostai/mcp — third-party tools, from servers an operator configured.
 *
 * It sits above `@ghostai/tools` and below `@ghostai/runtime`, and it is
 * deliberately ignorant of everything on either side of that: it has never
 * heard of a config file, an HTTP route or a WebSocket. The composition root
 * hands `McpManager` a record of servers and a sink, and the rest — a
 * connecting server's tools appearing in the agent editor, a `tools.changed`
 * frame reaching an open tab — falls out of the shared `ToolRegistry` mutating.
 *
 * Two structural rules hold the package together:
 *
 *  - **`sdk-connector.ts` is the only module that loads
 *    `@modelcontextprotocol/sdk` at runtime.** Everything else is written
 *    against `McpSession`, so no test spawns a subprocess or opens a socket to
 *    prove that a backoff timer fires, and an SDK breaking change is one file.
 *  - **Nothing here can fail its caller.** `reconcile` is synchronous and
 *    infallible; a server that is unreachable is a status row, not a thrown
 *    error. `Runtime#build` calls into it from the region whose comment reads
 *    "past here nothing throws".
 *
 * The security posture — why a stdio `command` does not go through `guardExec`
 * and an MCP `url` does not go through `guardedFetch` — is argued where it is
 * enforced, in `sdk-connector.ts` and `spec.ts` respectively. The short version
 * is that both guards exist to constrain what a *model* chose, and these are
 * operator configuration in the same trust class as a provider's `apiBase`.
 */

export {
  exposureFingerprint,
  resolveSpec,
  transportFingerprint,
  type McpConnectionSpec,
} from './spec.js';

export {
  flattenToolName,
  flattenToolNames,
  isAdvertisableName,
} from './names.js';

export {
  compileValidator,
  normaliseSchema,
  type SchemaIssue,
} from './schema.js';

export type {
  McpAuthProvider,
  McpCallOptions,
  McpCallResult,
  McpConnectContext,
  McpConnector,
  McpContentPart,
  McpSession,
  McpToolDescriptor,
} from './session.js';

export { bridgeTool, flattenContent } from './bridge.js';

export { selectTools } from './filter.js';

export {
  memorySecretStore,
  vaultSecretStore,
  type McpSecretStore,
} from './store.js';

export { CallbackListener } from './callback.js';

export { VaultOAuthProvider } from './oauth.js';

export { sdkConnector } from './sdk-connector.js';

export {
  McpConnection,
  type AuthorizationBroker,
  type BackoffOptions,
} from './connection.js';

export { McpManager, type McpToolSink } from './manager.js';
