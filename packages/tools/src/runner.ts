/**
 * Where a guarded command actually runs.
 *
 * `exec` has always spawned a child process on the host, inside the workspace
 * jail. That is one answer to "where", not the only one, and the jail's own
 * header is blunt about the limit: *a workspace is an organisational boundary,
 * not a security boundary, wherever `exec` is enabled — a child process can walk
 * out of it.* Closing that gap means running the command somewhere it cannot
 * walk out of, which is a different backend rather than a stricter guard.
 *
 * So the spawn is behind a seam. `guardExec` still decides **whether** a command
 * may run and with what arguments and environment; a `CommandRunner` decides
 * **where**, and `ExecPlan` is already the complete description of the job —
 * file, args, cwd, env, timeout and output budget.
 *
 * The constraint a container backend has to honour, recorded here because it is
 * the part that will bite: `guardExec` computes `cwd` from `jail.root` and the
 * environment from a host allow-list. Both are host-shaped. A runner that mounts
 * the workspace elsewhere has to translate the working directory and every path
 * in `plan.paths` to its own view — and once only the workspace is mounted,
 * `guardExec`'s refuse-outside-the-workspace rule becomes redundant rather than
 * wrong, so it stays.
 */

import { spawn } from 'node:child_process';

import { GhostError, abortedError, systemClock, type Clock } from '@ghostai/core';
import { createOutputCap, type ExecPlan } from '@ghostai/security';

/** Grace between asking a child to stop and insisting. */
export const KILL_GRACE_MS = 2_000;

export interface RunRequest {
  /** What to run. Already guarded — a runner does not re-decide policy. */
  readonly plan: ExecPlan;
  /** `0` means no limit. Already reconciled between the model and the operator. */
  readonly timeoutMs: number;
  /** The turn's cancellation, threaded all the way from the transport. */
  readonly signal: AbortSignal;
  readonly clock?: Clock;
}

/** What a command did. Identical whether it ran on the host or elsewhere. */
export interface RunOutcome {
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
}

export interface CommandRunner {
  run(request: RunRequest): Promise<RunOutcome>;
}

/**
 * A child process on this machine, in the workspace root.
 *
 * The behaviour `exec` has always had, and the default whenever a context does
 * not name a runner — so nothing that builds a `ToolContext` today has to change.
 *
 *  - **`spawn`, not `execFile`.** They are the same call underneath and both run
 *    with `shell: false`; what differs is the overflow behaviour. `execFile`'s
 *    `maxBuffer` kills the child and discards *everything* it wrote, so a build
 *    that logs 2 MB returns nothing rather than its first megabyte. Streaming
 *    into `createOutputCap` keeps the head of the output and lets the command
 *    finish.
 *  - **`close`, not `exit`.** `exit` fires when the process ends, which can be
 *    before its pipes have flushed, and the last lines of a compiler's output
 *    are exactly the ones worth having.
 *  - **The signal reaches the child.** One `AbortSignal` runs from the WebSocket
 *    disconnect through the loop and the registry to `child.kill()` here, which
 *    is the end of the chain and the only place cancellation becomes a real
 *    process going away.
 */
export const localRunner: CommandRunner = {
  run(request: RunRequest): Promise<RunOutcome> {
    const { plan, timeoutMs, signal } = request;
    const clock = request.clock ?? systemClock;
    const stdout = createOutputCap(plan.maxOutputBytes);
    const stderr = createOutputCap(plan.maxOutputBytes);

    return new Promise<RunOutcome>((resolve, reject) => {
      const child = spawn(plan.file, [...plan.args], {
        cwd: plan.cwd,
        env: { ...plan.env },
        shell: false,
        windowsHide: true,
      });

      let timedOut = false;
      let settled = false;

      const stop = (): void => {
        child.kill('SIGTERM');
        // A child that ignores SIGTERM — an editor, a REPL, anything holding
        // the terminal — would otherwise keep the turn's promise alive forever.
        const escalation = clock.setTimeout(() => {
          child.kill('SIGKILL');
        }, KILL_GRACE_MS);
        child.once('close', () => {
          clock.clearTimeout(escalation);
        });
      };

      const onAbort = (): void => {
        stop();
      };
      signal.addEventListener('abort', onAbort, { once: true });

      const timer =
        timeoutMs > 0
          ? clock.setTimeout(() => {
              timedOut = true;
              stop();
            }, timeoutMs)
          : undefined;

      const cleanup = (): void => {
        signal.removeEventListener('abort', onAbort);
        if (timer !== undefined) clock.clearTimeout(timer);
      };

      // Closing the pipe once the budget is spent is the point of the cap's
      // boolean return: a command that has already written more than the model
      // can be shown gets the same treatment `head` would give it, rather than
      // being read to the end so its output can be thrown away.
      child.stdout.on('data', (chunk: Buffer) => {
        if (!stdout.push(chunk)) child.stdout.destroy();
      });
      child.stderr.on('data', (chunk: Buffer) => {
        if (!stderr.push(chunk)) child.stderr.destroy();
      });

      child.on('error', (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(
          new GhostError('tool', `Could not run ${plan.file}: ${error.message}`, {
            cause: error,
            details: { file: plan.file },
          }),
        );
      });

      child.on('close', (code, closeSignal) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (signal.aborted && !timedOut) {
          reject(abortedError('exec'));
          return;
        }
        const out = stdout.done();
        const err = stderr.done();
        resolve({
          stdout: out.text,
          stderr: err.text,
          truncated: out.truncated || err.truncated,
          code,
          signal: closeSignal,
          timedOut,
        });
      });
    });
  },
};
