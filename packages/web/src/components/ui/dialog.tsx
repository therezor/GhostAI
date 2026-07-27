/**
 * Dialog.
 *
 * Radix contributes the behaviour that is genuinely hard and invisible when it
 * works: the focus trap, focus restoration to whatever opened it, `Escape`,
 * `aria-modal`, the outside-click, and marking the rest of the page inert for a
 * screen reader. Every class is ours; nothing about the styling is inherited
 * from a component library. That is the trade this package makes everywhere —
 * behaviour from Radix, appearance from the token layer.
 *
 * `DialogContent` renders a close button by default. A modal a keyboard user
 * can open and not leave is the single most common dialog bug, and `Escape`
 * alone does not help a pointer user on a touch device.
 */

import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type { ComponentProps, JSX } from 'react';

import { cn } from '@/lib/cn.js';

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;
export const DialogTitle = DialogPrimitive.Title;
export const DialogDescription = DialogPrimitive.Description;

export function DialogContent({
  className,
  children,
  showClose = true,
  ...props
}: ComponentProps<typeof DialogPrimitive.Content> & { readonly showClose?: boolean }): JSX.Element {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay
        className={cn(
          'fixed inset-0 z-50 bg-surface-0/70 backdrop-blur-sm',
          'data-[state=open]:animate-in data-[state=closed]:animate-out',
        )}
      />
      <DialogPrimitive.Content
        className={cn(
          'fixed top-1/2 left-1/2 z-50 w-[min(32rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2',
          'max-h-[calc(100dvh-2rem)] overflow-y-auto rounded-xl border border-line bg-surface-2 p-5 shadow-lg',
          className,
        )}
        {...props}
      >
        {children}
        {showClose && (
          <DialogPrimitive.Close
            aria-label="Close"
            className={cn(
              'absolute top-3.5 right-3.5 inline-flex size-7 items-center justify-center',
              'rounded-md text-fg-3 hover:bg-hover hover:text-fg-1',
            )}
          >
            <X className="size-4" />
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export function DialogHeader({ className, ...props }: ComponentProps<'div'>): JSX.Element {
  return <div className={cn('mb-4 flex flex-col gap-1 pr-8', className)} {...props} />;
}

export function DialogFooter({ className, ...props }: ComponentProps<'div'>): JSX.Element {
  return <div className={cn('mt-5 flex flex-wrap justify-end gap-2', className)} {...props} />;
}

export function DialogHeading({
  className,
  ...props
}: ComponentProps<typeof DialogPrimitive.Title>): JSX.Element {
  return <DialogPrimitive.Title className={cn('text-lg font-medium', className)} {...props} />;
}

export function DialogSubheading({
  className,
  ...props
}: ComponentProps<typeof DialogPrimitive.Description>): JSX.Element {
  return <DialogPrimitive.Description className={cn('text-sm text-fg-2', className)} {...props} />;
}
