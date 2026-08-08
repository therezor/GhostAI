/**
 * A `CommandRunner` that runs the guarded command inside a container.
 *
 * `guardExec` has already decided **whether** the command may run; this decides
 * **where**, which is the split `runner.ts` describes. What it owns is the
 * translation `runner.ts:20` warns about — `ExecPlan` is host-shaped, and a
 * container sees the workspace somewhere else — plus three things that are not
 * obvious until they break:
 *
 *  - **No shell string is ever built.** Tee-ing output and recording a pid want a
 *    shell, and interpolating a command into one would re-create exactly the
 *    injection surface the `argv: string[]` contract exists to remove. Instead the
 *    script is a **fixed literal** and the command arrives as positional
 *    parameters: `sh -c '<constant>' ghost-exec <dir> <file> <args…>` leaves
 *    `"$@"` holding the argv, unquoted and uninterpreted. Nothing the model wrote
 *    is ever parsed by a shell.
 *
 *  - **The host writes the transcript, the container only reads it.** The full
 *    stream is already arriving on this side, so `tee` inside the container would
 *    be a second copy and a race against the mount. The files land *outside* the
 *    workspace and are mounted back read-only — see `RUNS_MOUNT_DIR` for the
 *    escape that made that necessary. This is what lets the model be handed ~80
 *    tokens and a path instead of a 12,000-token scan.
 *
 *  - **`PATH` does not cross the boundary.** `plan.env` is built from a *host*
 *    allow-list, and a host `PATH` inside a Kali container points at binaries
 *    that are not there. Only names the profile names are passed through, and
 *    their values come from the plan.
 *
 * Killing `docker exec` on this side leaves the process running on the other,
 * which would quietly break the "one `AbortSignal` reaches the child" invariant
 * `loop.ts` claims. So the script records its own pid — `exec` replaces the shell
 * and keeps it — and cancellation sends a signal *inside* the container. The
 * known limit: a process that forks children of its own leaves them behind, which
 * `--init` reaps rather than orphans.
 */

import { mkdirSync, createWriteStream, type WriteStream } from 'node:fs';
import { dirname, join } from 'node:path';

import { GhostError } from '@ghostbot/core';
import type { Toolbox } from '@ghostbot/protocol';
import type { EffectiveNetwork, ExecPlan } from '@ghostbot/security';

import {
  localRunner,
  type CommandRunner,
  type RunOutcome,
  type RunRequest,
} from './runner.js';

/**
 * Where a container sees its own transcripts, read-only.
 *
 * The files are written by the host, from a directory *outside* the workspace —
 * see `GhostPaths.runsDir`. They used to live under `<workspace>/.ghost/runs`,
 * which was a host process writing into a directory the agent could write too:
 * planting `ln -s ~/.ssh/authorized_keys …/stdout.log` made the host overwrite an
 * arbitrary host file as the GhostAI user. Mounting them back read-only keeps the
 * recovery path — `grep` your own truncated output — with no way to plant
 * anything.
 *
 * A *sibling* of `TOOLBOX_MOUNT_DIR`, never nested inside it. `/run/ghost/runs`
 * would ask runc to create a mountpoint inside a mount that is itself read-only,
 * which fails outright: "make mountpoint … read-only file system". The same trap
 * `TOOLBOX_MOUNT_DIR` documents, one level along.
 */
export const RUNS_MOUNT_DIR = '/run/ghost-runs';

/**
 * Where the approved manifest is mounted, read-only.
 *
 * Outside the workspace, and that is not cosmetic. Nesting it under the workdir
 * — `/workspace/.ghost/profile.json` — asks the runtime to create a mountpoint
 * *inside* a bind mount it is in the middle of establishing, which `runc`
 * refuses outright: "mountpoint is outside of rootfs". Mounting the profile's
 * own directory somewhere of its own has no such problem, and immutability from
 * the mount table is satisfied wherever the mount lands.
 */
export const TOOLBOX_MOUNT_DIR = '/run/ghost';

/**
 * Records the pid, then becomes the command.
 *
 * A constant. `$1` is the run directory and `"$@"` is the argv after the shift,
 * so no part of it is ever built from a string the model produced. `exec` means
 * the pid written is the command's own, not a shell that would exit first.
 */
