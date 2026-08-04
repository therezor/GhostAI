/**
 * The `automation` tool's reach into the scheduler, scoped to one turn.
 *
 * Here rather than in `@ghostai/tools` because this is where the stores are —
 * and because every guard below needs to read something the tool has no
 * business being told. The tool passes arguments a model wrote; it does not get
 * to claim which agent it is, which session it is in, or whether it is allowed
 * to schedule at all. `forTurn` binds all three, so the port a tool receives can
 * only ever act as its actual caller.
 *
 * Three refusals, and one of them is the reason this file exists:
 *
 *  - **`nested`** — a scheduled run may not schedule. Without it a job whose
 *    payload asks the agent to "keep an eye on things" can create another job
 *    that does the same, and the install grows jobs geometrically with nobody
 *    watching. The check reads `sessions.origin` rather than trusting anything
 *    passed down, because the stored row is the only thing that cannot be
 *    argued with.
 *  - **`at-capacity`** — a cap per agent, so a model in a loop meets a wall
 *    instead of filling the table.
 *  - **`not-yours`** — an agent lists and deletes only what it created. The
 *    operator's own jobs are invisible to it.
 *
 * `refuseDelegation` in `@ghostai/agent` is the nearest existing guard and does
 * **not** cover the first one: it works off `turn.chain`, which is empty for a
 * turn a person started — and the scheduler starts turns exactly the same way.
 * Origin is the only honest signal.
 */

import {
  AUTOMATION_ORIGIN,
  type AutomationJob,
  type CreateAutomationJob,
} from '@ghostai/protocol';
import type { SessionStore } from '@ghostai/core';
import type {
  AutomationOutcome,
  AutomationPort,
  AutomationResolver,
  ToolboxRequest,
} from '@ghostai/tools';
import { isGhostError } from '@ghostai/core';

import type { AutomationStore } from './automation-store.js';
import { firstRunAt } from './scheduler.js';

/**
 * How many jobs one agent may hold.
 *
 * A backstop rather than a budget, in the spirit of `MAX_SUBAGENT_DEPTH`: the
 * thing that actually bounds this is that an operator has to grant the tool at
 * all, and each create prompts. This is what stops a model that has misread its
 * own instructions from turning that one grant into a thousand rows.
 */
export const MAX_AGENT_JOBS = 25;

export interface AutomationPortOptions {
  readonly jobs: AutomationStore;
  /** Read for the calling session's origin — the `nested` guard. */
  readonly sessions: SessionStore;
  /** The install's `ui.timezone` — the one zone a cron expression is read in. */
  readonly timezone: () => string;
  readonly now?: () => number;
  /** Re-arms the timer after a write, so a job created mid-turn actually fires. */
  readonly refresh?: () => void;
}

function refuse<T>(
  refusal: AutomationOutcome<T>['refusal'],
  detail?: string,
): AutomationOutcome<T> {
  return {
    ok: false,
    ...(refusal === undefined ? {} : { refusal }),
    ...(detail === undefined ? {} : { detail }),
  };
}

export function createAutomationResolver(
  options: AutomationPortOptions,
): AutomationResolver {
  const now = options.now ?? ((): number => Date.now());

  return {
    forTurn(request: ToolboxRequest): AutomationPort {
      const { agentId, sessionKey, workspaceId } = request;

      /** Whether this turn is itself a scheduled run. */
      const nested = (): boolean =>
        options.sessions.getSession(sessionKey)?.origin === AUTOMATION_ORIGIN;

      const mine = (): AutomationJob[] =>
        options.jobs
          .listJobs()
          .filter((job) => job.createdBy?.agentId === agentId);

      return {
        create(input: CreateAutomationJob): AutomationOutcome<AutomationJob> {
          if (nested()) return refuse('nested');
          if (options.jobs.countJobsBy(agentId) >= MAX_AGENT_JOBS) {
            return refuse('at-capacity');
          }

          // The same validator the REST route uses, so a schedule the timer
          // could not honour cannot be created here either — and the model gets
          // the parser's own sentence rather than a generic refusal.
          let nextRunAtMs: number;
          try {
            nextRunAtMs = firstRunAt(
              input.schedule,
              now(),
              input.enabled,
              options.timezone(),
            );
          } catch (error) {
            if (isGhostError(error) && error.kind === 'config') {
              return refuse('unschedulable', error.message);
            }
            throw error;
          }

          const created = options.jobs.createJob({
            name: input.name,
            schedule: input.schedule,
            // The run happens on the agent that asked for it. Stamped here and
            // not in the tool, for the same reason `createdBy` is: the tool
            // runs on arguments a model wrote, so letting it name an agent
            // would be letting it schedule a turn as somebody else.
            //
            // Without this the payload carried no `agentId`, the scheduler read
            // `undefined` as "the default agent", and every job any agent made
            // ran on a different prompt and a different tool grant than the one
            // that wrote it — which reads, from the outside, as the agent not
            // understanding the tool.
            //
            // `workspaceId` is stamped on the same argument and answers the same
            // failure: a job scheduled during a turn in a named workspace used
            // to run in the default one, so the follow-up work could not see the
            // files that prompted it. The turn's workspace is also the only one
            // this agent has any claim to — a model naming its own would be a
            // way out of the jail it is working in. It comes from the *stored*
            // session row, so it is always a real, legal id.
            payload: { ...input.payload, agentId, workspaceId },
            enabled: input.enabled,
            deleteAfterRun: input.deleteAfterRun,
            nextRunAtMs,
            createdBy: { agentId, sessionKey },
          });
          options.refresh?.();
          return { ok: true, value: created };
        },

        list(): AutomationOutcome<readonly AutomationJob[]> {
          // Deliberately allowed inside a scheduled run: reading what it has
          // scheduled tells a job something useful and creates nothing.
          return { ok: true, value: mine() };
        },

        delete(jobId: string): AutomationOutcome<void> {
          const job = options.jobs.getJob(jobId);
          // One answer for "no such job" and "not yours", so an agent cannot
          // map the operator's jobs by probing ids for the difference.
          if (job === undefined || job.createdBy?.agentId !== agentId) {
            return refuse('not-yours');
          }
          options.jobs.deleteJob(jobId);
          options.refresh?.();
          return { ok: true };
        },
      };
    },
  };
}
