/**
 * The three-state theme toggle.
 *
 * Three, not two, because `system` is a real preference: a user who never
 * touched it follows their OS at sunset, and a two-state toggle silently makes
 * that choice for them the first time they click. `useTheme` owns the rule and
 * the persistence; this is only its control surface.
 *
 * A radio group rather than a cycling button — a button that cycles through
 * three states does not say what the next press will do, and a screen reader
 * announces it as a button whose label just changed for no stated reason.
 */

import { Monitor, Moon, Sun } from 'lucide-react';
import type { JSX } from 'react';

import { useAppTheme } from '@/theme/theme-context.js';
import type { ThemePreference } from '@/theme/theme.js';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from './ui/dropdown-menu.js';
import { Button } from './ui/button.js';
import { isThemePreference } from '@/theme/theme.js';

const OPTIONS: readonly { readonly value: ThemePreference; readonly label: string }[] = [
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' },
  { value: 'system', label: 'System' },
];

const ICONS = { dark: Moon, light: Sun, system: Monitor } as const;

export function ThemeToggle({ className }: { readonly className?: string }): JSX.Element {
  const { preference, resolved, setPreference } = useAppTheme();
  const Icon = ICONS[preference];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className={className}
          // The resolution is in the label because it is the thing the icon
          // cannot show: `system` with a moon looks identical to `dark`.
          aria-label={`Theme: ${preference} (currently ${resolved})`}
        >
          <Icon />
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end">
        <DropdownMenuRadioGroup
          value={preference}
          onValueChange={(value) => {
            if (isThemePreference(value)) setPreference(value);
          }}
        >
          {OPTIONS.map((option) => {
            const OptionIcon = ICONS[option.value];
            return (
              <DropdownMenuRadioItem key={option.value} value={option.value}>
                <OptionIcon />
                {option.label}
              </DropdownMenuRadioItem>
            );
          })}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
