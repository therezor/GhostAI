/**
 * Slug id rules, re-exported.
 *
 * The rules themselves live in `@ghostbot/protocol` because the browser mints
 * agent ids and the server resolves them to paths — see that module's header.
 * This file keeps the import path every consumer of `@ghostbot/core` already
 * uses.
 */

export {
  MAX_SLUG_ID_LENGTH,
  RESERVED_DEVICE_NAMES,
  SLUG_ID_PATTERN,
  isSlugId,
  slugify,
} from '@ghostbot/protocol';
