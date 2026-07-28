/**
 * `exec` — run a program in the workspace.
 *
 * The schema takes `argv: string[]`, never a command string. That single choice
 * removes the entire class of attack the Python source spent 22 regexes failing
 * to address: it scanned for `$(...)`, backticks and `| sh` in a string it then
 * handed to `create_subprocess_exec`, which does not interpret any of them — so
 * the patterns could only ever reject legitimate arguments (a commit message
 * containing `$HOME`, a grep for a pipe) while blocking nothing at all. With no
 * string, there is no parser, and nothing for a metacharacter to mean.
 *
 * The decisions this tool actually owns, given `guardExec` has already ruled on
 * the binary, the arguments and the environment:
 *
 *  - **`spawn`, not `execFile`.** They are the same call underneath and both run
 *    with `shell: false`; what differs is the overflow behaviour. `execFile`'s
 *    `maxBuffer` kills the child and discards *everything* it wrote, so a build
 *    that logs 2 MB returns nothing rather than its first megabyte. Streaming
 *    into `createOutputCap` — which `@ghostai/security` exports for exactly this
 *    — keeps the head of the output and lets the command finish.
 *
 *  - **A non-zero exit is a result, not a failure.** `grep` finding nothing
 *    exits 1, and `tsc` failing is the answer the model asked for. Both come
 *    back as `isError` with the output intact, so the model can read the
 *    compiler errors rather than a wrapper's opinion of them.
 *
 *  - **The signal reaches the child.** One `AbortSignal` runs from the WebSocket
 *    disconnect through the loop and the registry to `child.kill()` here, which
 *    is the end of the chain and the only place cancellation becomes a real
 *    process going away.
 */

import { spawn } from 'node:child_process';

import { GhostError, abortedError, systemClock } from '@ghostai/core';
import { createOutputCap, guardExec, type ExecPlan } from '@ghostai/security';
import { z } from 'zod';

import { assertNotAborted, defineTool, type AnyTool, type ToolContext } from '../define.js';

/** Grace between asking a child to stop and insisting. */
const KILL_GRACE_MS = 2_000;

const schema = z.strictObject({
  argv: z
    .array(z.string())
    .min(1)
    .describe(
      'Program and arguments as separate strings, e.g. ["git","status","--short"]. There is no shell: pipes, redirection and globs are not interpreted.',
    ),
  timeoutMs: z.coerce
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Kill the process after this many milliseconds. Capped by the operator setting.'),
});

interface ExecOutcome {
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
}

export const execTool: AnyTool = defineTool({
  name: 'exec',
  description:
    'Run a program in the workspace root and return its output. Arguments are passed as an argv array and are not interpreted by a shell. Unlike the file tools, an argument pointing outside the workspace is refused rather than resolved inside it — the child process runs on the real filesystem and is not confined to the workspace, so "/etc/passwd" and "../x" are errors here.',
  schema,
  risk: 'exec',
  annotations: {
    title: 'Run command',
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: true,
  },
  async execute(args, context) {
    assertNotAborted(context.signal, 'exec');

    // Throws on a denied binary, a shell, or an argument reaching outside the
    // workspace. `plan.paths` is what an approval prompt should display.
    const plan = guardExec(args.argv, {
      jail: context.jail,
      config: context.config.exec,
      ...(context.env === undefined ? {} : { env: context.env }),
    });

    const outcome = await runChild(plan, effectiveTimeout(plan, args.timeoutMs), context);
    return renderOutcome(args.argv, plan, outcome);
  },
});

/**
 * The model may ask for less time than the operator allows, never more.
 *
 * `0` means unlimited on both sides, which is why this is not a plain `min`: an
 * operator cap of 0 must not clamp a model's 30-second request to zero, and a
 * model's 0 must not lift a configured cap.
 */
function effectiveTimeout(plan: ExecPlan, requested: number | undefined): number {
  if (requested === undefined || requested === 0) return plan.timeoutMs;
  if (plan.timeoutMs === 0) return requested;
  return Math.min(requested, plan.timeoutMs);
}

function runChild(plan: ExecPlan, timeoutMs: number, context: ToolContext): Promise<ExecOutcome> {
  const clock = context.clock ?? systemClock;
  const stdout = createOutputCap(plan.maxOutputBytes);
  const stderr = createOutputCap(plan.maxOutputBytes);

  return new Promise<ExecOutcome>((resolve, reject) => {
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
      // A child that ignores SIGTERM — an editor, a REPL, anything holding the
      // terminal — would otherwise keep the turn's promise alive forever.
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
    context.signal.addEventListener('abort', onAbort, { once: true });

    const timer =
      timeoutMs > 0
        ? clock.setTimeout(() => {
            timedOut = true;
            stop();
          }, timeoutMs)
        : undefined;

    const cleanup = (): void => {
      context.signal.removeEventListener('abort', onAbort);
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

    // `close`, not `exit`: `exit` fires when the process ends, which can be
    // before its pipes have flushed, and the last lines of a compiler's output
    // are exactly the ones worth having.
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (context.signal.aborted && !timedOut) {
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
        signal,
        timedOut,
      });
    });
  });
}

function renderOutcome(
  argv: readonly string[],
  plan: ExecPlan,
  outcome: ExecOutcome,
): { content: string; isError: boolean; details: Readonly<Record<string, unknown>> } {
  const sections: string[] = [];
  if (outcome.stdout !== '') sections.push(outcome.stdout.trimEnd());
  if (outcome.stderr !== '') sections.push(`[stderr]\n${outcome.stderr.trimEnd()}`);
  if (sections.length === 0) sections.push('(no output)');

  if (outcome.truncated) {
    sections.push(`[exec: output truncated at ${String(plan.maxOutputBytes)} bytes per stream.]`);
  }
  if (outcome.timedOut) {
    sections.push('[exec: the command was killed after exceeding its time limit.]');
  }

  // The exit status goes last, where a reader — and a model reading a
  // truncated result — is most likely to still see it.
  const status =
    outcome.signal !== null
      ? `Killed by ${outcome.signal}`
      : `Exit code: ${String(outcome.code ?? 0)}`;
  sections.push(status);

  return {
    content: sections.join('\n\n'),
    isError: outcome.timedOut || outcome.signal !== null || (outcome.code ?? 0) !== 0,
    details: {
      argv: [...argv],
      paths: [...plan.paths],
      exitCode: outcome.code,
      signal: outcome.signal,
      timedOut: outcome.timedOut,
    },
  };
}
