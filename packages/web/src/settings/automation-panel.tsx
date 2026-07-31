/**
 * Settings → Automation: the scheduler engine, and only the engine.
 *
 * The **jobs** are not here. They are a page of their own in the nav, because a
 * list an operator keeps is not a setting — the same split Agents already makes,
 * where the agents are a page and only install-wide tool settings are in
 * Settings.
 *
 * What is here is the five knobs that are true of the scheduler and of no
 * particular job: whether it runs at all, how many runs at once, what a job
 * whose time passed while the process was down should do, how much history to
 * keep per job, and the zone a cron with no zone of its own is read in.
 *
 * There is deliberately no heartbeat block. A heartbeat *is* a job — its
 * interval is the job's schedule, its task file and decision model are the
 * job's payload — so it is configured on the job, not twice.
 */

import { useMemo, useState, type JSX } from 'react';
import { useTranslation } from 'react-i18next';

import type { Config } from '@ghostai/protocol';

import { timezoneOptions } from '@/automation/job-form.js';

import { FieldGrid, SaveBar, Section, SelectField, SwitchRow, TextField } from './controls.js';
import { parseNumber, type PatchResult } from './fields.js';
import { useSaveSettings } from './use-settings.js';

export function AutomationPanel({ config }: { readonly config: Config }): JSX.Element {
  const { t } = useTranslation();
  const { save, saving } = useSaveSettings();
  const [enabled, setEnabled] = useState(config.scheduler.enabled);
  const [catchUp, setCatchUp] = useState(config.scheduler.catchUpOnBoot);
  const [timezone, setTimezone] = useState(config.scheduler.timezone);
  const [concurrency, setConcurrency] = useState(String(config.scheduler.concurrency));
  const [retention, setRetention] = useState(String(config.scheduler.runRetention));
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  const [dirty, setDirty] = useState(false);

  // Built once: the IANA list is several hundred entries and does not change
  // while the panel is open.
  const tzOptions = useMemo(
    () => timezoneOptions().map((zone) => ({ value: zone, label: zone })),
    [],
  );

  const build = (): PatchResult => {
    const parsedConcurrency = parseNumber(concurrency, t, { min: 1, integer: true });
    const parsedRetention = parseNumber(retention, t, { min: 1, integer: true });
    const next: Record<string, string> = {};
    if (!parsedConcurrency.ok) next.concurrency = parsedConcurrency.error;
    if (!parsedRetention.ok) next.retention = parsedRetention.error;
    if (!parsedConcurrency.ok || !parsedRetention.ok) return { ok: false, errors: next };

    return {
      ok: true,
      patch: {
        scheduler: {
          enabled,
          catchUpOnBoot: catchUp,
          timezone,
          concurrency: parsedConcurrency.value,
          runRetention: parsedRetention.value,
        },
      },
    };
  };

  return (
    <Section title={t('automation.engineTitle')} description={t('automation.engineDesc')}>
      <SwitchRow
        label={t('automation.engineEnabled')}
        hint={t('automation.engineEnabledHint')}
        checked={enabled}
        onCheckedChange={(value) => {
          setEnabled(value);
          setDirty(true);
        }}
      />
      <SwitchRow
        label={t('automation.catchUp')}
        hint={t('automation.catchUpHint')}
        checked={catchUp}
        onCheckedChange={(value) => {
          setCatchUp(value);
          setDirty(true);
        }}
      />
      <FieldGrid>
        <SelectField
          label={t('automation.timezone')}
          hint={t('automation.timezoneHint')}
          value={timezone}
          options={tzOptions}
          onValueChange={(value) => {
            setTimezone(value);
            setDirty(true);
          }}
        />
        <TextField
          label={t('automation.concurrency')}
          hint={t('automation.concurrencyHint')}
          value={concurrency}
          error={errors.concurrency}
          inputMode="numeric"
          onValueChange={(value) => {
            setConcurrency(value);
            setDirty(true);
          }}
        />
        <TextField
          label={t('automation.retention')}
          hint={t('automation.retentionHint')}
          value={retention}
          error={errors.retention}
          inputMode="numeric"
          onValueChange={(value) => {
            setRetention(value);
            setDirty(true);
          }}
        />
      </FieldGrid>
      <SaveBar
        dirty={dirty}
        saving={saving}
        onRevert={() => {
          setEnabled(config.scheduler.enabled);
          setCatchUp(config.scheduler.catchUpOnBoot);
          setTimezone(config.scheduler.timezone);
          setConcurrency(String(config.scheduler.concurrency));
          setRetention(String(config.scheduler.runRetention));
          setErrors({});
          setDirty(false);
        }}
        onSave={() => {
          const result = build();
          if (!result.ok) {
            setErrors(result.errors);
            return;
          }
          setErrors({});
          save(result.patch);
          setDirty(false);
        }}
      />
    </Section>
  );
}
