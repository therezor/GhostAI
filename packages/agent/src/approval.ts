/**
 * The tool approval gate.
 *
 * `@ghostai/protocol` has described this end to end since Step 2 — a risk band
 * per tool, a policy per band, a scope per answer — and until now nothing read
 * any of it. The loop is where it has to be read, because the loop is the only
 * thing that sits between a model asking for `exec` and a shell running.
 *
 * The split is deliberate and it is the whole design:
 *
 *  - **The loop decides whether to ask.** That is a pure function of the tool's
 *    risk and the deployment's policy, so no transport can forget to check and
 *    no transport can decide the answer differently.
 *  - **The gate decides the answer**, and it is the gate that remembers one.
 *    `once | session | always` is scope *memory*, which needs a session-shaped
 *    store and a way to persist `always` — both of which belong to the thing
 *    holding the connection to a human, not to a turn that will end in a minute.
 *  - **The loop owns the deadline.** A gate that never resolves — a browser tab
 *    closed on an open prompt — would otherwise hang the turn forever, and the
 *    turn is the only party that knows it is still waiting.
 *
 * An absent gate means nobody is there to ask, so an `ask` policy runs the tool:
 * that is what keeps `ghost chat` behaving as it did. A `deny` policy is refused
 * either way, since refusing needs no one to answer.
 */

import type { ApprovalScope, ToolRisk } from '@ghostai/protocol';

/** One call, waiting on a decision. Mirrors the `tool.approvalRequest` event. */
export interface ApprovalRequest {
  readonly sessionKey: string;
  readonly turnId: string;
  readonly callId: string;
  readonly name: string;
  /** Parsed arguments when the model emitted valid JSON; the raw string otherwise. */
  readonly args: unknown;
  readonly risk: ToolRisk;
  /** Wall-clock deadline, the same value the event carries. */
  readonly expiresAtMs: number;
  /**
   * The turn's signal.
   *
   * A gate that keeps pending prompts must drop this one when it fires — the
   * loop stops waiting either way, and a prompt left on screen for a turn that
   * has already ended is a decision that can no longer mean anything.
   */
  readonly signal: AbortSignal;
}

export interface ApprovalDecision {
  readonly approved: boolean;
  /**
   * What the answer covers.
   *
   * The loop never reads it: remembering that `exec` was approved for the rest
   * of the session is the gate's job, and a loop that cached it would have to
   * be told when the user revoked it.
   */
  readonly scope?: ApprovalScope;
  /** Logged, never shown to the model. */
  readonly reason?: string;
}

export interface ApprovalGate {
  /**
   * Resolves when a decision is made. Rejecting is treated as a refusal — a
   * gate that fails open is not a gate.
   */
  request(request: ApprovalRequest): Promise<ApprovalDecision>;
}

/**
 * Why a call was refused.
 *
 * `policy` never reached a human; the other two did, or should have. The
 * distinction is worth keeping because it is the difference between "this
 * deployment does not do that" and "you were asked and said no", and a model
 * that cannot tell them apart retries the first one.
 */
export type DenialReason = 'policy' | 'declined' | 'timeout';

/** What the model reads. Phrased to stop a retry loop, not to explain a UI. */
export function deniedToolResult(name: string, reason: DenialReason): string {
  const cause =
    reason === 'policy'
      ? `the "${name}" tool is blocked by this deployment's approval policy`
      : reason === 'declined'
        ? `the user refused this call to "${name}"`
        : `nobody answered the approval request for "${name}" in time`;
  return (
    `Denied: ${cause}. The tool did not run. Do not call it again — ` +
    `continue without it, or tell the user what you need and why.`
  );
}

/** What a human reads, in a notice beside the tool card. */
export function deniedNotice(name: string, reason: DenialReason): string {
  switch (reason) {
    case 'policy':
      return `Blocked "${name}": the approval policy for this tool is "deny".`;
    case 'declined':
      return `Denied "${name}": the call was refused.`;
    case 'timeout':
      return `Denied "${name}": the approval request expired before it was answered.`;
  }
}
