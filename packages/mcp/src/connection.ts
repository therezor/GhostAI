/**
 * One MCP server: its session, its tools, and what to do when it goes away.
 *
 * The contract that shapes everything here is that **nothing this class does
 * can fail a caller.** `start` returns `void`, `reconcile` on the manager is
 * synchronous, and `Runtime#build` calls into it from the region whose comment
 * says "past here nothing throws". A server that is unreachable is a state to
 * report, not an error to raise — the same stance an unconfigured provider
 * already has, and for the same reason: an operator editing one server's URL
 * must not lose the save because of it.
 *
 * Reconnection is full-jitter exponential backoff on the **injected clock**, so
 * a test asserts the cadence instead of waiting for it. There is no attempt
 * cap: a laptop that was asleep for an hour has to come back without an
 * operator, and a cap is a quiet decision to stop trying. What is capped is the
 * *log*, at one warning per outage.
 *
 * The one state that does not retry is `needs_authorization`. Looping on a
 * redirect nobody is going to follow spends the authorization server's rate
 * limit to reach the same answer.
 */

import { GhostError, silentLogger, systemClock } from '@ghostai/core';
import type { Clock, Logger, TimerHandle } from '@ghostai/core';
import { systemRandom } from '@ghostai/security';
import type { McpServerState, McpServerStatus } from '@ghostai/protocol';
import type { AnyTool } from '@ghostai/tools';

import { bridgeTool } from './bridge.js';
import { selectTools } from './filter.js';
import { flattenToolNames } from './names.js';
import type {
  McpAuthProvider,
  McpConnector,
  McpSession,
  McpToolDescriptor,
} from './session.js';
import {
  exposureFingerprint,
  transportFingerprint,
  type McpConnectionSpec,
} from './spec.js';

export interface BackoffOptions {
  readonly initialMs?: number;
  readonly factor?: number;
  readonly maxMs?: number;
  /** Injected so a test gets a cadence rather than a distribution. */
  readonly jitter?: (ceilingMs: number) => number;
}

const DEFAULT_BACKOFF = {
  initialMs: 1_000,
  factor: 2,
  maxMs: 60_000,
} as const;

/**
 * Full jitter, from the same CSPRNG everything else here uses.
 *
 * `Math.random()` is banned repo-wide because it makes a test's outcome depend
 * on the run, and the rule is right even where — as here — the value is a
 * politeness rather than a secret: a dozen servers behind one flaky network
 * must not retry in lockstep. A test injects a `jitter` and gets a cadence.
 */
function jitteredDelay(ceilingMs: number): number {
  const sample = systemRandom(4).readUInt32BE(0) / 2 ** 32;
  return sample * ceilingMs;
}

/** Where an authorization link is asked for, and where the code comes back. */
interface AuthorizationAttempt {
  readonly auth: McpAuthProvider;
  readonly code: () => Promise<string>;
  cancel(reason: string): void;
}

export interface AuthorizationBroker {
  /**
   * Prepares one attempt. Resolves before the connection is dialled, so the
   * provider it produces already knows its redirect URL and `state`.
   */
  begin(serverId: string): Promise<AuthorizationAttempt>;
}

interface McpConnectionOptions {
  readonly spec: McpConnectionSpec;
  readonly connect: McpConnector;
  /** Called whenever this server's contribution to the registry changes. */
  readonly publish: (serverId: string, tools: readonly AnyTool[]) => void;
  /** Called whenever `status` would answer differently. */
  readonly onStatusChanged?: (() => void) | undefined;
  readonly authorization?: AuthorizationBroker | undefined;
  readonly clock?: Clock;
  readonly logger?: Logger;
  readonly backoff?: BackoffOptions;
}

export class McpConnection {
  private currentSpec: McpConnectionSpec;
  private readonly clock: Clock;
  private readonly logger: Logger;
  private readonly backoff: Required<Omit<BackoffOptions, 'jitter'>> & {
    jitter: (ceilingMs: number) => number;
  };

  private currentState: McpServerState = 'connecting';
  private session: McpSession | undefined;
  private descriptors: readonly McpToolDescriptor[] = [];
  private currentTools: readonly AnyTool[] = [];
  private currentWarnings: readonly string[] = [];
  private filtered: readonly string[] = [];
  private lastError: string | undefined;
  private authorizationUrl: string | undefined;
  private lastConnectedAtMs: number | undefined;

  private attempts = 0;
  private timer: TimerHandle | undefined;
  private controller: AbortController | undefined;
  private closed = false;
  /** Bumped on every (re)connect so a slow attempt cannot publish over a new one. */
  private generation = 0;
  private warnedThisOutage = false;

