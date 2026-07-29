/**
 * Extraction: every `t()` call in the source, back into the English bundles.
 *
 * This is one of two gates and it catches only one direction. The parser finds
 * keys that are *used*; it cannot find copy that was never wrapped in `t()` at
 * all — a hardcoded string is invisible to it, because there is nothing to
 * parse. The source sweep in `packages/web/src/i18n/untranslated.test.ts` is the
 * other direction, and neither substitutes for the other.
 *
 * What it is really for is translators. `pnpm i18n:extract` regenerates the
 * files a TMS ingests, and `pnpm i18n:check` fails when the committed bundles
 * are stale — the same shape as `format:check`, and the reason i18next was
 * chosen over a hand-rolled catalogue.
 *
 * **One config per surface, because the namespace cannot be inferred.** The CLI
 * addresses its bundle through `getFixedT(null, 'cli')`, which is a runtime
 * binding a static parser cannot see: pointed at both trees at once it files
 * every CLI key under `web`. So `defaultNS` is set per invocation and each run
 * is given only its own sources.
 *
 * `keepRemoved` is on. A key the parser cannot see is not necessarily dead: the
 * tables in `settings/panels.ts` and `chat/notice.tsx` hold keys as *data* and
 * resolve them through a variable, which no static pass can follow. Off, every
 * extraction run would delete them and the next would restore only what a
 * literal call site named.
 */

export function config(defaultNamespace) {
  return {
    locales: ['en'],
    defaultNamespace,
    namespaceSeparator: ':',
    keySeparator: '.',

    // Written where the runtime reads them from, so an extraction run and a
    // `git diff` are the same question.
    output: 'packages/i18n/locales/$LOCALE/$NAMESPACE.json',

    // An untranslated key is written empty rather than as its own name.
    // `returnEmptyString: false` in `createI18n` makes that fall back to
    // English, and a key written as its own text would defeat the
    // `t(key) !== key` assertion several tests use to prove an entry exists.
    defaultValue: '',
    keepRemoved: true,
    sort: true,

    // Matches `createI18n`. The parser writes plural suffixes from this, so a
    // disagreement here produces keys the runtime never looks up.
    pluralSeparator: '_',
    contextSeparator: '_',

    failOnWarnings: false,
    verbose: false,
  };
}
