/**
 * The terminal's instance: `cli`, and nothing the browser renders.
 *
 * The split is not tidiness. `packages/cli/src/program.ts` imports this at
 * module scope on every invocation — including `ghost --help`, which is
 * expected to be near-instant — so what it parses is one bundle rather than
 * three.
 */

import type { i18n } from 'i18next';

import { createI18n } from './instance.js';
import { DEFAULT_LOCALE, type Locale } from './locale.js';
import { EN } from './resources.js';

/** Bundles a terminal needs, in the shape i18next wants them. */
const CLI_RESOURCES = {
  en: { cli: EN.cli },
} as const;

export function createCliI18n(
  locale: Locale = DEFAULT_LOCALE,
  strict?: boolean,
): i18n {
  return createI18n({
    locale,
    resources: CLI_RESOURCES,
    defaultNS: 'cli',
    ...(strict === undefined ? {} : { strict }),
  });
}
