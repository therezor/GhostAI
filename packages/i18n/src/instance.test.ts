import { describe, expect, it } from 'vitest';

import { createI18n } from './instance.js';
import { createCliI18n } from './cli.js';
import { createWebI18n } from './web.js';

const RESOURCES = {
  en: {
    web: {
      greeting: 'Hello {{name}}',
      files_one: '{{count}} file',
      files_other: '{{count}} files',
      blank: '',
      settings: { title: 'Settings' },
    },
    shared: { boom: 'It broke' },
  },
  de: {
    web: { greeting: 'Hallo {{name}}' },
    shared: {},
  },
};

/**
 * The fixture bundle above is deliberately *not* the product's, so its keys are
 * not in the `CustomTypeOptions` union and `t` has to be addressed untyped here.
 * That is the augmentation working rather than a hole in it — the tests further
 * down use the real bundles and stay fully checked.
 */
type LooseT = (key: string, options?: Record<string, unknown>) => string;

function build(locale = 'en', strict = false): LooseT {
  const instance = createI18n({ locale, resources: RESOURCES, defaultNS: 'web', strict });
  return instance.t as unknown as LooseT;
}

describe('the instance', () => {
  it('translates on the line after init, without awaiting anything', () => {
    // `initAsync: false` is what buys this. Left on, i18next loads inside a
    // setTimeout and this returns the key — and `ghost --help` has no await to
    // hang on before printing.
    const t = build();

    expect(t('settings.title')).toBe('Settings');
  });

  it('interpolates without HTML-escaping the value', () => {
    // The default escapes, which would render a workspace called `Tom & Jerry`
    // as `Tom &amp; Jerry` — wrong in React, which escapes again, and simply
    // wrong in a terminal.
    const t = build();

    expect(t('greeting', { name: 'Tom & Jerry' })).toBe('Hello Tom & Jerry');
  });

  it('pluralises through Intl.PluralRules', () => {
    const t = build();

    expect(t('files', { count: 1 })).toBe('1 file');
    expect(t('files', { count: 4 })).toBe('4 files');
    expect(t('files', { count: 0 })).toBe('0 files');
  });

  it('addresses another namespace by prefix', () => {
    const t = build();

    expect(t('shared:boom')).toBe('It broke');
  });

  it('falls back to English for a key the locale has not translated', () => {
    const t = build('de');

    expect(t('greeting', { name: 'Ada' })).toBe('Hallo Ada');
    // Only in the English bundle — this is the half-translated case.
    expect(t('settings.title')).toBe('Settings');
  });

  it('falls back for a key that is present but empty', () => {
    // A blank translation is one nobody has finished, and an empty label reads
    // as a broken UI rather than an untranslated one.
    const t = build('en');

    expect(t('blank')).not.toBe('');
  });
});

describe('strict mode', () => {
  it('throws on a missing key, so a typo fails the suite', () => {
    const t = build('en', true);

    expect(() => t('nope.not.a.key')).toThrow(/Missing translation: web:nope\.not\.a\.key/u);
  });

  it('returns the key instead of throwing when it is off', () => {
    // Production behaviour: a missing string is not worth a white screen.
    const t = build('en', false);

    expect(t('nope.not.a.key')).toBe('nope.not.a.key');
  });
});

describe('the per-surface instances', () => {
  it('give the browser its own bundle and the shared one', () => {
    const i18n = createWebI18n('en', false);

    expect(i18n.t('settings.title')).toBe('Settings');
    expect(i18n.t('shared:server.internal')).toBe('Internal server error');
  });

  it('give the terminal its own bundle and the shared one', () => {
    // Addressed as `cli:` rather than bare: the type-level `defaultNS` is `web`,
    // so a CLI file that reaches for the unscoped `t` fails to compile. That is
    // deliberate — see the note in `types.ts`.
    const i18n = createCliI18n('en', false);

    expect(i18n.t('cli:program.description')).toBe(
      'A self-hosted agent that runs where your files are.',
    );
    expect(i18n.t('shared:server.internal')).toBe('Internal server error');
  });

  it('keep the surfaces apart, so neither ships the other’s strings', () => {
    // Not tidiness: `program.ts` parses the CLI bundle on every `ghost --help`.
    const web = createWebI18n('en', false);
    const cli = createCliI18n('en', false);

    expect(web.hasResourceBundle('en', 'cli')).toBe(false);
    expect(cli.hasResourceBundle('en', 'web')).toBe(false);
  });
});
