/**
 * Class composition.
 *
 * `clsx` resolves the conditionals; `tailwind-merge` resolves the conflicts.
 * The second is the one that matters for a recipe layer: a caller passing
 * `className="px-6"` to a button whose recipe already says `px-3` would
 * otherwise get both, and which one wins would depend on the order Tailwind
 * happened to emit them in. With `twMerge`, the caller's class wins — which is
 * the only rule that makes `className` a usable escape hatch on every
 * component.
 */

import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

/**
 * `twMerge` knows Tailwind's own scales, not ours. Without this it treats
 * `text-fg-2` and `text-sm` as the same group — one is a colour and one is a
 * size — and drops whichever came first.
 */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      'font-size': [{ text: ['2xs', 'xs', 'sm', 'base', 'md', 'lg', 'xl', '2xl'] }],
    },
  },
});

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
