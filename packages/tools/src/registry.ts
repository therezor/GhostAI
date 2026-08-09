/**
 * The tool registry: what the model is offered, and the one path by which a
 * tool is called.
 *
 * The Python source kept its registry in module globals — `_registry`,
 * `_mcp_sessions`, `_mcp_wrapped_tools` and a lock to coordinate them — which is
 * why it has a regression test named after the resulting bug. This is a class,
 * instantiated per agent, and everything registered carries the source that
 * registered it. That tag is what makes `unregisterBySource('extension')` exact:
 * uninstalling an extension removes its tools and nothing else, where the Python
 * equivalent deleted `sys.modules` entries and restarted a subprocess.
 *
 * Two properties matter more than they look:
 *
 *  - **`definitions()` is memoised and sorted by name.** Tool definitions sit in
 *    the prompt prefix that providers cache. An MCP server reconnecting and
 *    re-registering its tools in a different order would rewrite that prefix and
 *    throw the cache away for no semantic change, so the order is the name order
 *    rather than the insertion order. The memo is invalidated on every mutation,
 *    which is the only way it can be wrong.
 *
 *  - **`execute` never throws.** A failed tool call is a legal history entry —
 *    the model needs to see the error to recover from it — so every failure
 *    comes back as a `ToolExecution` with `isError` set and a `kind` from the
 *    core taxonomy. A caller that has to wrap each call in `try` eventually
 *    forgets to, and the turn dies instead of the call.
 */

import {
  GhostError,
  isAbortError,
  silentLogger,
  systemClock,
  toGhostError,
  truncateHeadTail,
  onAbort,
} from '@ghostwire/core';
import type {
  AbortSubscription,
  Clock,
  ErrorKind,
  Logger,
} from '@ghostwire/core';
import type {
  ToolDefinition,
  ToolPermission,
  ToolPermissions,
  ToolSource,
} from '@ghostwire/protocol';

import {
  toToolResult,
  type AnyTool,
  type ToolContext,
  type ToolResult,
} from './define.js';
import { isEnabled, permissionFor } from './scope.js';

interface ToolRegistryOptions {
  /**
   * Wall-clock cap on a single tool call. `0` disables it.
   *
   * Comes from `agent.toolTimeoutMs`. Enforced with the injected clock, so a
   * test drives it with fake timers instead of waiting.
   */
  readonly timeoutMs?: number;
  readonly clock?: Clock;
  readonly logger?: Logger;
}

/** A call as the provider adapters produce it. `ToolCall` is assignable. */
interface ToolInvocation {
  readonly name: string;
  /** Raw JSON as the model emitted it. Empty or absent means no arguments. */
  readonly argumentsJson?: string;
}

/** The outcome of one call, ready to become a `ToolMessage`. */
export interface ToolExecution {
  readonly name: string;
  readonly content: string;
  readonly isError: boolean;
  /** Whether `content` was cut down to `config.maxOutputChars`. */
  readonly truncated: boolean;
  readonly durationMs: number;
  /** Present only on failure. `aborted` is a cancellation, not an error to show. */
  readonly errorKind?: ErrorKind;
  /** Audit context from the handler. Not sent to the model. */
  readonly details?: Readonly<Record<string, unknown>>;
}

interface Registration {
  readonly tool: AnyTool;
  readonly source: ToolSource;
}

/**
 * What the loop needs from a tool collection: what to advertise, what a name
 * means, and how to call it.
 *
 * `ToolRegistry` implements it, and so does every restricted view of one. The
 * loop takes this rather than the class so that an agent with a tool subset is
 * not a special case anywhere in the turn.
 */
/**
 * A scope with a toolbox's own programs laid over it.
 *
 * A *composition* rather than extra registrations, and the reason is name
 * collision: two toolboxes can both hold `curl`, and one shared registry would
 * have to prefix them into `web-research__curl` — which is the name the model
 * would then have to type. Each agent instead sees its own box's programs under
 * the names they actually have, and nothing is shared between agents.
 *
 * The overlay wins on a clash with a built-in, which is deliberate but should
 * never happen: a toolbox declaring `read_file` would shadow the jailed one, so
 * `assertToolboxPolicy` refuses the built-in names outright.
 */