  constructor(private readonly options: McpConnectionOptions) {
    this.currentSpec = options.spec;
    this.clock = options.clock ?? systemClock;
    this.logger = options.logger ?? silentLogger;
    this.backoff = {
      initialMs: options.backoff?.initialMs ?? DEFAULT_BACKOFF.initialMs,
      factor: options.backoff?.factor ?? DEFAULT_BACKOFF.factor,
      maxMs: options.backoff?.maxMs ?? DEFAULT_BACKOFF.maxMs,
      jitter: options.backoff?.jitter ?? jitteredDelay,
    };
  }

  get serverId(): string {
    return this.currentSpec.serverId;
  }

  get spec(): McpConnectionSpec {
    return this.currentSpec;
  }

  get state(): McpServerState {
    return this.currentState;
  }

  get tools(): readonly AnyTool[] {
    return this.currentTools;
  }

  get status(): McpServerStatus {
    return {
      id: this.currentSpec.serverId,
      transport: this.currentSpec.kind,
      state: this.currentState,
      enabled: true,
      tools: this.currentTools.map((tool) => tool.name).sort(),
      filteredTools: [...this.filtered],
      serverName: this.session?.serverName ?? '',
      serverVersion: this.session?.serverVersion ?? '',
      warnings: [...this.currentWarnings],
      ...(this.lastError === undefined ? {} : { lastError: this.lastError }),
      ...(this.authorizationUrl === undefined
        ? {}
        : { authorizationUrl: this.authorizationUrl }),
      ...(this.lastConnectedAtMs === undefined
        ? {}
        : { lastConnectedAtMs: this.lastConnectedAtMs }),
    };
  }

  /** Begins connecting. Fire-and-forget by contract; never rejects. */
  start(): void {
    if (this.closed) return;
    this.attempts = 0;
    this.warnedThisOutage = false;
    void this.dial();
  }

  /**
   * Applies a spec that changed only in what it exposes.
   *
   * The whole reason `spec.ts` keeps two fingerprints: narrowing `enabledTools`
   * is the edit an operator makes most, and killing a subprocess to re-filter a
   * list already in memory would be a visible stall for no reason.
   */
  rebridge(spec: McpConnectionSpec): void {
    if (transportFingerprint(spec) !== transportFingerprint(this.currentSpec)) {
      throw new GhostError(
        'internal',
        'rebridge was given a spec that needs a new connection',
      );
    }
    if (exposureFingerprint(spec) === exposureFingerprint(this.currentSpec)) {
      return;
    }
    this.currentSpec = spec;
    if (this.currentState === 'ready') this.republish();
  }

  async close(): Promise<void> {
    this.closed = true;
    this.generation += 1;
    this.disarm();
    this.controller?.abort();
    this.controller = undefined;
    const session = this.session;
    this.session = undefined;
    this.currentState = 'disabled';
    this.setTools([]);
    // Failing to close is not something a caller can act on, and it must not
    // stop the rest of a shutdown.
    await session?.close().catch(() => undefined);
  }

  private disarm(): void {
    if (this.timer === undefined) return;
    this.clock.clearTimeout(this.timer);
    this.timer = undefined;
  }

  private setTools(tools: readonly AnyTool[]): void {
    this.currentTools = tools;
    this.options.publish(this.currentSpec.serverId, tools);
  }

  private changed(): void {
    this.options.onStatusChanged?.();
  }

  private async dial(): Promise<void> {
    if (this.closed) return;
    const generation = (this.generation += 1);
    this.currentState = 'connecting';
    this.authorizationUrl = undefined;
    this.changed();

    const controller = new AbortController();
    this.controller = controller;

    // Only for a server that both wants OAuth and has somewhere to ask.
    const broker =
      this.currentSpec.kind !== 'stdio' &&
      this.currentSpec.oauth !== undefined &&
      this.options.authorization !== undefined
        ? this.options.authorization
        : undefined;

    let pending: AuthorizationAttempt | undefined;

    try {
      pending = await broker?.begin(this.currentSpec.serverId);
      const attempt = pending;
      const session = await this.options.connect(this.currentSpec, {
        signal: controller.signal,
        ...(attempt === undefined
          ? {}
          : { auth: attempt.auth, awaitAuthorizationCode: attempt.code }),
      });
      if (this.stale(generation)) {
        await session.close().catch(() => undefined);
        return;
      }
      this.adopt(session, generation);
    } catch (error) {
      pending?.cancel('The connection attempt ended');
      if (this.stale(generation)) return;
      this.fail(error);
    }
  }

  /**
   * Whether an outcome that has just arrived still belongs to this connection.
   *
   * A method rather than the two reads written out, and for a reason beyond
   * brevity: `dial` returns early when `closed` is set, so control-flow
   * analysis holds it `false` for the rest of the function and reports every
   * later check as dead code. It is not dead — the whole point of the field is
   * that it changes while the function is awaiting — so the read has to be
   * opaque to the narrower. `ToolRegistry` has the same shape, for the same
   * reason, around its abort signal.
   */
  private stale(generation: number): boolean {
    return generation !== this.generation || this.closed;
  }

