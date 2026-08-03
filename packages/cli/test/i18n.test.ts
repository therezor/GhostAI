import { GhostError } from '@ghostai/core';
import { describe, expect, it } from 'vitest';

import { describeError, resolveCliLocale, translations, translationsFor } from '#src/i18n.js';

describe('resolveCliLocale', () => {
  it('lets GHOSTAI_LANG override the shell', () => {
    // The override exists for a script that wants one language regardless of
    // the machine it lands on.
    expect(resolveCliLocale({ GHOSTAI_LANG: 'en', LANG: 'de_DE.UTF-8' })).toBe('en');
  });

  it('prefers the configured locale over the shell', () => {
    expect(resolveCliLocale({ LANG: 'de_DE.UTF-8' }, 'en')).toBe('en');
  });

  it('reads the POSIX chain in the order POSIX defines', () => {
    // `LC_ALL` outranks `LC_MESSAGES`, which outranks `LANG`.
    expect(resolveCliLocale({ LC_ALL: 'en_GB.UTF-8', LANG: 'zz' })).toBe('en');
    expect(resolveCliLocale({ LC_MESSAGES: 'en_US.UTF-8', LANG: 'zz' })).toBe('en');
  });

  it('reads `LANG=C` as no localisation rather than as a language', () => {
    expect(resolveCliLocale({ LANG: 'C' })).toBe('en');
    expect(resolveCliLocale({ LANG: 'C.UTF-8' })).toBe('en');
  });

  it('falls back rather than failing on an empty or unknown environment', () => {
    expect(resolveCliLocale({})).toBe('en');
    expect(resolveCliLocale({ LANG: 'ja_JP.UTF-8' })).toBe('en');
  });
});

describe('translations', () => {
  it('scopes `t` to the terminal bundle', () => {
    const { t } = translations('en');

    expect(t('program.description')).toBe('A self-hosted agent that runs where your files are.');
  });

  it('scopes `ts` to the shared bundle the errors name', () => {
    const { ts } = translations('en');

    expect(ts('server.internal')).toBe('Internal server error');
  });

  it('interpolates without escaping, because a terminal has no entities', () => {
    const { t } = translations('en');

    expect(t('program.notAPort', { value: 'a & b' })).toBe('"a & b" is not a port number');
  });

  it('resolves from the environment', () => {
    expect(translationsFor({ LANG: 'en_GB.UTF-8' }).locale).toBe('en');
  });
});

describe('describeError', () => {
  const lang = translations('en');

  it('translates an error that carries a key', () => {
    const error = new GhostError('config', 'the English original', {
      messageKey: 'shared:runtime.noModel',
      messageParams: { provider: 'Ollama', configFile: '/etc/ghost/config.json' },
    });

    expect(describeError(error, lang)).toContain('No model configured for Ollama.');
    expect(describeError(error, lang)).toContain('/etc/ghost/config.json');
  });

  it('falls back to the English message when nobody has keyed it yet', () => {
    // Most errors are not keyed, and the untranslated path has to stay the
    // useful one rather than degrading to a key on screen.
    const error = new GhostError('internal', 'something specific went wrong');

    expect(describeError(error, lang)).toBe('something specific went wrong');
  });

  it('survives a throw that was never an Error', () => {
    expect(describeError('a bare string', lang)).toBe('a bare string');
    expect(describeError(undefined, lang)).toBe('undefined');
  });
});
