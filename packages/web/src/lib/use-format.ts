/**
 * The locale-bound formatters, resolved once per component.
 *
 * `formatTokens` and `formatRelativeTime` both need the install's locale, and
 * one of them also needs `t`. Threading two arguments through every call site
 * would put the same two lookups at the top of a dozen components and make the
 * call itself read as plumbing rather than as formatting.
 *
 * This is deliberately *not* the pattern for copy. Components call
 * `useTranslation()` and `t('…')` directly, because a bespoke wrapper around `t`
 * hides the keys from `i18next-parser` — which extracts by scanning for `t()`
 * calls, and cannot see through an indirection. Formatting has no keys to
 * extract, so binding it costs nothing the tooling needs.
 *
 * The object is memoised on the two things it closes over, so a component that
 * puts it in a dependency array does not re-run on every render.
 */

import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { useAppLocale } from '@/i18n/i18n-context.js';

import { formatDate, formatRelativeTime, formatTokens } from './format.js';

export interface Formatters {
  /** A token count with the locale's grouping separator. */
  readonly tokens: (value: number) => string;
  /** `just now`, `5m ago`, or a date once counting back stops working. */
  readonly relativeTime: (atMs: number, now: number) => string;
  readonly date: (atMs: number) => string;
}

export function useFormat(): Formatters {
  const { t } = useTranslation();
  const { resolved } = useAppLocale();

  return useMemo(
    () => ({
      tokens: (value: number) => formatTokens(value, resolved),
      relativeTime: (atMs: number, now: number) => formatRelativeTime(atMs, now, resolved, t),
      date: (atMs: number) => formatDate(atMs, resolved),
    }),
    [resolved, t],
  );
}
