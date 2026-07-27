/**
 * Scroll area.
 *
 * The native scrollbar is already themed in `base.css`, so this is not about
 * appearance — it is for the two places where the native one is wrong: a
 * scroll container inside a portal (a long menu, the notification list), where
 * an overlay scrollbar would sit above the content, and the chat transcript in
 * Step 17, which needs a scroll position it can drive programmatically.
 *
 * Everything else should keep using `overflow-y-auto` and the native bar.
 */

import * as ScrollAreaPrimitive from '@radix-ui/react-scroll-area';
import type { ComponentProps, JSX } from 'react';

import { cn } from '@/lib/cn.js';

export function ScrollArea({
  className,
  children,
  viewportRef,
  ...props
}: ComponentProps<typeof ScrollAreaPrimitive.Root> & {
  readonly viewportRef?: React.Ref<HTMLDivElement>;
}): JSX.Element {
  return (
    <ScrollAreaPrimitive.Root className={cn('relative overflow-hidden', className)} {...props}>
      <ScrollAreaPrimitive.Viewport ref={viewportRef} className="size-full">
        {children}
      </ScrollAreaPrimitive.Viewport>
      <ScrollBar />
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  );
}

export function ScrollBar({
  className,
  orientation = 'vertical',
  ...props
}: ComponentProps<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>): JSX.Element {
  return (
    <ScrollAreaPrimitive.ScrollAreaScrollbar
      orientation={orientation}
      className={cn(
        'flex touch-none select-none p-0.5',
        // `--scrollbar-size` is the same token the native bar uses in
        // `base.css`, so the two are the same width wherever they meet.
        orientation === 'vertical' && 'h-full w-(--scrollbar-size) border-l border-transparent',
        orientation === 'horizontal' && 'h-(--scrollbar-size) flex-col border-t border-transparent',
        className,
      )}
      {...props}
    >
      <ScrollAreaPrimitive.ScrollAreaThumb className="relative flex-1 rounded-xl bg-line-strong" />
    </ScrollAreaPrimitive.ScrollAreaScrollbar>
  );
}
