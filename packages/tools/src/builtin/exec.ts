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
 * Three parties, and the split between them is the point. `guardExec` decides
 * **whether** a command may run, and with what arguments and environment. A
 * `CommandRunner` decides **where** — a host child process today, a container
 * once there is a backend for one. What is left, and what this file owns:
 *
 *  - **Reconciling the two timeouts.** The model may ask for less time than the
 *    operator allows, never more, and `0` means unlimited on both sides — so it
 *    is not a plain `min`. See `effectiveTimeout`.
 *
 *  - **A non-zero exit is a result, not a failure.** `grep` finding nothing
 *    exits 1, and `tsc` failing is the answer the model asked for. Both come
 *    back as `isError` with the output intact, so the model can read the
 *    compiler errors rather than a wrapper's opinion of them.
 *
 *  - **How an outcome reads.** `renderOutcome` is what the model sees, and
 *    `details` is what an approval prompt and the audit log see.
 */

import { guardExec, type ExecPlan } from '@ghostai/security';
import { z } from 'zod';

import { assertNotAborted, defineTool, type AnyTool } from '../define.js';
import { localRunner, type RunOutcome } from '../runner.js';

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

    // Where it runs is the context's to decide; whether it may run was settled
    // above. `localRunner` is the host child process this tool has always been.
    const outcome = await (context.runner ?? localRunner).run({
      plan,
      timeoutMs: effectiveTimeout(plan, args.timeoutMs),
      signal: context.signal,
      ...(context.clock === undefined ? {} : { clock: context.clock }),
    });
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

function renderOutcome(
  argv: readonly string[],
  plan: ExecPlan,
  outcome: RunOutcome,
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
