/**
 * The Tools panel, and the approval matrix at the centre of it.
 *
 * The matrix is four rows because risk is declared per *tool* and policy is set
 * per *band* — that split is what makes the gate a property of the deployment
 * rather than of the calling code, and it is also what makes the matrix hard to
 * read in isolation: `exec: ask` says nothing about which tools it governs.
 *
 * So the registered tool list underneath is not decoration. It reads its
 * effective policy from the form's live state rather than from the saved
 * config, so moving `network` to `deny` immediately shows which tools that turns
 * off — before the save, which is the moment the answer is useful.
 *
 * `deny` is offered for every band including `safe`. It is a legitimate
 * deployment: an agent with no filesystem reads at all is a chat window, and
 * some operators want exactly that.
 */

import { useQuery } from '@tanstack/react-query';
import { useState, type JSX } from 'react';
import { useTranslation } from 'react-i18next';
import type { WebKey } from '@/i18n/keys.js';

import type { Config, ToolApprovalPolicy, ToolRisk } from '@ghostai/protocol';

import { api } from '@/lib/api.js';
import { queryKeys } from '@/lib/query.js';
import { Badge, type BadgeProps } from '@/components/ui/badge.js';
import { FieldGrid, SaveBar, Section, SelectField, SwitchRow, TextField } from './controls.js';
import { policyFor } from './fields.js';
import {
  APPROVAL_POLICIES,
  RISK_BANDS,
  toToolsForm,
  toToolsPatch,
  type ToolsForm,
} from './tools-form.js';
import { useSaveSettings } from './use-settings.js';

const RISK_COPY: Readonly<Record<ToolRisk, { readonly label: string; readonly detail: string }>> = {
  safe: { label: 'Read', detail: 'Listing and reading files inside the workspace.' },
  write: { label: 'Write', detail: 'Creating and editing files inside the workspace.' },
  exec: { label: 'Execute', detail: 'Running a command on this machine, as you.' },
  network: { label: 'Network', detail: 'Fetching a URL or searching the web.' },
};

const POLICY_TONE: Readonly<Record<ToolApprovalPolicy, BadgeProps['tone']>> = {
  allow: 'neutral',
  ask: 'warning',
  deny: 'danger',
};

