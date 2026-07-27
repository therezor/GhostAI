/**
 * Switch.
 *
 * A switch is a checkbox that applies immediately, and the distinction is not
 * cosmetic: `role="switch"` is what tells a screen reader there is no Save
 * button coming. Radix supplies that plus `Space`/`Enter` and the hidden native
 * input that makes it work inside a form.
 *
 * On is `--color-accent` as a fill — a fill is exactly what the accent token is
 * for — and off is the strong line colour rather than a surface, so the track
 * stays visible against every one of the four surfaces.
 */

import * as SwitchPrimitive from '@radix-ui/react-switch';
import type { ComponentProps, JSX } from 'react';

import { cn } from '@/lib/cn.js';

export function Switch({
  className,
  ...props
}: ComponentProps<typeof SwitchPrimitive.Root>): JSX.Element {
  return (
    <SwitchPrimitive.Root
      className={cn(
        'inline-flex h-5 w-9 shrink-0 items-center rounded-xl border border-transparent p-0.5',
        'transition-colors data-[state=checked]:bg-accent data-[state=unchecked]:bg-line-strong',
        'disabled:pointer-events-none disabled:opacity-60',
        className,
      )}
      {...props}
    >
      {/* The thumb inverts with the track rather than staying one colour: a
          single thumb colour is legible on one of the two tracks and washed out
          on the other, in whichever theme you did not check. */}
      <SwitchPrimitive.Thumb
        className={cn(
          'pointer-events-none block size-4 rounded-xl shadow-xs',
          'data-[state=checked]:bg-on-fill data-[state=unchecked]:bg-fg-2',
          'transition-transform data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0',
        )}
      />
    </SwitchPrimitive.Root>
  );
}
