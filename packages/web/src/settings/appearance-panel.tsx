/**
 * Language and theme — the two preferences, and they are not the same kind.
 *
 * **The language is the install's**, stored in `config.ui.locale` and read by
 * `ghost chat` on the same server. **The theme is this browser's**, stored in
 * `localStorage` and never written to the config. Putting them on one screen is
 * right — they are both "what this looks and reads like" — but the difference is
 * why only half of this panel has a `SaveBar`: the theme applies on the click,
 * because there is nothing to persist anywhere else, and a save button over it
 * would imply a round trip that never happens.
 *
 * The language select writes through immediately as a *preference* too, so the
 * UI switches while the patch is in flight. `useAppLocale().adopt` reconciles it
 * when the settings query comes back, so a save the server refuses does not
 * leave the page in a language the config does not have.
 */

import { useState, type JSX } from 'react';
import { useTranslation } from 'react-i18next';

import { SUPPORTED_LOCALES } from '@ghostai/i18n';

import { useAppLocale } from '@/i18n/i18n-context.js';
import { SYSTEM } from '@/i18n/locale-preference.js';
import { isThemePreference } from '@/theme/theme.js';
import { useAppTheme } from '@/theme/theme-context.js';

import { FieldGrid, SaveBar, Section, SelectField, type SelectFieldOption } from './controls.js';
import { useSaveSettings } from './use-settings.js';

/**
 * The languages this build ships, named in their own language.
 *
 * `Intl.DisplayNames` with the tag as its own locale, so German reads `Deutsch`
 * in an English UI rather than `German` — a language picker is one of the few
 * places where *not* translating the label is the accessible choice, because the
 * person who needs it cannot read the surrounding page.
 */
function localeOptions(systemLabel: string): readonly SelectFieldOption[] {
  return [
    { value: SYSTEM, label: systemLabel },
    ...SUPPORTED_LOCALES.map((locale) => ({ value: locale, label: nameOf(locale) })),
  ];
}

function nameOf(locale: string): string {
  try {
    return new Intl.DisplayNames([locale], { type: 'language' }).of(locale) ?? locale;
  } catch {
    // A runtime without the data for this tag. The tag itself is a worse label
    // than its own name and a better one than nothing.
    return locale;
  }
}

export function AppearancePanel(): JSX.Element {
  const { t } = useTranslation();
  const locale = useAppLocale();
  const theme = useAppTheme();
  const { save, saving } = useSaveSettings();

  // The preference as the select shows it, which is not the same as what is
  // saved: `system` is a real choice here and resolves to a concrete tag before
  // it reaches the config, because `ui.locale` names a language and not a rule.
  const [pending, setPending] = useState<string>(locale.preference);
  const dirty = pending !== locale.preference;

  const onSave = (): void => {
    save({ ui: { locale: pending === SYSTEM ? locale.resolved : pending } });
  };

  return (
    <div className="stack">
      <Section
        title={t('settings.appearance.languageTitle')}
        description={t('settings.appearance.languageDesc')}
      >
        <FieldGrid>
          <SelectField
            label={t('settings.appearance.language')}
            hint={t('settings.appearance.languageHint')}
            value={pending}
            options={localeOptions(t('settings.appearance.system'))}
            onValueChange={(value) => {
              setPending(value);
              // Applied on the click rather than on the save, so the screen the
              // choice is made on is the first thing to answer in the new
              // language. The config still decides — `adopt` reconciles.
              locale.setPreference(value);
            }}
          />
        </FieldGrid>

        <SaveBar
          dirty={dirty}
          saving={saving}
          onSave={onSave}
          onRevert={() => {
            setPending(locale.preference);
            locale.setPreference(locale.preference);
          }}
        />
      </Section>

      <Section
        title={t('settings.appearance.themeTitle')}
        description={t('settings.appearance.themeDesc')}
      >
        <FieldGrid>
          <SelectField
            label={t('settings.appearance.theme')}
            value={theme.preference}
            options={[
              { value: 'system', label: t('settings.appearance.system') },
              { value: 'light', label: t('settings.appearance.light') },
              { value: 'dark', label: t('settings.appearance.dark') },
            ]}
            onValueChange={(value) => {
              // No save bar: this is `localStorage` and the DOM, both of which
              // are already written by the time the menu closes.
              if (isThemePreference(value)) theme.setPreference(value);
            }}
          />
        </FieldGrid>
      </Section>
    </div>
  );
}
