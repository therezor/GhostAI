/**
 * The Providers panel.
 *
 * The list is every provider the registry knows, not only the configured ones,
 * because "which of these can I use" is the question an operator opens this
 * panel with. Each row states whether a credential exists — a boolean from
 * `credentialsPresent`, never a value — and expands into the two things that are
 * editable: the endpoint and the model list.
 *
 * The key field is the reason this panel exists and the rule it holds is worth
 * stating plainly:
 *
 *  - **It is never populated.** No response carries a credential, so there is
 *    nothing to populate it *from*, and an input that showed dots for a stored
 *    key would be showing a value the client does not have.
 *  - **It is cleared the moment the save succeeds**, so a key does not sit in a
 *    React tree, in a re-render, or in a screenshot of the tab.
 *  - **Removing a key is a separate press**, sending `value: null`. An empty
 *    field submitted by accident deletes nothing.
 *
 * Expanding one row does not collapse the others: comparing two providers'
 * endpoints is a normal thing to do here, and an accordion that closes the row
 * you were reading makes it impossible.
 */

import { useQuery } from '@tanstack/react-query';
import { ChevronRight, KeyRound } from 'lucide-react';
import { useId, useState, type JSX } from 'react';

import type { Config, ProviderInfo } from '@ghostai/protocol';

import { cn } from '@/lib/cn.js';
import { api } from '@/lib/api.js';
import { queryKeys } from '@/lib/query.js';
import { Badge } from '@/components/ui/badge.js';
import { Button } from '@/components/ui/button.js';
import { Input, Label, Textarea } from '@/components/ui/field.js';
import { Section, TextField } from './controls.js';
import { toProviderForm, toProviderPatch, type ProviderForm } from './provider-form.js';
import { useSaveCredential, useSaveSettings } from './use-settings.js';

export function ProvidersPanel({ config }: { readonly config: Config }): JSX.Element {
  const providers = useQuery({
    queryKey: queryKeys.providers,
    queryFn: ({ signal }) => api.providers(signal),
  });

  if (providers.isPending) {
    return <p className="page__note">Loading providers…</p>;
  }
  if (providers.isError) {
    return (
      <p role="alert" className="page__error">
        Could not load providers: {providers.error.message}
      </p>
    );
  }

  return (
    <Section
      title="Providers"
      description="Keys are written to the encrypted vault and are never returned by the API. A key saved here is used by the next turn, with no restart."
    >
      <ul className="stack settings-list">
        {providers.data.providers.map((provider) => (
          <li key={provider.id}>
            <ProviderRow provider={provider} config={config} />
          </li>
        ))}
      </ul>
    </Section>
  );
}

function ProviderRow({
  provider,
  config,
}: {
  readonly provider: ProviderInfo;
  readonly config: Config;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const bodyId = useId();

  return (
    <div className="provider-row">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => {
          setOpen((value) => !value);
        }}
        className="provider-row__header"
      >
        <ChevronRight
          className={cn(
            'provider-row__chevron disclosure-chevron',
            open && 'disclosure-chevron--open',
          )}
        />
        <span className="provider-row__name truncate">{provider.displayName}</span>

        {provider.isLocal && <Badge tone="neutral">local</Badge>}
        {provider.isGateway && <Badge tone="info">gateway</Badge>}
        {provider.isOAuth && <Badge tone="info">oauth</Badge>}

        <span className="spacer" />

        {/* The dot is a badge with a word in it. A bare coloured dot carries the
            state in colour alone, which is the one encoding some readers do not
            receive at all. */}
        <Badge tone={provider.credentialsPresent ? 'success' : 'neutral'}>
          {provider.credentialsPresent ? 'key saved' : 'no key'}
        </Badge>
      </button>

      {open && (
        <div id={bodyId} className="stack provider-row__body">
          <CredentialField provider={provider} />
          <ConnectionForm provider={provider} config={config} />
        </div>
      )}
    </div>
  );
}