const EXEC_SCRIPT = 'echo $$ > "$1"; shift; exec "$@"';

/**
 * Signals the recorded pid.
 *
 * The digit check is not defensive padding. The pid file lives on a tmpfs the
 * agent can write, so `-1` in it would turn a timeout into `kill -TERM -1` —
 * every process in the namespace, including PID 1, which kills the container and
 * leaves the pool serving an entry for something that no longer exists. Only a
 * bare positive integer is ever signalled.
 */
const KILL_SCRIPT =
  'p=$(cat "$1" 2>/dev/null); case "$p" in "" | *[!0-9]* ) exit 0 ;; esac; kill -"$2" "$p" 2>/dev/null || true';

/** How a container sees the workspace, and where the daemon finds it. */
interface ToolboxMount {
  /**
   * The workspace as **the daemon** resolves it, which is not always as GhostAI
   * sees it: a containerised GhostAI asking for its own `/data/workspace` gets
   * the host's. See `hostWorkspaceRoot`.
   */
  readonly hostPath: string;
  /** `toolbox.workdir`. */
  readonly containerPath: string;
}

interface ContainerCreateOptions {
  readonly toolbox: Toolbox;
  readonly network: EffectiveNetwork;
  readonly mount: ToolboxMount;
  readonly containerName: string;
  /** Set when an egress gateway owns the network namespace. */
  readonly gatewayContainer?: string;
  /**
   * Absolute host path of the approved manifest.
   *
   * Its *directory* is what gets mounted: binding a single file needs the
   * mountpoint to exist in the image, and a directory mount does not.
   */
  readonly manifestPath?: string;
  /** Host transcript *root*, long-lived. Mounted read-only. See `containerRunDir`. */
  readonly runsPath?: string;
  readonly labels?: Readonly<Record<string, string>>;
}

/**
 * `ALL` is dropped whatever the profile says, then named capabilities are added
 * back.
 *
 * Not `toolbox.caps.drop` alone: a manifest that left it empty — through an
 * edit, a template someone trimmed, or a future schema default nobody thought
 * about — would inherit Docker's default capability set rather than none, and
 * the resulting container would look correctly configured in every other
 * respect. The floor belongs in code, where no data can lower it. The profile's
 * own `drop` list is still emitted, so an operator can be explicit without that
 * meaning anything different.
 */
function capabilityFlags(toolbox: Toolbox): string[] {
  const flags = ['--cap-drop=ALL'];
  for (const capability of toolbox.caps.drop) {
    if (capability.toUpperCase() !== 'ALL') {
      flags.push(`--cap-drop=${capability}`);
    }
  }
  for (const capability of toolbox.caps.add) {
    flags.push(`--cap-add=${capability}`);
  }
  return flags;
}

/**
 * How the container reaches the network.
 *
 * `container:<gw>` makes it join the gateway's namespace, where the gateway's
 * nftables rules already apply and the sandbox — holding no `NET_ADMIN`, which
 * `assertProfilePolicy` refuses — cannot flush them.
 */
function networkFlags(options: ContainerCreateOptions): string[] {
  if (options.network.mode === 'none') return ['--network=none'];
  if (options.gatewayContainer !== undefined) {
    return [`--network=container:${options.gatewayContainer}`];
  }
  if (options.network.mode === 'allowlist') {
    // Refused rather than silently run wide open. An allow-list with no gateway
    // to enforce it is indistinguishable from no allow-list at all, and this is
    // the failure that would look like it worked.
    throw new GhostError(
      'internal',
      'A scoped-egress sandbox needs a gateway container; refusing to start it with open egress.',
      { details: { container: options.containerName } },
    );
  }
  return ['--network=bridge'];
}

/**
 * A bind mount as `--mount`, not `--volume`.
 *
 * `--volume src:dst[:opts]` is colon-delimited and `:` is a legal character in a
 * path: a workspace at `/Users/me/Notes:2024/ws` parses as source
 * `/Users/me/Notes`, target `2024/ws`, options `/workspace`, and every sandboxed
 * turn fails with an opaque "invalid mode" naming nothing. `--mount` takes
 * `key=value` pairs and has no such ambiguity.
 */
