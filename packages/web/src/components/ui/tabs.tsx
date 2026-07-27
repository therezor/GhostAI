/**
 * Tabs.
 *
 * Radix gives the roving tabindex and the `aria-controls` wiring; the reason to
 * use it rather than a row of buttons is that arrow-key navigation between tabs
 * is what a screen-reader user expects and nobody remembers to implement.
 *
 * The active tab is marked with a surface change and a text tier, never with
 * colour alone — colour alone fails for the same users the roving tabindex is
 * for.
 */

import * as TabsPrimitive from '@radix-ui/react-tabs';
import type { ComponentProps, JSX } from 'react';

import { cn } from '@/lib/cn.js';

export const Tabs = TabsPrimitive.Root;

export function TabsList({
  className,
  ...props
}: ComponentProps<typeof TabsPrimitive.List>): JSX.Element {
  return (
    <TabsPrimitive.List
      className={cn(
        'inline-flex items-center gap-1 rounded-lg border border-line bg-surface-1 p-1',
        className,
      )}
      {...props}
    />
  );
}

export function TabsTrigger({
  className,
  ...props
}: ComponentProps<typeof TabsPrimitive.Trigger>): JSX.Element {
  return (
    <TabsPrimitive.Trigger
      className={cn(
        'inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-sm text-fg-2',
        'transition-colors hover:text-fg-1',
        'data-[state=active]:bg-surface-3 data-[state=active]:text-fg-1',
        'disabled:pointer-events-none disabled:text-fg-3',
        className,
      )}
      {...props}
    />
  );
}

export function TabsContent({
  className,
  ...props
}: ComponentProps<typeof TabsPrimitive.Content>): JSX.Element {
  return <TabsPrimitive.Content className={cn('mt-4', className)} {...props} />;
}