export function withToolboxTools(
  base: ToolScope,
  tools: readonly AnyTool[],
  permissions: ToolPermissions,
  options: ToolRegistryOptions = {},
): ToolScope {
  if (tools.length === 0) return base;

  const overlay = new Map(tools.map((tool) => [tool.name, tool]));
  // Its own registry, so the timeout, the abort race, the output cap and the
  // never-throws contract come from one implementation rather than two. It gets
  // the same permission map the base was built from, so a toolbox program the
  // agent switched off is filtered here exactly as a built-in would be.
  //
  // The clock and the logger are handed in for the same reason: constructed
  // bare, this registry silently took `systemClock` and `silentLogger` while
  // the base ran on the injected ones, so a toolbox program's `durationMs` came
  // off a different clock than a built-in's and its execution was logged
  // nowhere.
  //
  // `timeoutMs` is deliberately *not* inherited. A toolbox program is a process
  // and `guardExec` already gives it `plan.timeoutMs`; putting the agent's
  // `toolTimeoutMs` on top would add a second, tighter cap and start killing
  // container commands that run legitimately long. That is a product decision
  // about what `toolTimeoutMs` means, not something a caller should acquire by
  // passing an options bag through.
  const registry = new ToolRegistry({
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });
  for (const tool of tools) registry.register(tool, 'builtin');
  const scoped = registry.select(permissions);

  let cached: readonly ToolDefinition[] | null = null;
  let cachedFrom: readonly ToolDefinition[] | null = null;

  return {
    definitions(): readonly ToolDefinition[] {
      const underneath = base.definitions();
      // Memoised against the base's own array identity, which the registry
      // already keys on its revision — so an extension registering late still shows
      // up, and a turn that asks twice does not re-sort.
      if (cached !== null && cachedFrom === underneath) return cached;
      const merged = [
        ...underneath.filter((definition) => !overlay.has(definition.name)),
        ...scoped.definitions(),
      ].sort((left, right) =>
        left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
      );
      cached = Object.freeze(merged);
      cachedFrom = underneath;
      return cached;
    },
    get(name: string): AnyTool | undefined {
      return overlay.has(name) ? scoped.get(name) : base.get(name);
    },
    permissionFor(name: string): ToolPermission {
      return overlay.has(name)
        ? scoped.permissionFor(name)
        : base.permissionFor(name);
    },
    async execute(
      call: ToolInvocation,
      context: ToolContext,
    ): Promise<ToolExecution> {
      return overlay.has(call.name)
        ? await scoped.execute(call, context)
        : await base.execute(call, context);
    },
  };
}

export interface ToolScope {
  /** The definitions to send to the provider. Sorted, memoised, frozen. */
  definitions(): readonly ToolDefinition[];
  /** `undefined` for a name this scope cannot see, whoever else registered it. */
  get(name: string): AnyTool | undefined;
  /**
   * What this scope permits for `name` — the whole of the gate's input.
   *
   * On the scope rather than looked up from config by the caller, because the
   * scope is the only thing that knows where a name came from: a toolbox
   * program and a built-in of the same name resolve to different tools, and a
   * caller reading one map would answer for the wrong one.
   */
  permissionFor(name: string): ToolPermission;
  execute(call: ToolInvocation, context: ToolContext): Promise<ToolExecution>;
}

/**
 * A restricted view of one registry.
 *
 * Holds the registry rather than a snapshot of it: an extension registering a tool
 * after boot has to become visible to every agent whose permissions admit it,
 * and a view built once at agent-resolution time would never see it. The memo
 * is keyed on the registry's revision for exactly that reason.
 */
class RegistryScope implements ToolScope {
  private cached: readonly ToolDefinition[] | null = null;
  private cachedRevision = -1;

  constructor(
    private readonly registry: ToolRegistry,
    private readonly permissions: ToolPermissions,
  ) {}

  definitions(): readonly ToolDefinition[] {
    if (
      this.cached !== null &&
      this.cachedRevision === this.registry.revision
    ) {
      return this.cached;
    }
    const definitions = this.registry
      .definitions()
      .filter((definition) => isEnabled(this.permissions, definition.name));
    this.cached = Object.freeze(definitions);
    this.cachedRevision = this.registry.revision;
    return this.cached;
  }

  get(name: string): AnyTool | undefined {
    if (!isEnabled(this.permissions, name)) return undefined;
    return this.registry.get(name);
  }

