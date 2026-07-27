/**
 * The approval prompt, inline in the tool card that raised it.
 *
 * Inline and not a dialog, deliberately. A modal over the transcript hides the
 * conversation that produced the request, which is the only context that makes
 * the decision answerable — "run `rm -rf build`?" is a different question
 * depending on what was asked a paragraph earlier. It also cannot stack: two
 * tabs, or one turn with two gated calls, would queue modals.
 *
 * The three scopes are the protocol's, and each is a different promise:
 *
 *  - **Once** — this call. The next one asks again.
 *  - **Session** — every call to this tool for the rest of the conversation.
 *  - **Always** — as long as the server is up. It is not persisted, and the
 *    label says so, because a "never ask me again" that survives restarts and
 *    has no visible way back is a decision the user cannot undo.
 *
 * The deadline is the server's `expiresAtMs`, counted down locally. When it
 * passes, the buttons go: pressing one would send an answer the gate stopped
 * waiting for, and a button that does nothing is worse than no button.
 */

import { Check, ShieldAlert, X } from 'lucide-react';
import { useEffect, useState, type JSX } from 'react';

import type { ApprovalScope } from '@ghostai/protocol';

import { formatDuration } from '@/lib/format.js';
import { Button } from '@/components/ui/button.js';
import { Tooltip } from '@/components/ui/tooltip.js';
import type { ToolApprovalState } from '@/state/transcript.js';

export interface ApprovalPromptProps {
  readonly toolName: string;
  readonly approval: ToolApprovalState;
  readonly onAnswer: (approved: boolean, scope: ApprovalScope) => void;
}

const SCOPES: readonly {
  readonly scope: ApprovalScope;
  readonly label: string;
  readonly hint: string;
}[] = [
  { scope: 'once', label: 'Once', hint: 'Run this one call. The next one asks again.' },
  { scope: 'session', label: 'This session', hint: 'Allow this tool for the rest of this conversation.' },
  {
    scope: 'always',
    label: 'Always',
    hint: 'Allow this tool until the server restarts. Not written to disk.',
  },
];

export function ApprovalPrompt({
  toolName,
  approval,
  onAnswer,
}: ApprovalPromptProps): JSX.Element | null {
  const remainingMs = useCountdown(approval.expiresAtMs);
  const answered = approval.answered;

  if (answered !== undefined) {
    return (
      <p className="flex items-center gap-1.5 border-t border-line px-3 py-2 text-xs text-fg-3">
        {answered === 'approved' ? (
          <Check className="size-3.5 text-success-fg" />
        ) : (
          <X className="size-3.5 text-danger-fg" />
        )}
        {answered === 'approved' ? 'Approved' : 'Denied'} — waiting for the agent.
      </p>
    );
  }

  if (remainingMs <= 0) {
    return (
      <p className="border-t border-line px-3 py-2 text-xs text-fg-3">
        The approval window closed. The call was refused.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2 border-t border-line bg-warning-soft px-3 py-2.5">
      <p className="flex items-center gap-1.5 text-xs text-fg-1">
        <ShieldAlert className="size-3.5 shrink-0 text-warning-fg" />
        <span>
          <strong className="font-medium">{toolName}</strong> needs approval to run.
        </span>
        {/* A live region, because the number changes without anyone acting —
            but `polite` and on a coarse value, or a screen reader reads a
            countdown out loud once a second. */}
        <span className="ml-auto tabular-nums text-fg-3" role="timer" aria-live="off">
          {/* Formatted, not raw seconds: a generous `approvals.timeoutMs`
              otherwise counts down from a four-digit number. */}
          {formatDuration(Math.ceil(remainingMs / 1000) * 1000)}
        </span>
      </p>

      <div className="flex flex-wrap items-center gap-1.5">
        {SCOPES.map(({ scope, label, hint }) => (
          <Tooltip key={scope} label={hint}>
            <Button
              size="sm"
              variant={scope === 'once' ? 'primary' : 'secondary'}
              onClick={() => {
                onAnswer(true, scope);
              }}
            >
              {label}
            </Button>
          </Tooltip>
        ))}

        <div className="flex-1" />

        <Button
          size="sm"
          variant="danger"
          onClick={() => {
            onAnswer(false, 'once');
          }}
        >
          Deny
        </Button>
      </div>
    </div>
  );
}

/**
 * Milliseconds left, ticking once a second.
 *
 * A second is the right cadence because that is the resolution shown. Ticking
 * on `requestAnimationFrame` would re-render sixty times to change a number
 * once.
 */
function useCountdown(deadlineMs: number): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (deadlineMs <= now) return undefined;
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      clearInterval(timer);
    };
    // `now` is deliberately not a dependency: it changes on every tick, and
    // including it would tear down and rebuild the interval each second.
  }, [deadlineMs]);

  return deadlineMs - now;
}
