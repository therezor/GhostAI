/**
 * Every configured MCP server, reconciled against the settings tree.
 *
 * The manager is handed a `Record<string, McpServerConfig>` and diffs it. That
 * is the whole of its coupling: it does not know there is a config *file*, it
 * does not know a save happened, and it has never heard of HTTP or a WebSocket.
 * The composition root hands it the record and supplies a sink; everything else
 * — a connecting server's tools appearing in the agent editor, a `tools.changed`
 * frame reaching an open tab — falls out of the registry mutating.
 *
 * **`reconcile` is synchronous and cannot fail.** `Runtime#build` calls it from
 * the region whose comment reads "past here nothing throws", and an operator
 * saving one server's URL must not lose the save because another server is
 * unreachable. Every dial happens on a background task; every failure lands on
 * a status row.
 *
 * The diff has four outcomes, and the third is the one worth the machinery:
 *
 * | change                            | action                                    |
 * | --------------------------------- | ----------------------------------------- |
 * | gone from config, or `enabled: false` | close, unregister, drop                |
 * | new, or its transport moved       | close the old, construct and start        |
 * | only `enabledTools`/`toolTimeoutMs` | re-bridge from the descriptors in memory |
 * | nothing                           | left entirely alone                       |
 */

import { silentLogger, systemClock } from '@ghostbot/core';
import type { Clock, Logger } from '@ghostbot/core';
import type { McpServerConfig, McpServerStatus } from '@ghostbot/protocol';
import type { ToolSink } from '@ghostbot/tools';
import type { CredentialVault } from '@ghostbot/security';

import { CallbackListener } from './callback.js';
import {
  McpConnection,
  type AuthorizationBroker,
  type BackoffOptions,
} from './connection.js';
import { VaultOAuthProvider } from './oauth.js';
import type { McpConnector } from './session.js';
import {
  resolveSpec,
  transportFingerprint,
  type McpConnectionSpec,
} from './spec.js';
import {
  memorySecretStore,
  vaultSecretStore,
  type McpSecretStore,
} from './store.js';

/**
 * Where a server's tools go.
 *
 * `ToolSink` in `@ghostbot/tools`, under this package's own name for it. The
 * interface moved there when the extension host turned out to need the same
 * one, and the alias stays because "the sink a server's tools go to" is how
 * every call site in this package reads.
 *
 * Implemented in `@ghostbot/runtime`, which is the only place that knows both
 * this interface and `ToolRegistry`.
 */
export type McpToolSink = ToolSink;

interface McpManagerOptions {
  readonly sink: McpToolSink;
  /** Defaults to the real SDK connector; a test supplies a fake. */
  readonly connect: McpConnector;
  readonly clock?: Clock;
  readonly logger?: Logger;
  /** `undefined` keeps OAuth tokens in memory for the life of the process. */
  readonly vault?: CredentialVault | undefined;
  readonly backoff?: BackoffOptions;
  /**
   * Fired after any change to a server's status or its registered tools.
   *
   * Note this is *not* how a tool-list change reaches a transport — that
   * happens through `ToolRegistry.subscribe`, because an extension host will need
   * the same seam and the registry is the thing they have in common. This is
   * for the status list, which nothing else can observe.
   */
  readonly onStatusChanged?: (() => void) | undefined;
  /** Overrides the loopback OAuth callback port. `0` asks for any free one. */
  readonly callbackPort?: number;
}

interface Entry {
  readonly connection: McpConnection;
  readonly fingerprint: string;
}

export class McpManager {
  private readonly connections = new Map<string, Entry>();
  /** Servers that could not even be resolved into a spec. */
  private readonly refused = new Map<string, McpServerStatus>();
  private readonly clock: Clock;
  private readonly logger: Logger;
  private readonly secrets: McpSecretStore;
  private callback: CallbackListener | undefined;
  private closed = false;

  constructor(private readonly options: McpManagerOptions) {
    this.clock = options.clock ?? systemClock;
    this.logger = options.logger ?? silentLogger;
    this.secrets =
      options.vault === undefined
        ? memorySecretStore()
        : vaultSecretStore(options.vault);
  }

  /** How many servers a turn could actually reach right now. */
  get connectedCount(): number {
    let count = 0;
    for (const entry of this.connections.values()) {
      if (entry.connection.state === 'ready') count += 1;
    }
    return count;
  }

  statuses(): readonly McpServerStatus[] {
    const rows = [
      ...this.refused.values(),
      ...[...this.connections.values()].map((entry) => entry.connection.status),
    ];
    return rows.sort((left, right) => (left.id < right.id ? -1 : 1));
  }

