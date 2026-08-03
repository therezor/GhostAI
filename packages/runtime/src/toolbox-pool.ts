/**
 * One warm container per session, and the `CommandRunner` that talks to it.
 *
 * The key is `(agentId, workspaceId, sessionKey)`, and each third of that is
 * load-bearing:
 *
 *  - **The agent** decides the *policy* — which profile, and how much of its
 *    network ceiling to use. Two agents on one conversation are two sandboxes.
 *  - **The workspace** decides what is *mounted*, so it cannot be shared across
 *    one; this is the same axis `JailCache` is keyed on.
 *  - **The session** decides the *instance*. Keying on the agent alone would put
 *    two conversations in one container, which for a security agent means one
 *    engagement's loot sitting in another's `/tmp`. Keying per *call* would be
 *    stricter still and pay a container start on every command.
 *
 * Starting is lazy, on the first `exec` that needs it, because an install with
 * six sandboxed agents should not run six containers to answer one question.
 * Reaping is on idle, on session end, and on `reconfigure` — the last of those
 * because a profile can change underneath a running pool, and a container
 * started under the old manifest must not outlive it.
 *
 * **Failure to start is a refusal, never a downgrade.** A sandbox that cannot be
 * created must not fall back to running the command on the host: that is the one
 * failure mode where the operator believes there is a boundary and there is not.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';

import { GhostError, type Clock, type Logger } from '@ghostai/core';
import type { Toolbox } from '@ghostai/protocol';
import {
  containerCreateArgv,
  containerIsGone,
  containerRunner,
  type CommandRunner,
  type RunOutcome,
  type RunRequest,
  type RunnerResolver,
  type ToolboxRequest,
} from '@ghostai/tools';
import {
  assertNetworkWithinCeiling,
  effectiveNetwork,
  type ApprovedToolbox,
  type ToolboxStore,
} from '@ghostai/security';

/** Beyond this many live containers the least-recently-used session is reaped. */
export const MAX_LIVE_TOOLBOXES: number = 4;

/** How long a container may sit unused before it is stopped. */
export const TOOLBOX_IDLE_MS: number = 10 * 60_000;

/**
 * Label naming the process that created a sandbox.
 *
 * Without it, `reapOrphans` cannot tell an orphan from a *peer's live container*
 * — `ghostai.session` is on every sandbox this install ever starts, so a second
 * GhostAI process, a `ghost chat` beside a running `ghost serve`, or a restart
 * that overlaps the old process by a second, would `rm --force` containers a
 * turn was executing in. The symptom is the daemon's "No such container" landing
 * in the model's tool result, which is the one this label exists to prevent.
 */
export const OWNER_LABEL = 'ghostai.owner';

/**
 * This process, as a label value.
 *
 * Host *and* pid, because a pid alone is only unique within one kernel: a remote
 * or shared daemon serves several hosts, and pid 42 on two of them is two
 * different processes. Both halves are needed for the liveness check below to be
 * asking about the right process.
 */
export function ownerTag(): string {
  return `${hostname()}:${String(process.pid)}`;
}

/**
 * Whether the process named by an owner tag is still running.
 *
 * **Conservative by design: it answers `true` whenever it cannot tell.** The two
 * outcomes are not symmetric — sparing a container that is genuinely orphaned
 * leaks a workspace mount until the next sweep that *can* tell, while reaping one
 * that is live kills a command mid-flight and reports the daemon's words to the
 * model as its own failure. So an owner from another host, or one that does not
 * parse, is left alone.
 *
 * `signal 0` is the standard existence probe: it delivers nothing and only
 * reports whether the pid could be signalled. `EPERM` means it exists and
 * belongs to someone else, which is still "alive".
 */
