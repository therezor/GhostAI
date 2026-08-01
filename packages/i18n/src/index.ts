/**
 * The shared half of the translation layer.
 *
 * Everything here is safe in a browser, in Node and in a package that has no
 * opinion about either: locale negotiation, the `Intl` primitives, the instance
 * factory, and the key type that lets a package name a string without depending
 * on i18next to resolve it.
 *
 * The per-surface entry points are `@ghostai/i18n/web` and `@ghostai/i18n/cli`.
 * They exist so the CLI parses one bundle instead of three on every `--help`,
 * and so the browser never ships the terminal's strings.
 */

// Side-effect import: the `CustomTypeOptions` augmentation that types `t()`.
// Everything downstream inherits it by importing this package at all.
import './types.js';

export {
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  isRtl,
  matchLocale,
  normaliseLocale,
  resolveFirstLocale,
  resolveLocale,
  type Locale,
} from './locale.js';

export {
  durationParts,
  formatCompactNumber,
  formatDate,
  formatDateTime,
  formatNumber,
  formatRelativeSpan,
  pluralCategory,
  relativeSpan,
  type DurationParts,
  type RelativeSpan,
} from './format.js';

export { instantFromZonedInput, isValidTimeZone, zonedInputValue } from './zoned-time.js';

export { createI18n, type CreateI18nOptions, type Namespace } from './instance.js';

export {
  EN,
  RESOURCES,
  type CliResources,
  type SharedResources,
  type WebResources,
} from './resources.js';

export type { ResourceKeys } from './keys.js';

import type { ResourceKeys } from './keys.js';
import type { SharedResources } from './resources.js';

/**
 * A key in the `shared` namespace, fully qualified.
 *
 * `GhostError.messageKey` is typed as this, which is what stops a `throw` in
 * `@ghostai/runtime` from naming a string that only exists in the UI bundle —
 * or one that does not exist at all.
 */
export type SharedMessageKey = `shared:${ResourceKeys<SharedResources>}`;
