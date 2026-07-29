/**
 * A column heading that is also the control that sorts by it.
 *
 * `aria-sort` on the `<th>` and a real `<button>` inside it, rather than a
 * click handler on the cell: the sort state has to be announced, and a heading
 * that sorts on click but not on `Enter` is a control a keyboard cannot reach.
 *
 * It lived inside `routes/files.tsx` while Files was the only sortable list.
 * Three screens now sort, and a re-typed copy of an `aria-sort` mapping is
 * exactly the kind of thing that ends up correct on two screens and absent on
 * the third.
 */

import { ArrowDown, ArrowUp } from 'lucide-react';
import type { JSX } from 'react';

import type { SortOrder } from './sort.js';

export function SortHeader<K extends string>({
  label,
  sortKey,
  sort,
  onSort,
  className,
}: {
  readonly label: string;
  readonly sortKey: K;
  readonly sort: SortOrder<K>;
  readonly onSort: (key: K) => void;
  readonly className?: string;
}): JSX.Element {
  const active = sort.key === sortKey;

  return (
    <th
      scope="col"
      className={className}
      aria-sort={active ? (sort.descending ? 'descending' : 'ascending') : 'none'}
    >
      <button
        type="button"
        className="data-table__sort"
        onClick={() => {
          onSort(sortKey);
        }}
      >
        {label}
        {active && (sort.descending ? <ArrowDown /> : <ArrowUp />)}
      </button>
    </th>
  );
}
