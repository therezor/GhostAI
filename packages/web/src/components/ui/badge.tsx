/**
 * The badge recipe.
 *
 * The variant is `tone`, not `role`, for one blunt reason: `role` is an HTML
 * attribute, and a prop of that name on a `<span>` would either shadow it or
 * silently pass `"danger"` through to the accessibility tree as an ARIA role.
 *
 * One pill, parameterised on semantic role — replacing what would otherwise
 * become a hand-written variant per usage: a risk badge on a tool card, a
 * `degraded` notice, a provider's "key present" indicator, a session's origin.
 * They are the same object with a different role, and writing them separately
 * is how twenty-five slightly different pills end up in one codebase.
 *
 * `soft` is the default because a badge is an annotation: a page of solid fills
 * competes with the content it annotates. `solid` exists for the one or two
 * places where a badge *is* the message.
 */

import { cva, type VariantProps } from 'class-variance-authority';
import type { HTMLAttributes, JSX } from 'react';

import { cn } from '@/lib/cn.js';

export const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-2xs font-medium whitespace-nowrap [&_svg]:size-3',
  {
    variants: {
      tone: {
        neutral: '',
        accent: '',
        success: '',
        warning: '',
        danger: '',
        info: '',
      },
      variant: {
        soft: '',
        solid: 'text-on-fill',
        outline: 'border bg-transparent',
      },
    },
    // The pairing is what carries the meaning, so it is expressed as one:
    // `role` alone cannot know whether it is colouring a fill or a label.
    compoundVariants: [
      { tone: 'neutral', variant: 'soft', class: 'bg-hover text-fg-2' },
      { tone: 'accent', variant: 'soft', class: 'bg-accent-soft text-accent-fg' },
      { tone: 'success', variant: 'soft', class: 'bg-success-soft text-success-fg' },
      { tone: 'warning', variant: 'soft', class: 'bg-warning-soft text-warning-fg' },
      { tone: 'danger', variant: 'soft', class: 'bg-danger-soft text-danger-fg' },
      { tone: 'info', variant: 'soft', class: 'bg-info-soft text-info-fg' },

      { tone: 'neutral', variant: 'solid', class: 'bg-line-strong text-fg-1' },
      { tone: 'accent', variant: 'solid', class: 'bg-accent' },
      { tone: 'success', variant: 'solid', class: 'bg-success' },
      { tone: 'warning', variant: 'solid', class: 'bg-warning' },
      { tone: 'danger', variant: 'solid', class: 'bg-danger' },
      { tone: 'info', variant: 'solid', class: 'bg-info' },

      { tone: 'neutral', variant: 'outline', class: 'border-line-strong text-fg-2' },
      { tone: 'accent', variant: 'outline', class: 'border-accent-fg text-accent-fg' },
      { tone: 'success', variant: 'outline', class: 'border-success-fg text-success-fg' },
      { tone: 'warning', variant: 'outline', class: 'border-warning-fg text-warning-fg' },
      { tone: 'danger', variant: 'outline', class: 'border-danger-fg text-danger-fg' },
      { tone: 'info', variant: 'outline', class: 'border-info-fg text-info-fg' },
    ],
    defaultVariants: { tone: 'neutral', variant: 'soft' },
  },
);

export interface BadgeProps
  extends HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

export function Badge({ className, tone, variant, ...props }: BadgeProps): JSX.Element {
  return <span className={cn(badgeVariants({ tone, variant }), className)} {...props} />;
}
