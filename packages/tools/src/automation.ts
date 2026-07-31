/**
 * Where a scheduled job actually gets written.
 *
 * The store lives in `@ghostai/server`, which is four layers above this package,
 * so the tool cannot import it. The established answer is the one `runner.ts`
 * gives for `exec`: **the interface is declared down here, and the composition
 * root supplies the implementation.** `JailResolver` in `@ghostai/security` is
 * the same shape for the same reason.
 *
 * Worth stating, because the subagent design deliberately went the other way:
 * delegation is *not* a tool, because starting a turn would invert the layer
 * graph and because `ToolContext` has no event sink. Neither objection applies
 * here. Creating a job writes a row and returns a string — the turn it causes
 * happens later, on the scheduler's own timer, with nothing to stream and
 * nothing reaching back into a loop.
 *
 * **The port `forTurn` returns is bound to its caller.** It closes over the
 * agent and the session that asked, so the tool cannot name a different owner,
 * cannot see another agent's jobs and cannot delete one it did not make. Every
 * guard lives on that side rather than in the tool, because the tool runs on
 * arguments a model wrote and cannot be trusted to say who it is.
 */

import type { AutomationJob, CreateAutomationJob } from '@ghostai/protocol';

import type { ToolboxRequest } from './runner.js';

/** Why a job could not be created, listed or removed. */
export type AutomationRefusal =
  /** The calling turn is itself a scheduled run. */
  | 'nested'
  /** This agent already holds as many jobs as it may. */
  | 'at-capacity'
  /** No job with that id, or one this agent did not create. */
  | 'not-yours'
  /** The schedule cannot be honoured — an unreachable cron, a bad zone. */
  | 'unschedulable';

export interface AutomationOutcome<T> {
  readonly ok: boolean;
  readonly refusal?: AutomationRefusal;
  /** Set when `refusal` is `unschedulable`; the validator's own sentence. */
  readonly detail?: string;
  readonly value?: T;
}

/**
 * One turn's access to the scheduler, already scoped to the caller.
 *
 * Answers rather than throws, for the reason `refusedExecution` exists in the
 * subagent code: a model told its request was refused can carry on without it,
 * and a turn that dies instead leaves the operator with an error where an
 * answer was possible.
 */
export interface AutomationPort {
  create(input: CreateAutomationJob): AutomationOutcome<AutomationJob>;
  /** Only this agent's own jobs. */
  list(): AutomationOutcome<readonly AutomationJob[]>;
  delete(jobId: string): AutomationOutcome<void>;
}

/**
 * Supplies the port a turn's `automation` tool uses.
 *
 * `undefined` means this build has no scheduler — a headless install, or a route
 * test — and the tool says so rather than pretending. Keyed by `ToolboxRequest`
 * because that is already the per-turn identity the loop computes for `exec`,
 * and it carries exactly what is needed: the agent, the workspace and the
 * session.
 */
export interface AutomationResolver {
  forTurn(request: ToolboxRequest): AutomationPort | undefined;
}
