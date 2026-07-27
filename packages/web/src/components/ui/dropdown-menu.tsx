/**
 * Dropdown menu.
 *
 * The behaviour worth not writing twice: roving focus with type-ahead, arrow
 * keys, `Escape`, pointer-vs-keyboard open semantics, and collision-aware
 * placement in a portal. The portal is also why most of a z-index scale can
 * retire — layering is a DOM-order question once everything overlaying the page
 * is a sibling at the end of `<body>`.
 */

import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu';
import { Check } from 'lucide-react';
import type { ComponentProps, JSX } from 'react';

import { cn } from '@/lib/cn.js';

export const DropdownMenu = DropdownMenuPrimitive.Root;
export const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger;
export const DropdownMenuGroup = DropdownMenuPrimitive.Group;
export const DropdownMenuRadioGroup = DropdownMenuPrimitive.RadioGroup;

/** Shared by every floating surface here, so a popover and a menu cannot drift. */
export const surfaceClasses =
  'z-50 min-w-[8rem] overflow-hidden rounded-lg border border-line bg-surface-3 p-1 shadow-md';

export function DropdownMenuContent({
  className,
  sideOffset = 6,
  ...props
}: ComponentProps<typeof DropdownMenuPrimitive.Content>): JSX.Element {
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content
        sideOffset={sideOffset}
        className={cn(surfaceClasses, 'data-[state=open]:animate-pop-in', className)}
        {...props}
      />
    </DropdownMenuPrimitive.Portal>
  );
}

export const itemClasses = cn(
  'relative flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm text-fg-2',
  'select-none data-[highlighted]:bg-hover data-[highlighted]:text-fg-1',
  'data-[disabled]:pointer-events-none data-[disabled]:text-fg-3 data-[disabled]:opacity-70',
  '[&_svg]:size-4 [&_svg]:shrink-0',
);

export function DropdownMenuItem({
  className,
  ...props
}: ComponentProps<typeof DropdownMenuPrimitive.Item>): JSX.Element {
  return <DropdownMenuPrimitive.Item className={cn(itemClasses, className)} {...props} />;
}

export function DropdownMenuRadioItem({
  className,
  children,
  ...props
}: ComponentProps<typeof DropdownMenuPrimitive.RadioItem>): JSX.Element {
  return (
    <DropdownMenuPrimitive.RadioItem className={cn(itemClasses, 'pl-7', className)} {...props}>
      <span className="absolute left-2 inline-flex items-center justify-center">
        <DropdownMenuPrimitive.ItemIndicator>
          <Check className="size-3.5 text-accent-fg" />
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </DropdownMenuPrimitive.RadioItem>
  );
}

export function DropdownMenuLabel({
  className,
  ...props
}: ComponentProps<typeof DropdownMenuPrimitive.Label>): JSX.Element {
  return (
    <DropdownMenuPrimitive.Label
      className={cn(
        'px-2 py-1.5 text-2xs font-medium tracking-wide text-fg-3 uppercase',
        className,
      )}
      {...props}
    />
  );
}

export function DropdownMenuSeparator({
  className,
  ...props
}: ComponentProps<typeof DropdownMenuPrimitive.Separator>): JSX.Element {
  return (
    // A border rather than a filled `h-px` div: the hairline is `--hairline`,
    // and `border` is the one utility that already means exactly that.
    <DropdownMenuPrimitive.Separator
      className={cn('my-1 border-t border-line', className)}
      {...props}
    />
  );
}