  permissionFor(name: string): ToolPermission {
    return permissionFor(this.permissions, name);
  }

  execute(call: ToolInvocation, context: ToolContext): Promise<ToolExecution> {
    return this.registry.execute(call, context, this.permissions);
  }
}

/**
 * `signal.aborted`, read through a call.
 *
 * Reading the property directly would be narrowed by TypeScript: after the
 * early `if (context.signal.aborted) return` below, control-flow analysis holds
 * that it is `false` for the rest of the function and reports every later check
 * as dead code. It is not dead — the whole point of the value is that it
 * changes while the function is running — so the read has to be opaque to the
 * narrower.
 */
function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

/**
 * A promise that rejects when `signal` fires, and a way to stop listening.
 *
 * The listener has to be removable: one turn can make dozens of tool calls
 * against the same long-lived signal, and a listener left behind per call is an
 * accumulating leak on an object that lives as long as the request.
 */
function rejectOnAbort(
  signal: AbortSignal,
  name: string,
): { readonly promise: Promise<never>; dispose(): void } {
  // Rejects rather than resolves: a cancelled call has to unwind out of
  // `execute`, not report an outcome. `onAbort` owns the subscription — firing
  // for a signal that already aborted, and detaching afterwards.
  let subscription: AbortSubscription | undefined;
  const promise = new Promise<never>((resolve, reject) => {
    subscription = onAbort(signal, () => {
      reject(new GhostError('aborted', `Tool ${name} aborted`));
    });
  });
  return {
    promise,
    dispose(): void {
      subscription?.dispose();
    },
  };
}

export class ToolRegistry {
  private readonly tools = new Map<string, Registration>();
  private currentTimeoutMs: number;
  private readonly clock: Clock;
  private readonly logger: Logger;
  private cachedDefinitions: readonly ToolDefinition[] | null = null;
  private revisionCount = 0;
  private readonly listeners = new Set<() => void>();

  constructor(options: ToolRegistryOptions = {}) {
    this.currentTimeoutMs = options.timeoutMs ?? 0;
    this.clock = options.clock ?? systemClock;
    this.logger = options.logger ?? silentLogger;
  }

  get size(): number {
    return this.tools.size;
  }

  /**
   * Bumped on every mutation. A scope memoising a filtered definition list keys
   * on it, so a tool registered after the scope was built still shows up.
   */
  get revision(): number {
    return this.revisionCount;
  }