function CredentialField({ provider }: { readonly provider: ProviderInfo }): JSX.Element {
  const [value, setValue] = useState('');
  const { save, saving } = useSaveCredential();
  const id = useId();

  // A local provider with no environment key is one the credential lookup skips
  // entirely — `findCredential` does not even open the vault for it. A field
  // that accepted a key nothing would ever read is a stub wearing a working
  // control's clothes, so it is a sentence instead.
  if (provider.envKey === undefined && provider.isLocal) {
    return <p className="settings-field__hint">This provider takes no key.</p>;
  }

  return (
    <div className="stack settings-field">
      <Label htmlFor={id}>API key</Label>
      <div className="cluster">
        <Input
          id={id}
          // `new-password` rather than `off`: password managers ignore `off` and
          // offer to fill the field with the site's login password, which is a
          // different secret entirely.
          type="password"
          autoComplete="new-password"
          spellCheck={false}
          value={value}
          placeholder={provider.credentialsPresent ? 'Replace the saved key' : 'Paste a key'}
          className="provider-row__key-input"
          onChange={(event) => {
            setValue(event.target.value);
          }}
        />
        <Button
          variant="primary"
          disabled={value.trim() === '' || saving}
          onClick={() => {
            save({ namespace: 'providers', key: provider.id, value: value.trim() });
            // Cleared here rather than in the success handler: the value has
            // left for the vault, and keeping it on screen until a round trip
            // completes is the window this clears.
            setValue('');
          }}
        >
          <KeyRound />
          Save key
        </Button>
        {provider.credentialsPresent && (
          <Button
            variant="ghost"
            disabled={saving}
            onClick={() => {
              save({ namespace: 'providers', key: provider.id, value: null });
            }}
          >
            Remove
          </Button>
        )}
      </div>
      <p className="settings-field__hint">
        {provider.envKey === undefined
          ? 'Stored in the encrypted vault.'
          : `Stored in the encrypted vault. ${provider.envKey} in the environment is used when no key is saved.`}
      </p>
    </div>
  );
}

function ConnectionForm({
  provider,
  config,
}: {
  readonly provider: ProviderInfo;
  readonly config: Config;
}): JSX.Element {
  const [form, setForm] = useState<ProviderForm>(() =>
    toProviderForm(config.providers[provider.id]),
  );
  const [dirty, setDirty] = useState(false);
  const { save, saving } = useSaveSettings();
  const modelsId = useId();

  const update = <K extends keyof ProviderForm>(key: K, next: ProviderForm[K]): void => {
    setForm((current) => ({ ...current, [key]: next }));
    setDirty(true);
  };

  return (
    <div className="stack settings-panel">
      <TextField
        label="API base"
        value={form.apiBase}
        placeholder={provider.defaultApiBase ?? 'Required for this provider'}
        spellCheck={false}
        onValueChange={(value) => {
          update('apiBase', value);
        }}
        hint="Empty uses the default shown above."
      />

      <div className="stack settings-field">
        <Label htmlFor={modelsId}>Models</Label>
        <Textarea
          id={modelsId}
          value={form.models}
          spellCheck={false}
          placeholder="one model id per line"
          onChange={(event) => {
            update('models', event.target.value);
          }}
        />
        <p className="settings-field__hint">
          What the Agent panel offers for this provider. Nothing enumerates a local server&apos;s
          models, so this list is the catalogue.
        </p>
      </div>

      <div className="row">
        <Button
          disabled={!dirty || saving}
          onClick={() => {
            save(toProviderPatch(provider.id, form));
            setDirty(false);
          }}
        >
          {saving ? 'Saving…' : 'Save connection'}
        </Button>
        <span role="status" aria-live="polite" className="settings-save-bar__state">
          {dirty ? 'Unsaved changes' : ''}
        </span>
      </div>
    </div>
  );
}