function bindMount(source: string, target: string, readOnly: boolean): string {
  const parts = ['type=bind', `src=${source}`, `dst=${target}`];
  if (readOnly) parts.push('ro');
  return parts.join(',');
}

/**
 * The `docker run` argv for a session's sandbox.
 *
 * Pure, so the whole flag set is testable without a daemon — including the
 * assertions that matter most, which are about what can *never* appear.
 */
export function containerCreateArgv(options: ContainerCreateOptions): string[] {
  const { toolbox, mount, containerName } = options;
  const argv: string[] = ['run', '--detach', '--rm', '--name', containerName];

  for (const [key, value] of Object.entries(options.labels ?? {})) {
    argv.push('--label', `${key}=${value}`);
  }

  // Without it the entrypoint override below leaves the shell as PID 1 with no
  // signal handler, so signals never reach children and exited processes are
  // never reaped.
  argv.push('--init');

  if (toolbox.runtime !== 'runc') argv.push(`--runtime=${toolbox.runtime}`);

  if (toolbox.limits.memoryMb > 0) {
    argv.push(`--memory=${String(toolbox.limits.memoryMb)}m`);
  }
  if (toolbox.limits.cpus > 0) {
    argv.push(`--cpus=${String(toolbox.limits.cpus)}`);
  }
  if (toolbox.limits.pidsMax > 0) {
    argv.push(`--pids-limit=${String(toolbox.limits.pidsMax)}`);
  }
  if (toolbox.limits.shmSizeMb > 0) {
    argv.push(`--shm-size=${String(toolbox.limits.shmSizeMb)}m`);
  }

  argv.push(...capabilityFlags(toolbox));
  if (toolbox.security.noNewPrivileges) {
    argv.push('--security-opt=no-new-privileges');
  }
  if (toolbox.security.seccomp === 'unconfined') {
    argv.push('--security-opt=seccomp=unconfined');
  }
  if (toolbox.security.readOnlyRoot) argv.push('--read-only');
  for (const spec of toolbox.security.tmpfs) argv.push(`--tmpfs=${spec}`);
  for (const spec of toolbox.security.devices) argv.push(`--device=${spec}`);
  if (toolbox.user !== '') argv.push(`--user=${toolbox.user}`);

  argv.push(...networkFlags(options));

  argv.push('--mount', bindMount(mount.hostPath, mount.containerPath, false));
  // Read-only, so the policy the container runs under is immutable from the
  // mount table rather than by anyone remembering to check it. The profile's
  // *directory*, and outside the workdir — see `TOOLBOX_MOUNT_DIR`.
  if (options.manifestPath !== undefined) {
    argv.push(
      '--mount',
      bindMount(dirname(options.manifestPath), TOOLBOX_MOUNT_DIR, true),
    );
  }
  // Read-only, so the agent can read its own truncated output and cannot plant a
  // symlink where the host is about to write the next one.
  if (options.runsPath !== undefined) {
    argv.push('--mount', bindMount(options.runsPath, RUNS_MOUNT_DIR, true));
  }
  argv.push('--workdir', mount.containerPath);

  // Idle forever as PID 1's child. `tail -f /dev/null` rather than `sleep
  // infinity`, which busybox does not always accept.
  argv.push(
    '--entrypoint',
    '/bin/sh',
    toolbox.image,
    '-c',
    'exec tail -f /dev/null',
  );
  return argv;
}

interface ContainerExecOptions {
  readonly plan: ExecPlan;
  readonly toolbox: Toolbox;
  readonly containerName: string;
  /** Identifies this run's transcript directory. */
  readonly runId: string;
}

/**
 * The container-side path of a run's transcript directory, read-only.
 *
 * Namespaced by container name because the mount is the *long-lived* transcript
 * root rather than a per-container directory. Mounting a directory created
 * microseconds earlier is unreliable on Docker Desktop, whose file sharing does
 * not see it yet and answers "bind source path does not exist" for a path that
 * demonstrably does — measured, and not fixed by retrying. The parent exists from
 * the first container onward, so there is nothing to race.
 *
 * The cost, stated plainly: a container can read *other* containers' transcripts.
 * That is this install's own command output under one operator, and the property
 * that matters — the agent cannot **write** where the host writes — is unchanged.
 */