  /**
   * Watches for a change to what is registered.
   *
   * The seam a transport reaches an MCP reconnection or an extension load through,
   * without either of them knowing a transport exists. A server connecting
   * calls `register`; `invalidate` is the one funnel every mutation already
   * passes through; the WebSocket's `tools.changed` frame falls out.
   *
   * **A listener is told that something changed, not what.** The definitions
   * are one memoised call away and a diff nobody asked for would be a second
   * thing to keep correct. Callers should coalesce: registering a server's
   * forty tools is forty mutations and should be one frame.
   *
   * A listener that throws is logged and detached rather than allowed to fail
   * the registration that notified it — a socket that has gone away must not
   * stop a tool being registered.
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Every mutation goes through here, so no path can bump one and not the other. */
  private invalidate(): void {
    this.cachedDefinitions = null;
    this.revisionCount += 1;
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch (error) {
        this.listeners.delete(listener);
        this.logger.warn(
          { error },
          'tool registry listener threw and was detached',
        );
      }
    }
  }

  get timeoutMs(): number {
    return this.currentTimeoutMs;
  }

  /**
   * The one mutable setting on a registry.
   *
   * `agents.defaults.toolTimeoutMs` is editable in the settings panel, and the
   * alternative — building a new registry when it changes — would throw away
   * every MCP and extension registration on it, which is far more than the
   * operator asked to change. A call already in flight keeps the timeout it
   * started under; the timer is armed at entry and never re-read.
   */
  set timeoutMs(ms: number) {
    if (!Number.isFinite(ms) || ms < 0) {
      throw new GhostError(
        'config',
        `Tool timeout must be a non-negative number, got ${String(ms)}`,
      );
    }
    this.currentTimeoutMs = ms;
  }

  /**
   * Registers a tool under its own name.
   *
   * A duplicate is a `conflict` rather than a silent overwrite: two sources
   * claiming one name means the model's calls would go to whichever registered
   * last, and which one that is depends on extension load order. MCP tools are
   * flattened to `mcp_{server}_{tool}` upstream of here for the same reason.
   */
  register(tool: AnyTool, source: ToolSource = 'builtin'): void {
    const existing = this.tools.get(tool.name);
    if (existing !== undefined) {
      throw new GhostError(
        'conflict',
        `Tool ${tool.name} is already registered by ${existing.source}`,
        {
          details: { tool: tool.name, source, existingSource: existing.source },
        },
      );
    }
    this.tools.set(tool.name, { tool, source });
    this.invalidate();
  }

  /** Registers every tool from one source, rolling back if any name collides. */
  registerAll(tools: Iterable<AnyTool>, source: ToolSource = 'builtin'): void {
    const added: string[] = [];
    try {
      for (const tool of tools) {
        this.register(tool, source);
        added.push(tool.name);
      }
    } catch (error) {
      for (const name of added) this.tools.delete(name);
      this.invalidate();
      throw error;
    }
  }

  unregister(name: string): boolean {
    const removed = this.tools.delete(name);
    if (removed) this.invalidate();
    return removed;
  }

  /**
   * Removes everything one source registered. Returns how many went.
   *
   * This is the whole of extension teardown for tools, and it is exact by
   * construction — no name matching, no module-cache surgery, no restart.
   */
  unregisterBySource(source: ToolSource): number {
    let removed = 0;
    for (const [name, registration] of this.tools) {
      if (registration.source !== source) continue;
      this.tools.delete(name);
      removed += 1;
    }
    if (removed > 0) this.invalidate();
    return removed;
  }

  clear(): void {
    if (this.tools.size === 0) return;
    this.tools.clear();
    this.invalidate();
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  get(name: string): AnyTool | undefined {
    return this.tools.get(name)?.tool;
  }

  sourceOf(name: string): ToolSource | undefined {
    return this.tools.get(name)?.source;
  }

  names(): readonly string[] {
    return [...this.tools.keys()].sort();
  }

  /**
   * A view of this registry restricted to what one agent may call.
   *
   * Always a wrapper. There used to be a fast path handing back the registry
   * itself for an agent that restricted nothing, and under the permission model
   * there is no such agent — an empty map is an agent with no tools, not an
   * agent with all of them.
   */
  select(permissions: ToolPermissions): ToolScope {
    return new RegistryScope(this, permissions);
  }

  /**
   * `allow`, always: an unscoped registry is the CLI's and the tests' view, and
   * it is not reachable from a turn. See `permissionFor` in `scope.ts`.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- the name is part of the signature callers type against
  permissionFor(name: string): ToolPermission {
    return 'allow';
  }

  /** The definitions to send to the provider. Sorted, memoised, frozen. */
  definitions(): readonly ToolDefinition[] {
    if (this.cachedDefinitions !== null) return this.cachedDefinitions;
    // Code-unit order, not `localeCompare`: the sort feeds a cached prompt
    // prefix, and a locale-dependent order would make that prefix differ
    // between the developer's machine and the container it ships in.
    const definitions = [...this.tools.values()]
      .map((registration) => registration.tool.definition(registration.source))
      .sort((left, right) =>
        left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
      );
    this.cachedDefinitions = Object.freeze(definitions);
    return this.cachedDefinitions;
  }

  /**
   * Validates, runs, bounds and reports one call. Never throws.
   *
   * The timeout is raced against the handler rather than merely signalled to
   * it, because a handler that ignores its signal would otherwise hang the turn
   * forever. Racing cannot unwind work already in flight — nothing in
   * JavaScript can — which is why every built-in also takes the signal and why
   * `exec` hands it to the child process.
   */
  async execute(
    call: ToolInvocation,
    context: ToolContext,
    permissions?: ToolPermissions,
  ): Promise<ToolExecution> {
    const startedAt = this.clock.monotonic();
    const registration = this.tools.get(call.name);

    // A tool the scope hides is indistinguishable from one that does not exist,
    // deliberately: the model was never offered it, and an error that admitted
    // it exists but is off-limits would invite the model to argue about it. The
    // available list is the scope's, so the suggestion is actionable.
    if (registration === undefined || !isEnabled(permissions, call.name)) {
      const available = this.names().filter((name) =>
        isEnabled(permissions, name),
      );
      return this.failure(
        call.name,
        new GhostError(
          'not_found',
          `No tool named ${call.name}. Available: ${available.join(', ')}`,
        ),
        startedAt,
        context,
      );
    }

    let raw: unknown;
    try {
      raw = parseArguments(call.argumentsJson);
    } catch (error) {
      return this.failure(
        call.name,
        toGhostError(error, 'invalid_input'),
        startedAt,
        context,
      );
    }

    // Checked before the handler is entered rather than left to the race below.
    // A turn cancelled while a `write_file` call was queued must not perform the
    // write and only then notice, and a handler cannot be trusted to check
    // first when the registry can guarantee it.
    if (context.signal.aborted) {
      return this.failure(
        call.name,
        new GhostError('aborted', `Tool ${call.name} aborted`),
        startedAt,
        context,
      );
    }

    const timeout = new AbortController();
    const timer =
      this.timeoutMs > 0
        ? this.clock.setTimeout(() => {
            timeout.abort();
          }, this.timeoutMs)
        : undefined;
    const signal = AbortSignal.any([context.signal, timeout.signal]);
    const abortRace = rejectOnAbort(signal, call.name);

    try {
      const running = registration.tool.run(raw, { ...context, signal });
      // The race may settle on the abort side while `running` is still in
      // flight; without this its eventual rejection would surface as an
      // unhandled rejection and, under Node's default, take the process down.
      void running.catch(() => undefined);

      const output = await Promise.race([running, abortRace.promise]);
      const result = toToolResult(output);
      return this.success(call.name, result, startedAt, context);
    } catch (error) {
      const failure =
        isAborted(timeout.signal) && !isAborted(context.signal)
          ? new GhostError(
              'timeout',
              `Tool ${call.name} timed out after ${String(this.timeoutMs)} ms`,
              { cause: error },
            )
          : toGhostError(error, 'tool');
      return this.failure(call.name, failure, startedAt, context);
    } finally {
      abortRace.dispose();
      if (timer !== undefined) this.clock.clearTimeout(timer);
    }
  }

  private success(
    name: string,
    result: ToolResult,
    startedAt: number,
    context: ToolContext,
  ): ToolExecution {
    const durationMs = this.clock.monotonic() - startedAt;
    const capped = truncateHeadTail(
      result.content,
      context.config.maxOutputChars,
    );
    this.logger.debug(
      {
        tool: name,
        durationMs,
        truncated: capped.truncated,
        isError: result.isError ?? false,
      },
      'tool executed',
    );
    return {
      name,
      content: capped.text,
      isError: result.isError ?? false,
      truncated: capped.truncated,
      durationMs,
      ...(result.details === undefined ? {} : { details: result.details }),
    };
  }

  private failure(
    name: string,
    error: GhostError,
    startedAt: number,
    context: ToolContext,
  ): ToolExecution {
    const durationMs = this.clock.monotonic() - startedAt;
    const capped = truncateHeadTail(
      error.message,
      context.config.maxOutputChars,
    );
    // An abort is the user pressing Stop. Logged at debug, not warn, or every
    // cancelled turn fills the log with things nobody needs to act on.
    const line = { tool: name, durationMs, kind: error.kind };
    if (isAbortError(error)) this.logger.debug(line, 'tool aborted');
    else this.logger.warn(line, 'tool failed');
    return {
      name,
      content: capped.text,
      isError: true,
      truncated: capped.truncated,
      durationMs,
      errorKind: error.kind,
      ...(Object.keys(error.details).length === 0
        ? {}
        : { details: error.details }),
    };
  }
}

/**
 * The model's `argumentsJson` as a value.
 *
 * An empty or whitespace-only string is what providers emit for a no-argument
 * call, and it is not malformed JSON — it is the absence of arguments, which
 * the schema's own `required` list is the right thing to judge.
 */
function parseArguments(argumentsJson: string | undefined): unknown {
  if (argumentsJson === undefined || argumentsJson.trim() === '') return {};
  try {
    return JSON.parse(argumentsJson);
  } catch (error) {
    throw new GhostError(
      'invalid_input',
      `Tool arguments are not valid JSON: ${argumentsJson}`,
      {
        cause: error,
      },
    );
  }
}