  private adopt(session: McpSession, generation: number): void {
    this.session = session;
    this.attempts = 0;
    this.warnedThisOutage = false;
    this.lastError = undefined;
    this.authorizationUrl = undefined;
    this.lastConnectedAtMs = this.clock.now();

    session.onClose((error?: Error) => {
      if (this.stale(generation)) return;
      this.session = undefined;
      // A drop is not an authorization problem even when it follows one, and
      // the message an operator gets should say which happened.
      this.fail(
        error ??
          new GhostError('network', 'The MCP server closed the connection'),
      );
    });
    session.onToolListChanged(() => {
      if (this.stale(generation)) return;
      void this.refresh(generation);
    });

    void this.refresh(generation);
  }

  /** Re-reads the server's tool list and republishes. */
  private async refresh(generation: number): Promise<void> {
    const session = this.session;
    if (session === undefined) return;
    const controller = this.controller;
    try {
      this.descriptors = await session.listTools(
        controller?.signal ?? AbortSignal.abort(),
      );
    } catch (error) {
      if (this.stale(generation)) return;
      this.fail(error);
      return;
    }
    if (this.stale(generation)) return;
    this.currentState = 'ready';
    this.republish();
  }

  /** Filters, flattens and bridges the descriptors this connection holds. */
  private republish(): void {
    const spec = this.currentSpec;
    const warnings: string[] = [];

    const { selected, unmatched } = selectTools(
      this.descriptors,
      spec.enabledTools,
    );
    this.filtered = this.descriptors
      .filter((descriptor) => !selected.includes(descriptor))
      .map((descriptor) => descriptor.name);
    for (const pattern of unmatched) {
      warnings.push(
        `"${pattern}" in enabledTools matches no tool this server offers`,
      );
    }

    const { names, collisions } = flattenToolNames(
      spec.serverId,
      selected.map((descriptor) => descriptor.name),
    );
    for (const collision of collisions) {
      warnings.push(
        `"${collision}" was renamed: another tool on this server flattens to the same name`,
      );
    }

    const tools: AnyTool[] = [];
    for (const descriptor of selected) {
      const advertisedName = names.get(descriptor.name);
      if (advertisedName === undefined) continue;
      const bridged = bridgeTool({
        serverId: spec.serverId,
        descriptor,
        advertisedName,
        toolTimeoutMs: spec.toolTimeoutMs,
        call: async (upstreamName, args, callOptions) => {
          const session = this.session;
          if (session === undefined) {
            throw new GhostError(
              'network',
              `The ${spec.serverId} MCP server is not connected`,
            );
          }
          return await session.callTool(upstreamName, args, callOptions);
        },
      });
      for (const issue of bridged.issues) {
        warnings.push(`${issue.tool}: ${issue.message}`);
      }
      if ('tool' in bridged) tools.push(bridged.tool);
    }

    this.currentWarnings = warnings;
    this.setTools(tools);
    this.changed();
  }

  /** Records why this server is down and arms the next attempt. */
  private fail(error: unknown): void {
    const ghost =
      error instanceof GhostError
        ? error
        : new GhostError(
            'network',
            error instanceof Error ? error.message : String(error),
          );

    this.descriptors = [];
    this.setTools([]);
    this.session = undefined;
    this.controller = undefined;
    this.lastError = ghost.message;

    const needsAuth = ghost.details.needsAuthorization === true;
    this.currentState = needsAuth ? 'needs_authorization' : 'failed';

    // One warning per outage. A server that has been unreachable since a laptop
    // closed would otherwise write a line a second forever, and the second line
    // says nothing the first did not.
    if (!this.warnedThisOutage) {
      this.warnedThisOutage = true;
      this.logger.warn(
        { server: this.currentSpec.serverId, error: ghost.message },
        'mcp server unavailable',
      );
    } else {
      this.logger.debug(
        { server: this.currentSpec.serverId, error: ghost.message },
        'mcp server still unavailable',
      );
    }

    this.changed();
    if (!needsAuth) this.arm();
  }

  private arm(): void {
    if (this.closed) return;
    this.disarm();
    const ceiling = Math.min(
      this.backoff.maxMs,
      this.backoff.initialMs * this.backoff.factor ** this.attempts,
    );
    this.attempts += 1;
    const delay = Math.max(0, Math.round(this.backoff.jitter(ceiling)));
    this.timer = this.clock.setTimeout(() => {
      this.timer = undefined;
      void this.dial();
    }, delay);
  }

  /** Records the link an operator has to follow. */
  reportAuthorizationUrl(url: string): void {
    this.authorizationUrl = url;
    this.currentState = 'needs_authorization';
    this.changed();
  }
}