export function ToolsPanel({ config }: { readonly config: Config }): JSX.Element {
  const { t } = useTranslation();
  const [form, setForm] = useState<ToolsForm>(() => toToolsForm(config.tools));
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  const [dirty, setDirty] = useState(false);
  const { save, saving } = useSaveSettings();

  const tools = useQuery({
    queryKey: queryKeys.tools,
    queryFn: ({ signal }) => api.tools(signal),
  });

  const update = <K extends keyof ToolsForm>(key: K, value: ToolsForm[K]): void => {
    setForm((current) => ({ ...current, [key]: value }));
    setDirty(true);
  };

  const setPolicy = (risk: ToolRisk, policy: ToolApprovalPolicy): void => {
    setForm((current) => ({ ...current, approvals: { ...current.approvals, [risk]: policy } }));
    setDirty(true);
  };

  const onSave = (): void => {
    const result = toToolsPatch(form, t);
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    setErrors({});
    save(result.patch);
    setDirty(false);
  };

  return (
    <div className="stack settings-panel">
      <Section
        title={t('settings.tools.approvalTitle')}
        description={t('settings.tools.approvalDesc')}
      >
        <table className="approval-matrix">
          <thead>
            <tr>
              <th scope="col">{t('settings.tools.risk')}</th>
              <th scope="col">{t('settings.tools.policy')}</th>
            </tr>
          </thead>
          <tbody>
            {RISK_BANDS.map((risk) => (
              <tr key={risk}>
                <th scope="row">
                  <span className="approval-matrix__band">{RISK_COPY[risk].label}</span>
                  <span className="approval-matrix__detail">{RISK_COPY[risk].detail}</span>
                </th>
                <td className="approval-matrix__policy">
                  <SelectField
                    label={<span className="sr-only">{RISK_COPY[risk].label} policy</span>}
                    value={form.approvals[risk]}
                    options={APPROVAL_POLICIES.map((policy) => ({
                      value: policy,
                      label: t(POLICY_LABELS[policy]),
                    }))}
                    onValueChange={(value) => {
                      setPolicy(risk, value as ToolApprovalPolicy);
                    }}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <TextField
          label={t('settings.tools.approvalTimeout')}
          inputMode="decimal"
          value={form.approvalTimeoutSeconds}
          error={errors.approvalTimeoutSeconds}
          onValueChange={(value) => {
            update('approvalTimeoutSeconds', value);
          }}
          hint="An unanswered prompt is denied after this. Unlike the other durations here, 0 is not allowed — an approval that never expires holds the turn open forever."
        />
      </Section>

      <Section
        title={t('settings.tools.executionTitle')}
        description={t('settings.tools.executionDesc')}
      >
        <SwitchRow
          label={t('settings.tools.enableExec')}
          hint="Switching this off removes it from the definitions the model is offered, rather than refusing it after the fact."
          checked={form.execEnabled}
          onCheckedChange={(checked) => {
            update('execEnabled', checked);
          }}
        />
        <FieldGrid>
          <TextField
            label={t('settings.tools.commandTimeout')}
            inputMode="decimal"
            value={form.execTimeoutSeconds}
            error={errors.execTimeoutSeconds}
            disabled={!form.execEnabled}
            onValueChange={(value) => {
              update('execTimeoutSeconds', value);
            }}
            hint="0 for no timeout."
          />
          <TextField
            label={t('settings.tools.maxOutputBytes')}
            inputMode="numeric"
            value={form.execMaxOutputBytes}
            error={errors.execMaxOutputBytes}
            disabled={!form.execEnabled}
            onValueChange={(value) => {
              update('execMaxOutputBytes', value);
            }}
          />
        </FieldGrid>
      </Section>

      <Section
        title={t('settings.tools.resultsTitle')}
        description={t('settings.tools.resultsDesc')}
      >
        <SwitchRow
          label={t('settings.tools.restrictFiles')}
          hint="The jail. Switching this off lets the agent read and write anywhere this process can."
          checked={form.restrictToWorkspace}
          onCheckedChange={(checked) => {
            update('restrictToWorkspace', checked);
          }}
        />
        <TextField
          label={t('settings.tools.maxChars')}
          inputMode="numeric"
          value={form.maxOutputChars}
          error={errors.maxOutputChars}
          onValueChange={(value) => {
            update('maxOutputChars', value);
          }}
          hint="Longer results are truncated head and tail, keeping both ends."
        />
      </Section>

      <SaveBar
        dirty={dirty}
        saving={saving}
        onSave={onSave}
        onRevert={() => {
          setForm(toToolsForm(config.tools));
          setErrors({});
          setDirty(false);
        }}
      />

      <Section
        title={t('settings.tools.registeredTitle')}
        description={t('settings.tools.registeredDesc')}
      >
        {tools.isSuccess && tools.data.tools.length > 0 ? (
          <ul className="settings-divided-list">
            {tools.data.tools.map((tool) => {
              const policy = policyFor(tool.risk, form.approvals);
              return (
                <li key={tool.name}>
                  <div className="settings-divided-list__text">
                    <span className="settings-divided-list__name settings-divided-list__name--mono">
                      {tool.name}
                    </span>
                    <span className="settings-divided-list__detail truncate">
                      {tool.description}
                    </span>
                  </div>
                  <Badge tone="neutral">{tool.risk}</Badge>
                  <Badge tone={POLICY_TONE[policy]}>{t(POLICY_LABELS[policy])}</Badge>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="page__note">
            {tools.isPending ? 'Loading tools…' : 'No tools are registered.'}
          </p>
        )}
      </Section>
    </div>
  );
}

const POLICY_LABELS: Readonly<Record<ToolApprovalPolicy, WebKey>> = {
  allow: 'settings.tools.policies.allow',
  ask: 'settings.tools.policies.ask',
  deny: 'settings.tools.policies.deny',
};
