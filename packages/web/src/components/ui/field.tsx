/**
 * Text input, label and the error line that goes under them.
 *
 * Not Radix: an `<input>` needs no behaviour borrowed, and wrapping one would
 * add a layer whose only job is to forward props. What it does need is the
 * wiring that is forgotten by hand — `htmlFor`, `aria-invalid`,
 * `aria-describedby` pointing at the message — so `Field` generates the ids and
 * connects them, and a caller cannot render a label that labels nothing.
 */

import type { ComponentProps, JSX, ReactNode } from 'react';
import { useId } from 'react';

import { cn } from '@/lib/cn.js';

export function Input({ className, ...props }: ComponentProps<'input'>): JSX.Element {
  return (
    <input
      className={cn(
        'h-9 w-full rounded-md border border-line bg-surface-1 px-3 text-sm text-fg-1',
        'placeholder:text-fg-3',
        'aria-invalid:border-danger-fg',
        'disabled:pointer-events-none disabled:text-fg-3',
        className,
      )}
      {...props}
    />
  );
}

/**
 * The same input, sized for a list.
 *
 * `field-sizing-content` rather than a row count or a measured height: the
 * lists edited in Settings are two lines on one provider and twelve on another,
 * and a fixed `rows` is wrong for both. `min-h` is in `rem` like everything
 * else, so it grows with the user's font size instead of clipping at 200%.
 */
export function Textarea({ className, ...props }: ComponentProps<'textarea'>): JSX.Element {
  return (
    <textarea
      className={cn(
        'field-sizing-content min-h-16 w-full rounded-md border border-line bg-surface-1 px-3 py-2',
        'font-mono text-xs text-fg-1 placeholder:text-fg-3',
        'aria-invalid:border-danger-fg',
        'disabled:pointer-events-none disabled:text-fg-3',
        className,
      )}
      {...props}
    />
  );
}

export function Label({ className, ...props }: ComponentProps<'label'>): JSX.Element {
  return <label className={cn('text-sm font-medium text-fg-2', className)} {...props} />;
}

export interface FieldProps extends Omit<ComponentProps<'input'>, 'id'> {
  readonly label: ReactNode;
  /** Present means invalid: it sets `aria-invalid` and is announced. */
  readonly error?: string | undefined;
  readonly hint?: ReactNode;
}

export function Field({ label, error, hint, className, ...props }: FieldProps): JSX.Element {
  const id = useId();
  const messageId = `${id}-message`;
  const message = error ?? hint;

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        aria-invalid={error !== undefined}
        {...(message === undefined ? {} : { 'aria-describedby': messageId })}
        className={className}
        {...props}
      />
      {message !== undefined && (
        <p
          id={messageId}
          // `role="alert"` only when it *is* one: a hint announced as an alert
          // interrupts a screen reader mid-sentence for no reason.
          {...(error === undefined ? {} : { role: 'alert' })}
          className={cn('text-xs', error === undefined ? 'text-fg-3' : 'text-danger-fg')}
        >
          {message}
        </p>
      )}
    </div>
  );
}
