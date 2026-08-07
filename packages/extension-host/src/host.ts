/**
 * Discover, authorise, load, collect, unload — and never take the boot down.
 *
 * The lifecycle is `McpManager.reconcile`'s, deliberately and in every detail
 * that matters, because the two solve the same problem: a set of external
 * things an operator configures, changing under a running process.
 *
 *  - **`reconcile` is the only entry point.** It takes the whole
 *    `config.extensions` block and works out the difference, rather than
 *    offering add and remove for a caller to sequence correctly.
 *  - **Nothing here throws.** Not a manifest that will not parse, not an
 *    extension that has never been approved, not an `activate` that dies on
 *    line one. Every one of those is a `state` on a row with a sentence beside
 *    it, because a boot that refuses because of one extension out of five is a
 *    worse outcome than a boot that runs with four.
 *  - **Status is a list, not a log.** The panel and `ghost extension list` read
 *    `status()`; nothing has to grep anything.
 *
 * What it does *not* do is apply anything. `tools()`, `channels()`,
 * `providers()`, `contributors()` and `commands()` are accessors, and the
 * composition root is what puts them into a `ToolRegistry`, a `ChannelManager`
 * and an `AgentLoop`. That is the same split `McpToolSink` makes and for the
 * same reason: this package knows what an extension asked for, and the layer
 * above knows where such things go.
 *
 * `reconcile` is async, which `McpManager.reconcile` is not, and that is the
 * one place the analogy breaks. Loading a module is `import()`. The callers
 * that cannot wait — `GhostRuntime.build`, which is synchronous past a
 * documented line — start it and let it settle, and the `tools.changed` frame
 * that `ToolRegistry.subscribe` already emits is what tells every client the
 * set moved. A turn that begins before it settles sees the tools that were
 * there, which is exactly what a turn during an MCP reconnect sees.
 */

import { GhostError, type Clock, type Logger } from '@ghostai/core';
import type { ChannelFactory } from '@ghostai/channels';
import type {
  ExtensionStatus,
  ExtensionsConfig,
  ExtensionCommand as ExtensionCommandDto,
} from '@ghostai/protocol';
import type { ContextContributor } from '@ghostai/agent';
import type { ExtensionStore, ExtensionResolution } from '@ghostai/security';
import type { AnyTool } from '@ghostai/tools';

import type {
  CommandInput,
  CommandResult,
  Extension,
  ExtensionCommand,
  ExtensionContext,
} from './extension.js';
import { importExtension, type ExtensionLoader } from './loader.js';
import {
  RegistrationBag,
  type ProviderRegistration,
  type Registration,
} from './registration.js';

export interface ExtensionHostOptions {
  readonly store: ExtensionStore;
  /** `<root>/extension-data/<id>`, for the directory an extension may write. */
  dataDirFor(id: string): string;
  /** A secret from the vault under the `extensions` namespace. */
  readonly secretFor?: ((id: string) => string | undefined) | undefined;
  readonly logger: Logger;
  readonly clock: Clock;
  /** Faked in every test but `loader.test.ts`. */
  readonly load?: ExtensionLoader | undefined;
}

/** One extension the host currently holds, loaded or not. */
interface Loaded {
  readonly resolution: ExtensionResolution;
  readonly status: ExtensionStatus;
  readonly registration: Registration | undefined;
  readonly extension: Extension | undefined;
  readonly abort: AbortController | undefined;
  /** The digest it was loaded at, so a reconcile can tell "unchanged". */
  readonly digest: string;
}

export class ExtensionHost {
  private readonly options: ExtensionHostOptions;
  private readonly loaded = new Map<string, Loaded>();
  private readonly listeners = new Set<() => void>();
  private revisionCounter = 0;

  constructor(options: ExtensionHostOptions) {
    this.options = options;
  }

  /** Bumped on every change to what is loaded. See `subscribe`. */
  get revision(): number {
    return this.revisionCounter;
  }