  reconcile(servers: Readonly<Record<string, McpServerConfig>>): void {
    if (this.closed) return;
    const seen = new Set<string>();
    this.refused.clear();

    for (const [serverId, config] of Object.entries(servers)) {
      seen.add(serverId);

      if (!config.enabled) {
        this.retire(serverId);
        this.refused.set(serverId, disabledRow(serverId, config));
        continue;
      }

      const resolution = resolveSpec(serverId, config);
      if (!resolution.ok) {
        // A misconfigured entry is a property of the settings tree, so it reads
        // as a failed row rather than a refused save. The operator sees the
        // sentence beside the server it is about.
        this.retire(serverId);
        this.refused.set(serverId, {
          id: serverId,
          ...(config.type === undefined ? {} : { transport: config.type }),
          state: 'failed',
          enabled: true,
          tools: [],
          filteredTools: [],
          serverName: '',
          serverVersion: '',
          warnings: [],
          lastError: resolution.error.message,
        });
        continue;
      }

      this.apply(resolution.spec);
    }

    for (const serverId of [...this.connections.keys()]) {
      if (!seen.has(serverId)) this.retire(serverId);
    }

    this.options.onStatusChanged?.();
  }

  private apply(spec: McpConnectionSpec): void {
    const existing = this.connections.get(spec.serverId);
    const fingerprint = transportFingerprint(spec);

    if (existing?.fingerprint === fingerprint) {
      // Same process, same endpoint. Only what it exposes can have moved, and
      // that is a filter over descriptors this connection already holds.
      existing.connection.rebridge(spec);
      return;
    }

    if (existing !== undefined) this.retire(spec.serverId);

    const connection = new McpConnection({
      spec,
      connect: this.options.connect,
      publish: (serverId, tools) => {
        const rejected = this.options.sink.replace(serverId, tools);
        for (const name of rejected) {
          this.logger.warn(
            { server: serverId, tool: name },
            'mcp tool name is already registered by another source',
          );
        }
      },
      onStatusChanged: this.options.onStatusChanged,
      clock: this.clock,
      logger: this.logger,
      ...(this.options.backoff === undefined
        ? {}
        : { backoff: this.options.backoff }),
      ...(spec.kind === 'stdio' || spec.oauth === undefined
        ? {}
        : { authorization: this.broker(spec) }),
    });

    this.connections.set(spec.serverId, { connection, fingerprint });
    connection.start();
  }

  /**
   * One authorization attempt's provider, callback and code.
   *
   * Built per connection rather than per manager because the `state` that
   * routes a redirect back is minted per attempt, and a provider holds the PKCE
   * verifier for exactly one exchange.
   */
  private broker(spec: McpConnectionSpec): AuthorizationBroker {
    return {
      begin: async (serverId: string) => {
        this.callback ??= new CallbackListener({
          clock: this.clock,
          logger: this.logger,
          ...(this.options.callbackPort === undefined
            ? {}
            : { port: this.options.callbackPort }),
        });
        const oauth = spec.kind === 'stdio' ? undefined : spec.oauth;
        const handle = await this.callback.begin(
          serverId,
          oauth?.callbackTimeoutMs ?? 0,
        );
        const auth = new VaultOAuthProvider({
          serverId,
          // Only reachable for an HTTP spec that carries one; the branch above
          // is what put a broker on this connection at all.
          config: oauth ?? {
            authUrl: '',
            tokenUrl: '',
            clientId: '',
            scopes: [],
            callbackTimeoutMs: 0,
          },
          store: this.secrets,
          redirectUrl: handle.redirectUrl,
          state: handle.state,
          onAuthorizationRequired: (url) => {
            this.connections
              .get(serverId)
              ?.connection.reportAuthorizationUrl(url);
          },
        });
        return {
          auth,
          code: () => handle.code,
          cancel: (reason: string) => {
            handle.cancel(reason);
          },
        };
      },
    };
  }

  private retire(serverId: string): void {
    const entry = this.connections.get(serverId);
    if (entry === undefined) return;
    this.connections.delete(serverId);
    // The tools go now rather than when the close resolves: a turn starting in
    // the meantime must not be offered a tool whose server is being torn down.
    this.options.sink.replace(serverId, []);
    void entry.connection.close().catch((error: unknown) => {
      this.logger.debug({ server: serverId, error }, 'mcp close failed');
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    const entries = [...this.connections.values()];
    this.connections.clear();
    for (const entry of entries) {
      this.options.sink.replace(entry.connection.serverId, []);
    }
    await Promise.all(
      entries.map(async (entry) => {
        await entry.connection.close();
      }),
    );
    await this.callback?.close();
    this.callback = undefined;
  }
}

function disabledRow(
  serverId: string,
  config: McpServerConfig,
): McpServerStatus {
  return {
    id: serverId,
    ...(config.type === undefined ? {} : { transport: config.type }),
    state: 'disabled',
    enabled: false,
    tools: [],
    filteredTools: [],
    serverName: '',
    serverVersion: '',
    warnings: [],
  };
}
