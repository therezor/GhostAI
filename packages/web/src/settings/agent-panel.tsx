/**
 * The Agent panel: what a turn runs on, and the budget it runs inside.
 *
 * The form initialises from the config once, on mount, and is not re-synced
 * from later fetches. That is deliberate rather than an omission: a refetch
 * landing while someone is typing a workspace path would overwrite the path
 * with the server's copy mid-word. The server is the authority on what is
 * *saved*; the operator is the authority on what is being typed.
 *
 * The model control changes shape with what is known. When the chosen provider
 * advertises models — from its config list or from whatever `GET /api/models`
 * can enumerate — it is a picker, because typing a model id from memory is how
 * a turn fails with a 404 twenty seconds later. When nothing is advertised it is
 * a text field, because a local server's model list is whatever the operator
 * pulled and no catalogue on this side knows it.
 */

import { useQuery } from '@tanstack/react-query';
import { useState, type JSX } from 'react';

import type { Config } from '@ghostai/protocol';

import { api } from '@/lib/api.js';
import { queryKeys } from '@/lib/query.js';
import { FieldGrid, SaveBar, Section, SelectField, SwitchRow, TextField } from './controls.js';
import { modelOptions } from './fields.js';
import { REASONING_EFFORTS, toAgentForm, toAgentPatch, type AgentForm } from './agent-form.js';
import { useSaveSettings } from './use-settings.js';

/**
 * The value the "unset" option carries.
 *
 * Not the empty string, which is what the form holds: an empty `value` means
 * *no* value to a Radix select, so the option would select nothing and the
 * trigger would render blank — a control that looks broken while working. The
 * sentinel is mapped back to `''` on the way in and out, in the two lines below.
 */
const UNSET_EFFORT = '__unset__';

export function AgentPanel({ config }: { readonly config: Config }): JSX.Element {
  const [form, setForm] = useState<AgentForm>(() => toAgentForm(config.agents.defaults));
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  const [dirty, setDirty] = useState(false);
  const { save, saving } = useSaveSettings();

  const providers = useQuery({
    queryKey: queryKeys.providers,
    queryFn: ({ signal }) => api.providers(signal),
  });
  const models = useQuery({
    queryKey: queryKeys.models,
    queryFn: ({ signal }) => api.models(signal),
  });

  const update = <K extends keyof AgentForm>(key: K, value: AgentForm[K]): void => {
    setForm((current) => ({ ...current, [key]: value }));
    setDirty(true);
  };

  const onSave = (): void => {
    const result = toAgentPatch(form);
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    setErrors({});
    save(result.patch);
    setDirty(false);
  };

  const onRevert = (): void => {
    setForm(toAgentForm(config.agents.defaults));
    setErrors({});
    setDirty(false);
  };

  const providerOptions = [
    { value: 'auto', label: 'Automatic — whichever has a credential' },
    ...(providers.data?.providers ?? []).map((provider) => ({
      value: provider.id,
      label: provider.credentialsPresent ? `${provider.displayName} ✓` : provider.displayName,
    })),
  ];

  const available = modelOptions(models.data?.models ?? [], form.provider, form.model);

  return (
    <div className="flex flex-col gap-4">
      <Section
        title="Model"
        description="Applies to the next turn. A turn already running keeps the provider it started on."
      >
        <FieldGrid>
          <SelectField
            label="Provider"
            value={form.provider}
            options={providerOptions}
            onValueChange={(value) => {
              update('provider', value);
            }}
            hint="A tick marks a provider with a key in the vault."
          />

          {available.length > 0 ? (
            <SelectField
              label="Model"
              value={form.model}
              placeholder="Resolved automatically"
              options={available.map((id) => ({ value: id, label: id }))}
              onValueChange={(value) => {
                update('model', value);
              }}
              hint="From this provider's configured list."
            />
          ) : (
            <TextField
              label="Model"
              value={form.model}
              placeholder="Resolved automatically"
              onValueChange={(value) => {
                update('model', value);
              }}
              hint="No models are listed for this provider. Add some under Providers, or type one."
            />
          )}
        </FieldGrid>

        <SelectField
          label="Reasoning effort"
          value={form.reasoningEffort === '' ? UNSET_EFFORT : form.reasoningEffort}
          options={[
            ...(form.reasoningEffort === ''
              ? [{ value: UNSET_EFFORT, label: "The provider's default" }]
              : []),
            ...REASONING_EFFORTS.map((effort) => ({ value: effort, label: effort })),
          ]}
          onValueChange={(value) => {
            update('reasoningEffort', value === UNSET_EFFORT ? '' : value);
          }}
          hint="Only reasoning models read this. Once set it can be cleared in config.json, but not here — a patch has no way to say “remove this key”."
        />
      </Section>

      <Section
        title="Budget"
        description="The limits a turn runs inside. A duration of 0 disables that limit."
      >
        <FieldGrid>
          <TextField
            label="Max output tokens"
            inputMode="numeric"
            value={form.maxTokens}
            error={errors.maxTokens}
            onValueChange={(value) => {
              update('maxTokens', value);
            }}
          />
          <TextField
            label="Context window (tokens)"
            inputMode="numeric"
            value={form.contextWindowTokens}
            error={errors.contextWindowTokens}
            onValueChange={(value) => {
              update('contextWindowTokens', value);
            }}
            hint="What the context inspector measures against."
          />
          <TextField
            label="Temperature"
            inputMode="decimal"
            value={form.temperature}
            error={errors.temperature}
            onValueChange={(value) => {
              update('temperature', value);
            }}
            hint="0 to 2."
          />
          <TextField
            label="Max tool iterations"
            inputMode="numeric"
            value={form.maxToolIterations}
            error={errors.maxToolIterations}
            onValueChange={(value) => {
              update('maxToolIterations', value);
            }}
            hint="How many times one turn may call a tool before it stops."
          />
          <TextField
            label="Tool timeout (seconds)"
            inputMode="decimal"
            value={form.toolTimeoutSeconds}
            error={errors.toolTimeoutSeconds}
            onValueChange={(value) => {
              update('toolTimeoutSeconds', value);
            }}
            hint="0 for no timeout. A call already running keeps the timeout it started under."
          />
          <TextField
            label="Turn wall-clock limit (seconds)"
            inputMode="decimal"
            value={form.loopWallTimeoutSeconds}
            error={errors.loopWallTimeoutSeconds}
            onValueChange={(value) => {
              update('loopWallTimeoutSeconds', value);
            }}
            hint="0 for no limit."
          />
        </FieldGrid>
      </Section>

      <Section
        title="Workspace"
        description="The one tree the filesystem tools may reach, and the root the file browser shows."
      >
        <TextField
          label="Workspace directory"
          value={form.workspace}
          placeholder="<root>/workspace"
          onValueChange={(value) => {
            update('workspace', value);
          }}
          hint="Empty means the default under GHOSTAI_HOME. A relative path is resolved against it, never against the working directory."
        />
      </Section>

      <Section title="Learning" description="Periodic consolidation passes over the conversation.">
        <SwitchRow
          label="Proactive learning"
          hint="Runs a consolidation pass every few turns."
          checked={form.learningEnabled}
          onCheckedChange={(checked) => {
            update('learningEnabled', checked);
          }}
        />
        <TextField
          label="Turns between passes"
          inputMode="numeric"
          value={form.learningInterval}
          error={errors.learningInterval}
          disabled={!form.learningEnabled}
          onValueChange={(value) => {
            update('learningInterval', value);
          }}
        />
      </Section>

      <SaveBar dirty={dirty} saving={saving} onSave={onSave} onRevert={onRevert} />
    </div>
  );
}
