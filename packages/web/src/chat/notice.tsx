/**
 * The five advisory notices, as badges.
 *
 * `prompt_injection` is the one that shaped the rest. Detection in GhostAI is
 * **non-destructive**: the tool output passes through intact and the nonce
 * envelope does the actual defending, because replacing a matched result with a
 * warning banner means reading this project's own security documentation wipes
 * the output and leaves the model reasoning around a hole. So the UI's job is
 * exactly this badge — say that something in the output looked like an
 * instruction, and show the output anyway.
 *
 * The tones are chosen so the two that describe a *refusal* look different from
 * the three that describe a *degradation*: being denied a tool call and having
 * an image dropped to fit a context window are not the same news.
 */

import { AlertTriangle, Info, ShieldAlert, Scissors, ShieldX } from 'lucide-react';
import type { JSX } from 'react';

import type { NoticeKind } from '@ghostai/protocol';

import { cn } from '@/lib/cn.js';
import type { BadgeProps } from '@/components/ui/badge.js';

const NOTICES: Record<
  NoticeKind,
  { readonly label: string; readonly tone: NonNullable<BadgeProps['tone']>; readonly icon: typeof Info }
> = {
  prompt_injection: { label: 'Possible prompt injection', tone: 'danger', icon: ShieldAlert },
  approval_denied: { label: 'Denied', tone: 'danger', icon: ShieldX },
  degraded: { label: 'Degraded request', tone: 'warning', icon: AlertTriangle },
  truncated_history: { label: 'History trimmed', tone: 'warning', icon: Scissors },
  provider_fallback: { label: 'Provider fallback', tone: 'info', icon: Info },
};

const TONE_CLASSES = {
  danger: 'border-danger-fg/40 bg-danger-soft text-danger-fg',
  warning: 'border-warning-fg/40 bg-warning-soft text-warning-fg',
  info: 'border-info-fg/40 bg-info-soft text-info-fg',
  success: 'border-success-fg/40 bg-success-soft text-success-fg',
  accent: 'border-accent-fg/40 bg-accent-soft text-accent-fg',
  neutral: 'border-line-strong bg-hover text-fg-2',
} as const;

export function Notice({
  kind,
  message,
  className,
}: {
  readonly kind: NoticeKind;
  readonly message: string;
  readonly className?: string;
}): JSX.Element {
  const { label, tone, icon: Icon } = NOTICES[kind];

  return (
    <div
      // Not a `Badge`: a notice carries a sentence, and a pill that wraps to
      // three lines is not a pill. The tone vocabulary is shared, the shape is
      // not.
      className={cn(
        'flex items-start gap-2 rounded-md border px-2.5 py-1.5 text-xs',
        TONE_CLASSES[tone],
        className,
      )}
    >
      <Icon className="mt-0.5 size-3.5 shrink-0" />
      <span className="min-w-0">
        <span className="font-medium">{label}.</span> <span className="text-fg-2">{message}</span>
      </span>
    </div>
  );
}
