/**
 * The terminal's translation layer.
 *
 * **This is the one `@ghostai/*` import `program.ts` makes at module scope**,
 * and the exception is deliberate rather than an oversight — see the rule at
 * the top of that file. Two things make it affordable: `@ghostai/i18n/cli` is a
 * leaf with one dependency and no side effects, and it carries the `cli` and
 * `shared` bundles only, not the browser's. `program.test.ts` measures what
 * `--help` costs so the exception stays a measured one.
 *
 * Where the locale comes from, in order:
 *
 *  1. `GHOSTAI_LANG` — the override, for a script that wants one language
 *     regardless of the shell it runs in.
 *  2. `config.ui.locale` — the install's own answer, and the same value the web
 *     UI uses. Only available once a command has loaded the config, which is
 *     why it is passed in rather than read here.
 *  3. `LC_ALL`, `LC_MESSAGES`, `LANG`, `LANGUAGE` — the POSIX chain, in the
 *     order POSIX defines. These arrive as `de_DE.UTF-8`, which `normaliseLocale`
 *     turns back into a language tag.
 *
 * `ghost --help` and an argument-parse error resolve without step 2, because
 * both run before any config has been read — and making `--help` load the
 * config to find out what language to print in would cost every invocation the
 * start-up budget this file exists to protect. An install whose `config.json`
 * disagrees with its shell therefore gets help in the shell's language. That is
 * the one seam, and it is a better trade than a slow `--help`.
 */

import {
  resolveFirstLocale,
  type CliResources,
  type ResourceKeys,
  type SharedMessageKey,
} from '@ghostai/i18n';
import { createCliI18n } from '@ghostai/i18n/cli';
import type { i18n, TFunction } from 'i18next';

/** The environment variables that name a language, most specific first. */
const POSIX_LOCALE_VARS = ['LC_ALL', 'LC_MESSAGES', 'LANG', 'LANGUAGE'] as const;

export type Env = Readonly<Record<string, string | undefined>>;

/**
 * The locale this invocation should speak.
 *
 * `configured` is the value from `config.ui.locale` when a command has got far
 * enough to have one, and `undefined` before that.
 */
export function resolveCliLocale(env: Env, configured?: string): string {
  return resolveFirstLocale([
    env.GHOSTAI_LANG,
    configured,
    ...POSIX_LOCALE_VARS.map((name) => env[name]),
  ]);
}

/** A `t` scoped to the terminal's bundle. */
export type CliT = TFunction<'cli'>;

/**
 * A key in that bundle, for the places that hold keys as *data* rather than
 * writing them at a call site — the `/help` listing is a table of them.
 */
export type CliKey = ResourceKeys<CliResources>;

/** The two scoped `t`s a command needs, bound to one instance. */
export interface Translations {
  /** Keys in the `cli` bundle, unprefixed. */
  readonly t: CliT;
  /** Keys in the `shared` bundle — the ones `GhostError` names. */
  readonly ts: TFunction<'shared'>;
  readonly locale: string;
  readonly i18n: i18n;
}

export function translations(locale: string): Translations {
  const instance = createCliI18n(locale);
  return {
    t: instance.getFixedT(null, 'cli'),
    ts: instance.getFixedT(null, 'shared'),
    locale,
    i18n: instance,
  };
}

/** `translations` for whatever the environment says, which is what `program.ts` wants. */
export function translationsFor(env: Env, configured?: string): Translations {
  return translations(resolveCliLocale(env, configured));
}

/**
 * The English form of a `GhostError`, or its translation when it has one.
 *
 * Errors carry both: `message` is the original and stays authoritative for logs
 * and pipes, `messageKey` is the same sentence for a terminal that has a locale.
 * Everything that prints an error to a person goes through here, and everything
 * that writes one to a log does not.
 */
export function describeError(error: unknown, { i18n }: Translations): string {
  if (!isKeyed(error)) return error instanceof Error ? error.message : String(error);
  // The unscoped `t`, not the shared-scoped one: the key arrives fully
  // qualified (`shared:runtime.noProvider`) because that is what a package with
  // no namespace of its own can name unambiguously.
  return i18n.t(error.messageKey, error.messageParams ?? {});
}

interface KeyedError {
  readonly messageKey: SharedMessageKey;
  readonly messageParams?: Readonly<Record<string, string | number>>;
}

/**
 * Structural rather than `instanceof GhostError`, for the reason `isGhostError`
 * gives: a plugin resolving its own copy of `@ghostai/core` produces a different
 * class identity. Checking for the field is also what keeps this file free of a
 * runtime import of core.
 */
function isKeyed(value: unknown): value is KeyedError {
  return (
    value instanceof Error && typeof (value as { messageKey?: unknown }).messageKey === 'string'
  );
}