export function ownerProcessLooksAlive(owner: string): boolean {
  const separator = owner.lastIndexOf(':');
  if (separator === -1) return true;
  if (owner.slice(0, separator) !== hostname()) return true;

  const pid = Number(owner.slice(separator + 1));
  if (!Number.isInteger(pid) || pid <= 0) return true;

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Spawns and stops containers. Injected so the pool is testable with no daemon. */
export interface ContainerEngine {
  start(argv: readonly string[]): void;
  stop(name: string): void;
  /** Throws when the daemon is unreachable. Called once per pool build. */
  probe(): void;
  /**
   * Removes sandbox containers left behind by a previous process.
   *
   * `close()` reaps what this process started, and reaps nothing at all when the
   * process did not get to run it — a `SIGKILL`, an OOM, a crashed host. Without
   * a sweep those containers accumulate silently, each holding a workspace mount
   * and its share of memory, and the only sign is a machine that is slowly more
   * loaded than it should be. Every sandbox carries a `ghostai.session` label so
   * this can find them without guessing at names.
   */
  reapOrphans(): void;
}

export interface ToolboxPoolOptions {
  readonly toolboxes: ToolboxStore;
  readonly engine: ContainerEngine;
  /**
   * `GhostPaths.runsDir` — where command transcripts are written.
   *
   * Outside the workspace, because the host writes them while the container holds
   * the workspace writable; see `GhostPaths.runsDir` for the escape that made this
   * necessary.
   */
  readonly runsDir: string;
  /**
   * How the *daemon* sees a path, given GhostAI's view of it.
   *
   * Identity for a host install. A containerised GhostAI has to translate,
   * because a bind path is resolved by the daemon and not by this process — the
   * failure otherwise is a silently empty mount rather than an error. Applied to
   * every path that reaches a `--volume`, which is the workspace *and* the
   * profile manifest.
   */
  readonly hostPath?: (path: string) => string;
  readonly clock?: Clock;
  readonly logger?: Logger;
  readonly idleMs?: number;
  readonly maxLive?: number;
  /** Injected for deterministic container and run names in tests. */
  readonly newId?: () => string;
  /**
   * Builds the runner for a container the pool has just started.
   *
   * A seam for the pool's *own* behaviour — marking a container busy, rebuilding
   * one that disappeared — none of which is about `docker exec` and all of which
   * otherwise needs a daemon to observe. The default is the real container
   * runner; `container-runner.test.ts` covers that half.
   */
  readonly newRunner?: (containerName: string, toolbox: Toolbox) => CommandRunner;
  /**
   * What to label containers with, so a sweep can tell this process's from a
   * peer's. Defaults to `ownerTag()`, which is also what `dockerEngine` defaults
   * to — the two agree without being wired together because both derive it from
   * the same process.
   */
  readonly owner?: string;
}

interface Entry {
  readonly name: string;
  readonly runner: CommandRunner;
  /**
   * Kept beside the composite key rather than parsed back out of it.
   *
   * `releaseSession` used to match with `key.endsWith(' ' + sessionKey)`, which
   * is wrong twice: a session key containing a space could match another
   * session's key, and a key that happens to end with another's text would be
   * reaped with it. Storing the value removes the parsing entirely.
   */
  readonly sessionKey: string;
  /** What the manifest hashed to when this container was started. */
  readonly manifestSha256: string;
  /**
   * The turn that asked for this container, kept so it can be rebuilt.
   *
   * A container can go away underneath a warm session — Docker Desktop
   * restarting, `docker system prune`, an operator tidying up — and rebuilding it
   * needs the mount, the network and the toolbox name that created it. Without
   * them the only recovery is to fail the command.
   */
  readonly request: ToolboxRequest;
  lastUsedMs: number;
  /**
   * How many commands are running in this container right now.
   *
   * `lastUsedMs` is stamped once per *turn*, so a scan that runs for twenty
   * minutes looks idle for nineteen of them — and a turn in another session that
   * triggers a sweep would stop the container that scan is running in, which
   * surfaces as the command failing for no stated reason. A container with work
   * in it is never reaped, whatever its timestamp says.
   */
  busy: number;
}

/**
 * A turn's runner, and the request it should start a container from.
 *
 * The request is held here rather than read from the live `Entry`, because with
 * a lazily-started container there is no entry to read it from the first time —
 * and after a container is dropped there is none to read it from again. It is
 * mutable so a later turn on the same session updates it in place, which keeps
 * the runner a turn is holding pointed at current policy.
 */
interface Facade {
  readonly runner: CommandRunner;
  spec: ToolboxRequest;
}

export class ToolboxPool implements RunnerResolver {
  readonly #options: ToolboxPoolOptions;
  readonly #live = new Map<string, Entry>();
  /**
   * The runner handed to a turn, per key.
   *
   * A level of indirection over `Entry.runner`, and it earns it: a runner bound
   * to a container name cannot survive that container being replaced, but a turn
   * holds whatever `forTurn` gave it for the whole turn. The facade resolves the
   * *current* entry on every command instead, so a container rebuilt mid-turn is
   * invisible to the caller. Cached so `forTurn` twice in a session is the same
   * object, which is what tells a reader nothing restarted.
   */
  readonly #facades = new Map<string, Facade>();
  readonly #owner: string;
  #counter = 0;
  #swept = false;

  constructor(options: ToolboxPoolOptions) {
    this.#options = options;
    this.#owner = options.owner ?? ownerTag();
  }

  /**
   * Sweeps orphans once, on the first turn that actually needs a container.
   *
   * **Not in the constructor**, and that is a fix rather than a preference. The
   * pool is built whenever any agent names a profile, which happens at boot — and
   * `docker ps` against a socket whose daemon has gone away does not fail fast,
   * it blocks. Measured at 62 seconds. Sweeping at construction therefore hung
   * `ghost serve` for a minute before it bound its port, on an install whose only
   * sin was having a research agent configured while Docker was closed.
   *
   * Failure is logged rather than thrown: an orphan nobody could remove is
   * untidy, and refusing the turn over it would turn untidy into unusable.
   */
  #sweepOnce(): void {
    if (this.#swept) return;
    this.#swept = true;
    try {
      this.#options.engine.reapOrphans();
    } catch (error) {
      this.#options.logger?.warn({ error }, 'could not sweep orphaned sandboxes');
    }
  }

  #now(): number {
    return this.#options.clock?.now() ?? Date.now();
  }

  #nextId(): string {
    this.#counter += 1;
    return this.#options.newId?.() ?? `${String(this.#now())}-${String(this.#counter)}`;
  }

  static keyOf(request: ToolboxRequest): string {
    return `${request.agentId} ${request.workspaceId} ${request.sessionKey}`;
  }

  /**
   * The runner for a turn — policy only, and deliberately no container.
   *
   * Resolving a sandbox is on the turn-open path, and starting one there meant
   * probing the daemon there too. `probe()` is a `spawnSync`, so a daemon that
   * has gone away did not fail this turn, it blocked the event loop for five
   * seconds and *then* failed it — every session and every HTTP route with it.
   * Worse, it threw before the turn had opened, so the failure had no turn to
   * belong to and the operator was offered no way to re-run it.
   *
   * So this decides *whether* a sandbox is allowed and the first command starts
   * it. A turn that calls no tool now touches the daemon not at all, and a
   * daemon that is down surfaces as a failed tool card inside a live turn —
   * which is a thing the model can read and the operator can act on.
   *
   * What stays here is what must: `require` re-reads the manifest and re-checks
   * the approval, and the ceiling check bounds the network. Both still throw
   * synchronously, because a revoked or over-privileged toolbox is a refusal to
   * run rather than a command that fails.
   *
   * **It returns a runner even when the daemon is unreachable, and that is load
   * bearing.** `sandboxed` is derived from this being defined, and it is what
   * tells the exec guard the host's rules do not apply. Returning `undefined`
   * here would not degrade to "no sandbox available" — it would run the command
   * on the host. Refusal, never a downgrade; see the module header.
   */
  forTurn(request: ToolboxRequest): CommandRunner | undefined {
    if (request.toolbox === '') return undefined;

    const key = ToolboxPool.keyOf(request);
    this.#reapIdle();

    // **Before the cache, not after.** `require` is the only thing that re-reads
    // the manifest and re-checks its hash against the approvals table, and a warm
    // entry that skipped it kept serving a profile the operator had revoked — or
    // edited into something they considered unsafe — for as long as the session
    // stayed active. `ghost profiles revoke` is a different process writing the
    // shared database, so nothing notifies this pool; asking every turn is what
    // makes revocation mean something. It costs one read, one hash and one row.
    const approved = this.#options.toolboxes.require(request.toolbox);
    assertNetworkWithinCeiling(approved.toolbox, request.network, request.agentId);

    const existing = this.#live.get(key);
    if (existing !== undefined) {
      if (existing.manifestSha256 === approved.manifestSha256) {
        existing.lastUsedMs = this.#now();
        // Re-inserted so Map iteration order stays least-recently-used first.
        this.#live.delete(key);
        this.#live.set(key, existing);
      } else {
        // A live container started from a manifest that has since changed is
        // stopped rather than reused: it was built with the old policy's flags.
        // The next command starts a replacement from the manifest as it is now.
        this.#drop(key, existing);
      }
    }
    return this.#facadeFor(key, request);
  }

  /**
   * Starts this key's container if it has none.
   *
   * The other half of a policy-only `forTurn`: every path that runs a command
   * goes through here first, so "there is an entry" is still true by the time
   * anything needs one — established at first use rather than at turn open.
   *
   * `require` runs again rather than reusing what `forTurn` resolved, and the
   * rebuild path has always done the same. A turn can sit between its opening
   * and its first tool call for a long time, and a toolbox revoked in that
   * window must not get a container.
   */
  #ensure(key: string, spec: ToolboxRequest): void {
    if (this.#live.has(key)) return;
    const approved = this.#options.toolboxes.require(spec.toolbox);
    assertNetworkWithinCeiling(approved.toolbox, spec.network, spec.agentId);
    this.#live.set(key, this.#start(spec, approved));
    this.#evictBeyondCap(key);
  }

  /**
   * The runner a turn holds, which outlives any one container.
   *
   * Two jobs beyond delegating. It marks the container busy for the duration of
   * each command, so an idle sweep cannot stop something mid-scan. And it
   * recognises the daemon reporting that the container is gone — which arrives as
   * an ordinary non-zero exit with the daemon's words on stderr — and rebuilds it
   * rather than passing that off as the command's own failure. The retry is safe
   * for the one reason that matters: a `docker exec` that could not find its
   * container never started the command, so nothing has run twice.
   */
  #facadeFor(key: string, spec: ToolboxRequest): CommandRunner {
    const cached = this.#facades.get(key);
    if (cached !== undefined) {
      // A second turn on the same session may carry a different workspace root
      // or network, and it is the newest one that any command should start from.
      cached.spec = spec;
      return cached.runner;
    }

    const facade: Facade = {
      spec,
      runner: {
        run: async (request: RunRequest): Promise<RunOutcome> => {
          // Where the container actually comes from now. Anything this throws —
          // a dead daemon, a revoked toolbox — rejects the command, which the
          // tool registry renders as a failed tool card rather than letting it
          // unwind the turn.
          this.#ensure(key, facade.spec);

          const outcome = await this.#runOn(key, request);
          if (!containerIsGone(outcome)) return outcome;

          const stale = this.#live.get(key);
          if (stale === undefined) return outcome;
          this.#options.logger?.warn(
            { container: stale.name, toolbox: stale.request.toolbox },
            'sandbox disappeared; rebuilding it and retrying the command',
          );

          this.#drop(key, stale);
          this.#ensure(key, facade.spec);
          // Once. A second disappearance is something other than a stale handle,
          // and a loop that keeps rebuilding would hide it.
          return await this.#runOn(key, request);
        },
      },
    };

    this.#facades.set(key, facade);
    return facade.runner;
  }

  async #runOn(key: string, request: RunRequest): Promise<RunOutcome> {
    const entry = this.#live.get(key);
    if (entry === undefined) {
      // Every caller runs `#ensure` immediately before this, and `#ensure`
      // either puts an entry in place or throws — so this is a bug rather than
      // a state to recover from, and it says which one.
      throw new GhostError('internal', 'The sandbox for this turn is no longer in the pool.', {
        details: { key },
      });
    }

    entry.busy += 1;
    try {
      return await entry.runner.run(request);
    } finally {
      entry.busy -= 1;
      // Stamped on the way out as well as per turn: a command that ran for
      // twenty minutes leaves a container that was used twenty minutes ago, not
      // one that has been idle since the turn began.
      entry.lastUsedMs = this.#now();
    }
  }

  #start(request: ToolboxRequest, approved: ApprovedToolbox): Entry {
    const { toolbox } = approved;
    const name = `ghost-sbx-${this.#nextId()}`;
    // **Every** path handed to the daemon goes through the translation, not just
    // the workspace. The manifest lives under `GHOSTAI_HOME`, so a containerised
    // GhostAI that translated only the workspace would ask the daemon to mount
    // its own `/data/profiles/...` — a path that means something else on the
    // host, and usually nothing. The failure is a container that starts and
    // carries the wrong policy file, which is worse than one that refuses.
    const daemonPath = (path: string): string =>
      this.#options.hostPath === undefined ? path : this.#options.hostPath(path);

    const argv = containerCreateArgv({
      toolbox,
      network: effectiveNetwork(toolbox, request.network),
      mount: { hostPath: daemonPath(request.workspaceRoot), containerPath: toolbox.workdir },
      containerName: name,
      manifestPath: daemonPath(approved.manifestPath),
      runsPath: daemonPath(this.#options.runsDir),
      labels: {
        'ghostai.session': request.sessionKey,
        'ghostai.toolbox': toolbox.name,
        [OWNER_LABEL]: this.#owner,
      },
    });

    // Probed here rather than at build: a container runtime that is not running
    // is a condition that changes while the server is up, and distinguishing it
    // from "the container failed to start" is the difference between an operator
    // starting Docker and an operator debugging a manifest.
    // The *root*, not this container's subdirectory. `--mount type=bind` refuses a
    // source the daemon cannot see, and Docker Desktop's file sharing does not see
    // a directory created microseconds earlier — so the mounted path has to be one
    // that already existed. The per-container subdirectory is created by
    // `openTranscript` on the host side, inside a mount the container already has.
    mkdirSync(this.#options.runsDir, { recursive: true });

    try {
      this.#options.engine.probe();
      this.#sweepOnce();
    } catch (error) {
      throw new GhostError(
        'tool',
        `No container runtime is reachable, so agent "${request.agentId}" could not run its command.\n` +
          '  Start Docker (or Podman) and try again. Everything that does not need a\n' +
          '  sandbox keeps working meanwhile.',
        { cause: error, details: { agentId: request.agentId, toolbox: toolbox.name } },
      );
    }

    try {
      this.#options.engine.start(argv);
    } catch (error) {
      // Refused, never downgraded to the host. See the module header.
      //
      // The daemon's own words are included rather than logged and swallowed: a
      // bare "could not be started" sends the reader to the logs for the one fact
      // that would have told them what to do — a missing image, a bad flag, a
      // mount source the daemon cannot see.
      const reason = error instanceof Error ? error.message : String(error);
      throw new GhostError(
        'tool',
        `The sandbox for agent "${request.agentId}" could not be started, so the command was not run.\n  ${reason}`,
        { cause: error, details: { agentId: request.agentId, toolbox: toolbox.name } },
      );
    }

    this.#options.logger?.info({ container: name, toolbox: toolbox.name }, 'sandbox started');

    return {
      name,
      sessionKey: request.sessionKey,
      manifestSha256: approved.manifestSha256,
      request,
      lastUsedMs: this.#now(),
      busy: 0,
      runner:
        this.#options.newRunner?.(name, toolbox) ??
        containerRunner({
          toolbox,
          containerName: name,
          // Keyed on the container name this pool generated, never on the
          // client-chosen session key — that string is only `min(1)` and has no
          // business becoming a path component.
          runsRoot: this.#options.runsDir,
          nextRunId: () => this.#nextId(),
        }),
    };
  }

  #reapIdle(): void {
    const idleMs = this.#options.idleMs ?? TOOLBOX_IDLE_MS;
    if (idleMs <= 0) return;
    const cutoff = this.#now() - idleMs;
    for (const [key, entry] of this.#live) {
      if (entry.busy === 0 && entry.lastUsedMs < cutoff) this.#drop(key, entry);
    }
  }

  /**
   * Drops least-recently-used entries until the cap is met.
   *
   * `keep` is the entry the caller is about to hand back, and excluding it is not
   * a nicety: with a cap of zero — or one, on a pool that just evicted down to
   * it — the newest entry is also the only entry, so an unguarded loop would stop
   * the container it is in the middle of returning a runner for. Every `exec`
   * would then fail against a container that no longer exists, and the pool would
   * report having started one.
   *
   * A busy container is skipped for the same reason the idle sweep skips it, with
   * one consequence worth naming: enough concurrent long commands leave the pool
   * *over* its cap rather than killing work to get under it. The cap is there to
   * stop containers accumulating unused, and a container with a command in it is
   * not that.
   */
  #evictBeyondCap(keep: string): void {
    const cap = this.#options.maxLive ?? MAX_LIVE_TOOLBOXES;
    for (const [key, entry] of this.#live) {
      if (this.#live.size <= cap) return;
      if (key !== keep && entry.busy === 0) this.#drop(key, entry);
    }
  }

  #drop(key: string, entry: Entry): void {
    this.#live.delete(key);
    // The facade outlives one container but not the entry: a turn still holding
    // it rebuilds through it, while a later `forTurn` builds a fresh one rather
    // than this map growing by one closure per session forever.
    this.#facades.delete(key);
    // The transcripts go with the container. Nothing prunes them otherwise, and a
    // scanning agent writes a lot of them.
    try {
      rmSync(join(this.#options.runsDir, entry.name), { recursive: true, force: true });
    } catch {
      // A transcript directory that will not delete is untidy, never fatal.
    }
    try {
      this.#options.engine.stop(entry.name);
    } catch (error) {
      // A container that is already gone is the common case, and a failure to
      // stop one must not take down the turn that triggered the sweep.
      this.#options.logger?.warn({ container: entry.name, error }, 'sandbox stop failed');
    }
  }

  /** Stops every container this session owns. Called when a session ends. */
  releaseSession(sessionKey: string): void {
    for (const [key, entry] of this.#live) {
      if (key.endsWith(` ${sessionKey}`)) this.#drop(key, entry);
    }
  }

  /** Stops everything. Called on `reconfigure` and on shutdown. */
  close(): void {
    for (const [key, entry] of this.#live) this.#drop(key, entry);
  }

  /** Live container names, for tests and diagnostics. */
  get live(): readonly string[] {
    return [...this.#live.values()].map((entry) => entry.name);
  }
}

/**
 * The real engine: the `docker` (or `podman`) CLI, synchronously.
 *
 * Synchronous because every call here is a control-plane operation on the order
 * of tens of milliseconds, and the alternative is an async `forTurn` that every
 * caller above would have to await for the sake of a `docker run -d`.
 *
 * `probe` exists so an unreachable daemon is a refusal at `reconfigure` — where
 * it is a 400 on a settings save naming a message an operator can act on —
 * rather than a turn that dies minutes later with a spawn error.
 */
/**
 * How long a control-plane call may take before it is treated as unreachable.
 *
 * Not decoration. A `docker` CLI talking to a socket whose daemon has gone away
 * — Docker Desktop quit, the socket file left behind — does not fail fast: it
 * blocks. Measured at 62 seconds for a `docker ps`. Without a bound, one closed
 * Docker turns every sandboxed turn into a minute of nothing, and anything that
 * called this at boot into a server that never binds its port.
 */
const CONTROL_TIMEOUT_MS = 5_000;

/** A container start may have to load a large image, so it gets longer. */
const START_TIMEOUT_MS = 60_000;

/**
 * Blocks for a beat, synchronously.
 *
 * `Atomics.wait` on a throwaway buffer rather than a busy loop: the engine is
 * synchronous by design (see `dockerEngine`), so there is no promise to await,
 * and spinning would burn a core for the duration.
 */
function sleepBriefly(): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
}

export interface DockerEngineOptions {
  /** `podman` is wire-compatible for everything used here. */
  readonly bin?: string;
  /** Defaults to `ownerTag()`, matching `ToolboxPool`'s default. */
  readonly owner?: string;
  /** Injected so the sweep's ownership rules are testable without a daemon. */
  readonly isOwnerAlive?: (owner: string) => boolean;
}

export function dockerEngine(options: DockerEngineOptions = {}): ContainerEngine {
  const bin = options.bin ?? 'docker';
  const owner = options.owner ?? ownerTag();
  const isOwnerAlive = options.isOwnerAlive ?? ownerProcessLooksAlive;

  const run = (argv: readonly string[], what: string, timeout = CONTROL_TIMEOUT_MS): void => {
    const result = spawnSync(bin, [...argv], {
      encoding: 'utf8',
      windowsHide: true,
      timeout,
    });
    // A timeout arrives as a killing signal rather than as an error, so checking
    // `error` alone would read "killed after 5s" as a clean non-zero exit.
    if (result.signal !== null) {
      throw new GhostError(
        'tool',
        `${bin} ${what} did not respond within ${String(timeout)}ms — is the daemon running?`,
        { details: { bin, what, timeout } },
      );
    }
    if (result.error !== undefined) {
      throw new GhostError('tool', `Could not run ${bin}: ${result.error.message}`, {
        cause: result.error,
        details: { bin, what },
      });
    }
    if (result.status !== 0) {
      throw new GhostError('tool', `${bin} ${what} failed: ${(result.stderr || '').trim()}`, {
        details: { bin, what, status: result.status },
      });
    }
  };

  const capture = (argv: readonly string[]): string => {
    const result = spawnSync(bin, [...argv], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: CONTROL_TIMEOUT_MS,
    });
    return result.status === 0 ? result.stdout : '';
  };

  return {
    probe() {
      run(['version', '--format', '{{.Server.Version}}'], 'version');
    },
    reapOrphans() {
      // `--filter label=` rather than a name prefix: a label is what the
      // container was *created* with, so it cannot drift from whatever this
      // version happens to name things. The owner comes back in the same call
      // because `docker ps` cannot filter on *not* matching a label, so the
      // decision has to be made here.
      const rows = capture([
        'ps',
        '--all',
        '--filter',
        'label=ghostai.session',
        '--format',
        `{{.ID}} {{.Label "${OWNER_LABEL}"}}`,
      ])
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '');

      for (const row of rows) {
        const space = row.indexOf(' ');
        const id = space === -1 ? row : row.slice(0, space);
        const containerOwner = space === -1 ? '' : row.slice(space + 1).trim();

        // This process's own. `close()` reaps them, and doing it here would kill
        // the container the turn that triggered this sweep is about to use.
        if (containerOwner === owner) continue;
        // A peer's, and it is still running. An unlabelled container — from a
        // version before this label existed — is reaped, which is the behaviour
        // it was created under.
        if (containerOwner !== '' && isOwnerAlive(containerOwner)) continue;

        // `rm --force`, not `stop`: these are already unowned, and a stop on a
        // container whose process is gone waits out the timeout for nothing.
        capture(['rm', '--force', id]);
      }
    },
    start(argv) {
      try {
        run(argv, 'run', START_TIMEOUT_MS);
      } catch (error) {
        // Docker Desktop's file sharing does not see a directory the instant it
        // is created: the transcript directory is made microseconds before this
        // call, and the daemon can answer "bind source path does not exist" for a
        // path that demonstrably does. `--volume` used to hide this by *creating*
        // a missing source — inside the VM, silently detached from the host —
        // which is worse than the error. One retry after a beat is the whole fix,
        // and it is scoped to that exact message so a genuinely absent path still
        // fails fast.
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes('bind source path does not exist')) throw error;
        sleepBriefly();
        run(argv, 'run', START_TIMEOUT_MS);
      }
    },
    stop(name) {
      // `--time 2`: a sandbox holds no state worth a graceful shutdown, and a
      // reap that blocks ten seconds per container is a reap nobody runs.
      run(['stop', '--time', '2', name], 'stop');
    },
  };
}
