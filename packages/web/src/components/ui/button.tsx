/**
 * The button recipe.
 *
 * One `cva` call replaces what would otherwise be a dozen near-identical
 * components — and, more importantly, makes the *rules* legible: a primary
 * button is `--color-accent` as a fill with `--color-on-fill` as its text, and
 * that pairing is asserted at AA in both themes by the contrast suite. A
 * variant that invented its own colours would be outside that guarantee.
 *
 * Nothing here suppresses the focus outline, and nothing anywhere else does
 * either. The base layer's `:focus-visible` ring applies to every focusable
 * element, so a component that removed it would be opting out of the one thing
 * that makes the app keyboard usable — which is why `a11y.test.tsx` sweeps the
 * source for the utilities that would.
 */

import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import type { ButtonHTMLAttributes, JSX, Ref } from 'react';

import { cn } from '@/lib/cn.js';

export const buttonVariants = cva(
  cn(
    'inline-flex shrink-0 items-center justify-center gap-2 rounded-md font-medium',
    'transition-colors duration-100 select-none',
    // A disabled control still has to be readable — `opacity-50` on a
    // `--color-fg-2` label is not, so the tier moves instead.
    'disabled:pointer-events-none disabled:text-fg-3 disabled:opacity-70',
    '[&_svg]:pointer-events-none [&_svg]:shrink-0',
  ),
  {
    variants: {
      variant: {
        primary: 'bg-accent text-on-fill hover:brightness-110 active:brightness-95',
        secondary: 'bg-surface-3 text-fg-1 border border-line hover:bg-hover',
        ghost: 'text-fg-2 hover:bg-hover hover:text-fg-1',
        danger: 'bg-danger text-on-fill hover:brightness-110 active:brightness-95',
        link: 'text-accent-fg underline underline-offset-2 hover:brightness-110',
      },
      size: {
        sm: 'h-7 px-2.5 text-xs [&_svg]:size-3.5',
        md: 'h-9 px-3.5 text-sm [&_svg]:size-4',
        lg: 'h-11 px-5 text-md [&_svg]:size-5',
        icon: 'size-9 [&_svg]:size-4',
      },
    },
    defaultVariants: { variant: 'secondary', size: 'md' },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  /**
   * Render the child element instead of a `<button>`, keeping the classes.
   * The escape hatch for a link that looks like a button — which must stay an
   * `<a>`, because a `<button>` that navigates is not reachable the way a link
   * is and does not open in a new tab.
   */
  readonly asChild?: boolean;
  readonly ref?: Ref<HTMLButtonElement>;
}

export function Button({
  className,
  variant,
  size,
  asChild = false,
  type,
  ...props
}: ButtonProps): JSX.Element {
  const Component = asChild ? Slot : 'button';

  return (
    <Component
      // A `<button>` inside a form defaults to `submit`. That default has
      // submitted more forms by accident than it has on purpose.
      {...(asChild ? {} : { type: type ?? 'button' })}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  );
}
