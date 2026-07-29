/**
 * The filter beside a list.
 *
 * One component rather than the four lines of markup it replaces, for the same
 * reason `data-table.css` is one stylesheet: every CRUD screen needs it, and a
 * copy per screen is how one of them ends up without the icon, or with a
 * `type="text"` that loses the browser's clear button.
 *
 * `type="search"` is the load-bearing part. It gives the control a clear
 * affordance and an Escape binding for free, both of which a plain text input
 * has to reimplement badly.
 */

import { Search } from 'lucide-react';
import type { JSX } from 'react';

import { Input } from '@/components/ui/field.js';

export function SearchFilter({
  value,
  onValueChange,
  label,
  placeholder = 'Filter',
}: {
  readonly value: string;
  readonly onValueChange: (value: string) => void;
  /** Names the control for a screen reader; there is no visible label. */
  readonly label: string;
  readonly placeholder?: string;
}): JSX.Element {
  return (
    <div className="row list-filter">
      <Search />
      <Input
        type="search"
        value={value}
        aria-label={label}
        placeholder={placeholder}
        onChange={(event) => {
          onValueChange(event.target.value);
        }}
      />
    </div>
  );
}