export function containerRunDir(containerName: string, runId: string): string {
  return `${RUNS_MOUNT_DIR}/${containerName}/${runId}`;
}

/**
 * Where the pid goes: a tmpfs inside the container, not the transcript directory.
 *
 * The transcript mount is read-only, so the command could not write there — and
 * a pid file the *host* had to create would have to match the container user's
 * uid, which the profile is explicitly encouraged to set to something else.
 */
function containerPidFile(runId: string): string {
  return `/tmp/.ghost-${runId}.pid`;
}

/**
 * The `docker exec` argv for one command.
 *
 * The environment is rebuilt rather than forwarded: see the module header on
 * `PATH`. A name the profile lists but the plan does not carry is simply absent,
 * which is the right outcome — an empty value would shadow the image's own.
 */
export function containerExecArgv(options: ContainerExecOptions): string[] {
  const { plan, toolbox, containerName, runId } = options;
  const argv: string[] = ['exec', '--workdir', toolbox.workdir];

  for (const name of toolbox.env) {
    const value = plan.env[name];
    if (value !== undefined) argv.push('--env', `${name}=${value}`);
  }

  argv.push(
    containerName,
    '/bin/sh',
    '-c',
    EXEC_SCRIPT,
    'ghost-exec',
    containerPidFile(runId),
    plan.file,
    ...plan.args,
  );
  return argv;
}

/** The `docker exec` argv that signals a run's recorded pid. */
export function containerKillArgv(
  options: Omit<ContainerExecOptions, 'plan'>,
  signal: 'TERM' | 'KILL',
): string[] {
  return [
    'exec',
    options.containerName,
    '/bin/sh',
    '-c',
    KILL_SCRIPT,
    'ghost-kill',
    containerPidFile(options.runId),
    signal,
  ];
}

/** Where a run's transcript lives on the host, and where the model should look. */
export interface Transcript {
  readonly hostDir: string;
  readonly containerDir: string;
  write(stream: 'stdout' | 'stderr', chunk: Uint8Array): void;
  /** Flushes and closes both files. Resolves when they are safe to read. */
  close(): Promise<void>;
}

/**
 * Opens a run's transcript beside the workspace's other artefacts.
 *
 * On the host, deliberately: the directory must exist before the container
 * writes its pid into it, and creating it here rather than in the script removes
 * a race against the mount becoming visible.
 *
 * A write failure is swallowed rather than raised. Losing a transcript is a
 * degraded result — the model still gets the command's output inline — while an
 * unhandled `error` on a `WriteStream` is an uncaught exception that takes the
 * process with it. A disk filling up must not end the turn.
 */
export function openTranscript(
  runsRoot: string,
  containerName: string,
  runId: string,
): Transcript {
  const hostDir = join(runsRoot, containerName, runId);
  mkdirSync(hostDir, { recursive: true });

  const open = (name: string): WriteStream => {
    const stream = createWriteStream(join(hostDir, name));
    stream.on('error', () => {
      /* see the doc comment */
    });
    return stream;
  };
  const stdout = open('stdout.log');
  const stderr = open('stderr.log');

  const finish = async (stream: WriteStream): Promise<void> => {
    await new Promise<void>((resolve) => {
      // `close`, not `finish`: the caller is about to tell the model to read
      // this file, and `finish` only means the writes were handed to the OS.
      stream.once('close', resolve);
      stream.once('error', () => {
        resolve();
      });
      stream.end();
    });
  };

  return {
    hostDir,
    containerDir: containerRunDir(containerName, runId),
    write(stream, chunk) {
      (stream === 'stdout' ? stdout : stderr).write(chunk);
    },
    async close() {
      await Promise.all([finish(stdout), finish(stderr)]);
    },
  };
}

/**
 * Whether a `docker exec` failed because the *container* is gone.
 *
 * The distinction matters because both arrive the same way: a non-zero exit and
 * something on stderr. A container that was removed out from under a warm session
 * — Docker Desktop restarted, `docker system prune`, an operator tidying up —
 * makes every command in that session fail with the daemon's words, and the model
 * is told its `nmap` invocation failed when `nmap` never ran. It then rewrites a
 * command that was already correct.
 *
 * Anchored at the start of stderr, not searched for anywhere in it: the daemon
 * writes its refusal *instead of* the command's output, so the message is the
 * whole of stderr. Matching mid-stream would misread a command that merely
 * printed one of these strings. The cost of a false positive is one wasted
 * container start, not a wrong answer.
 */