  /**
   * The seam a transport reaches a load or an unload through.
   *
   * Separate from `ToolRegistry.subscribe` even though a load usually moves the
   * tool set too: an extension contributing only a channel changes nothing in
   * the registry, and the panel still has to hear about it.
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Brings what is loaded into line with what is installed and configured.
   *
   * Four outcomes per extension, and the third is the one worth naming: an
   * extension whose digest and settings are unchanged is **left running**. A
   * reconcile happens on every settings save, and tearing down and rebuilding a
   * channel because an unrelated panel was edited would drop connections for no
   * reason — the same argument `McpManager` makes about not respawning a
   * subprocess when only `enabledTools` moved.
   */
  async reconcile(config: ExtensionsConfig): Promise<void> {
    const disabled = new Set(config.disabled);
    const wanted = this.discover(config);
    let changed = false;

    for (const [id, entry] of this.loaded) {
      if (!wanted.has(id)) {
        await this.unload(entry);
        this.loaded.delete(id);
        changed = true;
      }
    }

    for (const [id, resolution] of wanted) {
      const settings = settingsFor(config, id);
      const previous = this.loaded.get(id);

      if (disabled.has(id)) {
        if (previous !== undefined) await this.unload(previous);
        this.loaded.set(id, disabledEntry(resolution));
        changed = true;
        continue;
      }

      if (resolution.state !== 'approved') {
        if (previous !== undefined) await this.unload(previous);
        this.loaded.set(id, refusedEntry(resolution));
        changed = true;
        continue;
      }

      if (
        previous?.registration !== undefined &&
        previous.digest === resolution.digest
      ) {
        continue;
      }

      if (previous !== undefined) await this.unload(previous);
      this.loaded.set(id, await this.activate(resolution, settings));
      changed = true;
    }

    if (changed) this.announce();
  }

  /** Unloads everything. Idempotent, and safe to call on a failed boot. */
  async stop(): Promise<void> {
    for (const entry of this.loaded.values()) await this.unload(entry);
    this.loaded.clear();
    this.announce();
  }

