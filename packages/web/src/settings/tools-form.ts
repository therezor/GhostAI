/**
 * The Tools panel's form.
 *
 * Same shape as the Agent panel's — strings in, patch or errors out — with one
 * field that is not like the others. `tools.approvals.timeoutMs` is `.positive()`
 * in the schema rather than `.nonnegative()`, so unlike every other duration in
 * the tree, **zero does not mean "no limit" here.** An approval that never
 * expires is a turn that waits forever for a browser tab that was closed an hour
 * ago, holding its tool call and its provider connection open. The bound below
 * is what turns that into a message instead of a 400.
 */

import type { ToolApprovalPolicy, ToolRisk, ToolsConfig } from '@ghostai/protocol';

import { msToSeconds, parseNumber, secondsToMs } from './fields.js';
import type { PatchResult } from './agent-form.js';

export const RISK_BANDS: readonly ToolRisk[] = ['safe', 'write', 'exec', 'network'];
export const APPROVAL_POLICIES: readonly ToolApprovalPolicy[] = ['allow', 'ask', 'deny'];

export interface ToolsForm {
  readonly approvals: Readonly<Record<ToolRisk, ToolApprovalPolicy>>;
  readonly approvalTimeoutSeconds: string;
  readonly execEnabled: boolean;
  readonly execTimeoutSeconds: string;
  readonly execMaxOutputBytes: string;
  readonly restrictToWorkspace: boolean;
  readonly maxOutputChars: string;
}

export function toToolsForm(tools: ToolsConfig): ToolsForm {
  return {
    approvals: {
      safe: tools.approvals.safe,
      write: tools.approvals.write,
      exec: tools.approvals.exec,
      network: tools.approvals.network,
    },
    approvalTimeoutSeconds: msToSeconds(tools.approvals.timeoutMs),
    execEnabled: tools.exec.enable,
    execTimeoutSeconds: msToSeconds(tools.exec.timeoutMs),
    execMaxOutputBytes: String(tools.exec.maxOutputBytes),
    restrictToWorkspace: tools.restrictToWorkspace,
    maxOutputChars: String(tools.maxOutputChars),
  };
}

export function toToolsPatch(form: ToolsForm): PatchResult {
  const errors: Record<string, string> = {};

  // `min: 1` second, not zero — see the note at the top of the file.
  const approvalTimeout = parseNumber(form.approvalTimeoutSeconds, { min: 1 });
  const execTimeout = parseNumber(form.execTimeoutSeconds, { min: 0 });
  const execMaxOutputBytes = parseNumber(form.execMaxOutputBytes, { integer: true, min: 1 });
  const maxOutputChars = parseNumber(form.maxOutputChars, { integer: true, min: 1 });

  if (!approvalTimeout.ok) errors.approvalTimeoutSeconds = approvalTimeout.error;
  if (!execTimeout.ok) errors.execTimeoutSeconds = execTimeout.error;
  if (!execMaxOutputBytes.ok) errors.execMaxOutputBytes = execMaxOutputBytes.error;
  if (!maxOutputChars.ok) errors.maxOutputChars = maxOutputChars.error;

  if (!approvalTimeout.ok || !execTimeout.ok || !execMaxOutputBytes.ok || !maxOutputChars.ok) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    patch: {
      tools: {
        approvals: {
          safe: form.approvals.safe,
          write: form.approvals.write,
          exec: form.approvals.exec,
          network: form.approvals.network,
          timeoutMs: secondsToMs(approvalTimeout.value),
        },
        exec: {
          enable: form.execEnabled,
          timeoutMs: secondsToMs(execTimeout.value),
          maxOutputBytes: execMaxOutputBytes.value,
        },
        restrictToWorkspace: form.restrictToWorkspace,
        maxOutputChars: maxOutputChars.value,
      },
    },
  };
}