export function containerIsGone(outcome: RunOutcome): boolean {
  if (outcome.code === 0 || outcome.code === null) return false;
  const stderr = outcome.stderr.trimStart();
  return (
    // Docker: removed, or stopped but still present.
    /^Error response from daemon: (No such container|Container \S+ is not running)/i.test(
      stderr,
    ) ||
    /^Error: No such container/i.test(stderr) ||
    // Podman phrases both cases differently again.
    /^Error: no container with name or ID .* found/i.test(stderr) ||
    /^Error: can only create exec sessions on running containers/i.test(stderr)
  );
}

interface ContainerRunnerOptions {
  readonly toolbox: Toolbox;
  readonly containerName: string;
  /**
   * Host transcript root, shared by every container and long-lived.
   *
   * Outside the workspace — see `RUNS_MOUNT_DIR`. Each container's files sit under
   * `<runsRoot>/<containerName>/`, keyed on a name this pool generates rather than
   * on a client-chosen session key that has no business becoming a path component.
   */
  readonly runsRoot: string;
  /** Defaults to `docker`; `podman` is wire-compatible for everything used here. */
  readonly bin?: string;
  /** Supplies a run id per command. Injected so tests are deterministic. */
  readonly nextRunId: () => string;
  /** Where the underlying `docker` process runs. Defaults to `localRunner`. */
  readonly inner?: CommandRunner;
}

/**
 * Builds a `CommandRunner` bound to one container.
 *
 * The spawn itself is delegated, so output caps, `close`-not-`exit`, the
 * SIGTERM→SIGKILL escalation and abort threading all stay in one implementation
 * rather than being reimplemented slightly differently here.
 */
export function containerRunner(
  options: ContainerRunnerOptions,
): CommandRunner {
  const bin = options.bin ?? 'docker';
  const inner = options.inner ?? localRunner;

  return {
    async run(request: RunRequest): Promise<RunOutcome> {
      const runId = options.nextRunId();
      const transcript = openTranscript(
        options.runsRoot,
        options.containerName,
        runId,
      );
      const execArgv = containerExecArgv({
        plan: request.plan,
        toolbox: options.toolbox,
        containerName: options.containerName,
        runId,
      });

      // A plan for the `docker` client itself: its cwd and env are this
      // process's business, not the sandbox's. `maxOutputBytes` carries through
      // so the model still sees a bounded result even though the transcript on
      // disk is complete.
      const dockerPlan: ExecPlan = {
        file: bin,
        args: execArgv,
        cwd: options.runsRoot,
        env: { PATH: process.env.PATH ?? '' },
        timeoutMs: request.plan.timeoutMs,
        maxOutputBytes: request.plan.maxOutputBytes,
        paths: request.plan.paths,
      };

      const signalInside = (signal: 'TERM' | 'KILL'): void => {
        const killArgv = containerKillArgv(
          {
            toolbox: options.toolbox,
            containerName: options.containerName,
            runId,
          },
          signal,
        );
        void inner
          .run({
            plan: { ...dockerPlan, args: killArgv, timeoutMs: 5_000 },
            timeoutMs: 5_000,
            signal: new AbortController().signal,
            ...(request.clock === undefined ? {} : { clock: request.clock }),
          })
          .catch(() => {
            // Best effort. A container that has already exited is the common
            // case, and failing the turn over a kill that had nothing to kill
            // would be worse than the leak this is defending against.
          });
      };

      try {
        const outcome = await inner.run({
          ...request,
          plan: dockerPlan,
          tee: (stream, chunk) => {
            transcript.write(stream, chunk);
          },
        });
        // The client returning is not the process ending when the client was
        // killed rather than the command finishing.
        if (outcome.timedOut) signalInside('KILL');
        return { ...outcome, transcriptDir: transcript.containerDir };
      } catch (error) {
        signalInside('TERM');
        throw error;
      } finally {
        // Awaited, not fired and forgotten: the caller is about to hand the
        // model this path, and a half-written file is worse than none.
        await transcript.close();
      }
    },
  };
}