  status(): readonly ExtensionStatus[] {
    return [...this.loaded.values()]
      .map((entry) => entry.status)
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  /** How many are actually running. What `GET /api/status` reports. */
  get loadedCount(): number {
    return [...this.loaded.values()].filter(
      (entry) => entry.status.state === 'ready',
    ).length;
  }

  tools(): readonly AnyTool[] {
    return this.collect((registration) => registration.tools);
  }

  channels(): readonly ChannelFactory[] {
    return this.collect((registration) => registration.channels);
  }

  providers(): readonly ProviderRegistration[] {
    return this.collect((registration) => registration.providers);
  }

  contributors(): readonly ContextContributor[] {
    return this.collect((registration) => registration.contributors);
  }

  /** The commands, as the wire describes them. `run` stays on this side. */
  commands(): readonly ExtensionCommandDto[] {
    return [...this.loaded.entries()].flatMap(([id, entry]) =>
      (entry.registration?.commands ?? []).map((command) => ({
        id: command.id,
        extensionId: id,
        description: command.description ?? '',
        argsHint: command.argsHint ?? '',
      })),
    );
  }

  /**
   * Runs one command.
   *
   * Throws where the rest of this class answers, and the asymmetry is the same
   * one `ExtensionStore` makes: this is a request about one command, so a
   * refusal is its answer. A command that throws is turned into a failed
   * result rather than propagated — an extension's bug should read as "that did
   * not work" in the composer, not as a 500.
   */
  async runCommand(id: string, input: CommandInput): Promise<CommandResult> {
    const found = this.findCommand(id);
    if (found === undefined) {
      throw new GhostError('not_found', `No command called "${id}"`, {
        details: { id },
      });
    }
    try {
      return await found.run(input);
    } catch (error) {
      this.options.logger.warn(
        { command: id, err: error },
        'extension command failed',
      );
      return { message: describe(error), ok: false };
    }
  }

  private findCommand(id: string): ExtensionCommand | undefined {
    for (const entry of this.loaded.values()) {
      const found = entry.registration?.commands.find(
        (command) => command.id === id,
      );
      if (found !== undefined) return found;
    }
    return undefined;
  }

  private collect<T>(pick: (registration: Registration) => readonly T[]): T[] {
    return [...this.loaded.values()].flatMap((entry) =>
      entry.registration === undefined ? [] : [...pick(entry.registration)],
    );
  }

  /**
   * Every extension the install knows about: the directory scan, plus whatever
   * `extensions.load` names.
   *
   * An explicit path **wins** over an install-directory entry with the same id,
   * because it is the more specific statement: a scan is what happens to be
   * there and a `load` entry is something an operator wrote down. Which is also
   * why `allowOverride` does not appear here — it governs two *discovered*
   * extensions claiming one id, which the directory scan makes impossible (an
   * id is a directory name) and which only `load` can produce.
   */
  private discover(
    config: ExtensionsConfig,
  ): ReadonlyMap<string, ExtensionResolution> {
    const found = new Map<string, ExtensionResolution>();

    for (const id of this.options.store.installedIds()) {
      found.set(id, this.options.store.resolve(id));
    }

    for (const path of config.load) {
      const resolution = this.options.store.resolvePath(path);
      if (resolution === undefined) {
        this.options.logger.warn(
          { path },
          'extensions.load names a path that is not a directory',
        );
        continue;
      }
      const existing = found.get(resolution.id);
      if (existing !== undefined && !config.allowOverride) {
        this.options.logger.warn(
          { id: resolution.id, path, installed: existing.dir },
          'an explicitly loaded extension shadows an installed one of the same id',
        );
      }
      found.set(resolution.id, resolution);
    }

    return found;
  }

  /** Loads and activates one approved extension. Answers, never throws. */
  private async activate(
    resolution: ExtensionResolution,
    settings: Readonly<Record<string, unknown>>,
  ): Promise<Loaded> {
    const manifest = resolution.manifest;
    // `state: 'approved'` is only reachable with a parsed manifest, so this is
    // a type narrowing rather than a real branch — stated as one anyway,
    // because the alternative is a non-null assertion on the load path.
    if (manifest === undefined) return refusedEntry(resolution);

    const id = resolution.id;
    const bag = new RegistrationBag(manifest);
    const abort = new AbortController();
    const load = this.options.load ?? importExtension;

    let extension: Extension;
    try {
      const entryPath = joinEntry(resolution.dir, manifest.entry);
      extension = await load(entryPath);
      await extension.activate(
        this.contextFor(id, resolution, settings, bag, abort.signal),
      );
    } catch (error) {
      abort.abort();
      this.options.logger.warn(
        { extension: id, err: error },
        'extension failed',
      );
      return {
        resolution,
        digest: resolution.digest,
        registration: undefined,
        extension: undefined,
        abort: undefined,
        status: {
          ...baseStatus(resolution),
          state: 'failed',
          lastError: describe(error),
        },
      };
    }

    const registration = bag.result();
    return {
      resolution,
      digest: resolution.digest,
      registration,
      extension,
      abort,
      status: {
        ...baseStatus(resolution),
        state: 'ready',
        tools: registration.tools.map((tool) => tool.name).sort(),
        channels: registration.channels.map((factory) => factory.id).sort(),
        providers: registration.providers.map((one) => one.spec.id).sort(),
        commands: registration.commands.map((command) => command.id).sort(),
        warnings: [...registration.warnings],
      },
    };
  }

  private contextFor(
    id: string,
    resolution: ExtensionResolution,
    settings: Readonly<Record<string, unknown>>,
    bag: RegistrationBag,
    signal: AbortSignal,
  ): ExtensionContext {
    // `manifest` is present for the reason `activate` states.
    const manifest = resolution.manifest ?? undefined;
    if (manifest === undefined) {
      throw new GhostError('internal', `Extension "${id}" has no manifest`);
    }
    const secretFor = this.options.secretFor;
    return {
      id,
      manifest,
      settings,
      dataDir: this.options.dataDirFor(id),
      logger: this.options.logger.child({ extension: id }),
      clock: this.options.clock,
      signal,
      secret: () => secretFor?.(id),
      registerTool: (tool) => {
        bag.addTool(tool);
      },
      registerChannel: (factory) => {
        bag.addChannel(factory);
      },
      registerProvider: (spec, wire) => {
        bag.addProvider(spec, wire);
      },
      registerContributor: (contributor) => {
        bag.addContributor(contributor);
      },
      registerCommand: (command) => {
        bag.addCommand(command);
      },
    };
  }

  /**
   * Drops one extension's bag and lets it clean up.
   *
   * The abort fires *before* `deactivate`, so an extension that only listens to
   * the signal needs no `deactivate` at all. A throw out of `deactivate` is
   * logged and swallowed: the extension is going away either way, and letting
   * it take the reconcile down would mean a broken extension could not be
   * uninstalled.
   */
  private async unload(entry: Loaded): Promise<void> {
    entry.abort?.abort();
    try {
      await entry.extension?.deactivate?.();
    } catch (error) {
      this.options.logger.warn(
        { extension: entry.status.id, err: error },
        'extension deactivate failed',
      );
    }
  }

  private announce(): void {
    this.revisionCounter += 1;
    for (const listener of this.listeners) listener();
  }
}

function settingsFor(
  config: ExtensionsConfig,
  id: string,
): Readonly<Record<string, unknown>> {
  return config.settings[id] ?? {};
}

/**
 * Joined here rather than in `@ghostai/security`, which already proved it safe.
 *
 * `assertExtensionPolicy` resolved this exact pair through `realpath` and
 * refused anything landing outside the directory, so by the time an extension
 * is `approved` the join is arithmetic. Repeating the check would suggest this
 * layer is a second boundary, and a boundary nobody can point at is worse than
 * no boundary.
 */
function joinEntry(dir: string, entry: string): string {
  return `${dir}/${entry}`;
}

function baseStatus(resolution: ExtensionResolution): ExtensionStatus {
  const manifest = resolution.manifest;
  return {
    id: resolution.id,
    state: 'failed',
    version: manifest?.version ?? '',
    label: manifest?.label ?? '',
    description: manifest?.description ?? '',
    contributes: manifest?.contributes ?? [],
    tools: [],
    channels: [],
    providers: [],
    commands: [],
    digest: resolution.digest,
    ...(resolution.approvedAtMs === undefined
      ? {}
      : { approvedAtMs: resolution.approvedAtMs }),
    warnings: [],
  };
}

/** An extension the store would not authorise. Discovered, not loaded. */
function refusedEntry(resolution: ExtensionResolution): Loaded {
  const state = resolution.state === 'approved' ? 'failed' : resolution.state;
  return {
    resolution,
    digest: resolution.digest,
    registration: undefined,
    extension: undefined,
    abort: undefined,
    status: {
      ...baseStatus(resolution),
      state,
      ...(resolution.problem === undefined
        ? {}
        : { lastError: resolution.problem }),
    },
  };
}

/**
 * An extension the operator turned off.
 *
 * A row rather than an absence, because "installed and off" and "not installed"
 * are different things to see on a panel — and the first is the one with a
 * switch to flip.
 */
function disabledEntry(resolution: ExtensionResolution): Loaded {
  return {
    resolution,
    digest: resolution.digest,
    registration: undefined,
    extension: undefined,
    abort: undefined,
    status: { ...baseStatus(resolution), state: 'disabled' },
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
