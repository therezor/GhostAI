/**
 * The shared half of the translation layer.
 *
 * Everything here is safe in a browser, in Node and in a package that has no
 * opinion about either: locale negotiation, the `Intl` primitives, the instance
 * factory, and the key type that lets a package name a string without depending
 * on i18next to resolve it.
 *
 * The per-surface entry points are `@ghostbot/i18n/web` and `@ghostbot/i18n/cli`.
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
  type RelativeSpan,
} from './format.js';

export {
  instantFromZonedInput,
  isValidTimeZone,
  zonedInputValue,
} from './zoned-time.js';

export { createI18n, type Namespace } from './instance.js';

export { EN, type CliResources, type WebResources } from './resources.js';

export type { ResourceKeys } from './keys.js';
