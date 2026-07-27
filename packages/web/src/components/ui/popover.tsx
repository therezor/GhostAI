/**
 * Popover — a floating surface that takes focus, unlike a tooltip.
 *
 * Shares `surfaceClasses` with the dropdown menu so the two cannot drift apart:
 * a popover and a menu that disagree about border, radius or elevation read as
 * two different applications.
 */

import * as PopoverPrimitive from '@radix-ui/react-popover';
import type { ComponentProps, JSX } from 'react';

import { cn } from '@/lib/cn.js';
import { surfaceClasses } from './dropdown-menu.js';

export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;
export const PopoverAnchor = PopoverPrimitive.Anchor;
export const PopoverClose = PopoverPrimitive.Close;

export function PopoverContent({
  className,
  sideOffset = 6,
  align = 'center',
  ...props
}: ComponentProps<typeof PopoverPrimitive.Content>): JSX.Element {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        sideOffset={sideOffset}
        align={align}
        className={cn(surfaceClasses, 'p-3 data-[state=open]:animate-pop-in', className)}
        {...props}
      />
    </PopoverPrimitive.Portal>
  );
}
