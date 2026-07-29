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
import { useTranslation } from 'react-i18next';
import type { WebKey } from '@/i18n/keys.js';

import type { NoticeKind } from '@ghostai/protocol';

import { cn } from '@/lib/cn.js';
import type { BadgeProps } from '@/components/ui/badge.js';

const NOTICES: Record<
  NoticeKind,
  {
    readonly label: WebKey;
    readonly tone: NonNullable<BadgeProps['tone']>;
    readonly icon: typeof Info;
  }
> = {
  prompt_injection: { label: 'chat.notices.prompt_injection', tone: 'danger', icon: ShieldAlert },
  approval_denied: { label: 'chat.notices.approval_denied', tone: 'danger', icon: ShieldX },
  degraded: { label: 'chat.notices.degraded', tone: 'warning', icon: AlertTriangle },
  truncated_history: { label: 'chat.notices.truncated_history', tone: 'warning', icon: Scissors },
  provider_fallback: { label: 'chat.notices.provider_fallback', tone: 'info', icon: Info },
};

/** Neutral is the base rule in `chat.css`, so it needs no modifier. */
const TONE_CLASSES = {
  danger: 'notice--danger',
  warning: 'notice--warning',
  info: 'notice--info',
  success: 'notice--success',
  accent: 'notice--accent',
  neutral: '',
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
  const { t } = useTranslation();
  const { label, tone, icon: Icon } = NOTICES[kind];
  const text = t(label);

  return (
    <div
      // Not a `Badge`: a notice carries a sentence, and a pill that wraps to
      // three lines is not a pill. The tone vocabulary is shared, the shape is
      // not.
      className={cn('notice', TONE_CLASSES[tone], className)}
    >
      <Icon />
      <span>
        <span className="notice__label">{text}.</span>{' '}
        <span className="notice__message">{message}</span>
      </span>
    </div>
  );
}
