/**
 * Select.
 *
 * Radix rather than a native `<select>` because Step 18's provider and model
 * pickers need grouping, descriptions and a searchable-length list, none of
 * which a native control can style — and because a native `<select>` on a dark
 * theme renders its popup in the OS's colours, which is the one place a
 * carefully built theme visibly ends.
 *
 * What that costs is keyboard behaviour, so it has to be borrowed rather than
 * written: type-ahead, `Home`/`End`, and the popup positioning that keeps the
 * selected item under the cursor.
 */

import * as SelectPrimitive from '@radix-ui/react-select';
import { Check, ChevronDown } from 'lucide-react';
import type { ComponentProps, JSX } from 'react';

import { cn } from '@/lib/cn.js';
import { surfaceClasses } from './dropdown-menu.js';

export const Select = SelectPrimitive.Root;
export const SelectGroup = SelectPrimitive.Group;
export const SelectValue = SelectPrimitive.Value;

export function SelectTrigger({
  className,
  children,
  ...props
}: ComponentProps<typeof SelectPrimitive.Trigger>): JSX.Element {
  return (
    <SelectPrimitive.Trigger
      className={cn(
        'inline-flex h-9 w-full items-center justify-between gap-2 rounded-md',
        'border border-line bg-surface-1 px-3 text-sm text-fg-1',
        'hover:bg-hover data-[placeholder]:text-fg-3',
        'disabled:pointer-events-none disabled:text-fg-3',
        className,
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon asChild>
        <ChevronDown className="size-4 text-fg-3" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

export function SelectContent({
  className,
  children,
  position = 'popper',
  ...props
}: ComponentProps<typeof SelectPrimitive.Content>): JSX.Element {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        position={position}
        className={cn(
          surfaceClasses,
          'max-h-[min(20rem,var(--radix-select-content-available-height))]',
          position === 'popper' && 'w-[var(--radix-select-trigger-width)]',
          className,
        )}
        {...props}
      >
        <SelectPrimitive.Viewport className="p-0">{children}</SelectPrimitive.Viewport>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
}

export function SelectItem({
  className,
  children,
  ...props
}: ComponentProps<typeof SelectPrimitive.Item>): JSX.Element {
  return (
    <SelectPrimitive.Item
      className={cn(
        'relative flex cursor-default items-center rounded-md py-1.5 pr-2 pl-7 text-sm text-fg-2',
        'select-none data-[highlighted]:bg-hover data-[highlighted]:text-fg-1',
        'data-[disabled]:pointer-events-none data-[disabled]:text-fg-3',
        className,
      )}
      {...props}
    >
      <span className="absolute left-2 inline-flex items-center justify-center">
        <SelectPrimitive.ItemIndicator>
          <Check className="size-3.5 text-accent-fg" />
        </SelectPrimitive.ItemIndicator>
      </span>
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    </SelectPrimitive.Item>
  );
}

export function SelectLabel({
  className,
  ...props
}: ComponentProps<typeof SelectPrimitive.Label>): JSX.Element {
  return (
    <SelectPrimitive.Label
      className={cn(
        'px-2 py-1.5 text-2xs font-medium tracking-wide text-fg-3 uppercase',
        className,
      )}
      {...props}
    />
  );
}
