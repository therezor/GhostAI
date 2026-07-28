/**
 * The Providers panel.
 *
 * The list is what the operator has *configured*, not what the registry knows,
 * and that inversion is the whole change: a provider used to be a row that
 * always existed and might have settings, and is now an endpoint that exists
 * because someone added it. Two Ollama servers are two rows. The registry
 * catalogue moved into the "Add provider" control at the top, which is the only
 * place a type is ever chosen — an instance's type is fixed at creation, because
 * changing an endpoint's protocol is not an edit, it is a different endpoint.
 *
 * The key field is the reason this panel exists and the rules it holds are worth
 * stating plainly:
 *
 *  - **It is never populated.** No response carries a credential, so there is
 *    nothing to populate it *from*, and an input that showed dots for a stored
 *    key would be showing a value the client does not have.
 *  - **It is cleared the moment the save succeeds**, so a key does not sit in a
 *    React tree, in a re-render, or in a screenshot of the tab.
 *  - **Removing a key is a separate press**, sending `value: null`. An empty
 *    field submitted by accident deletes nothing.
 *  - **It is offered for local endpoints too.** A LAN model server behind an
 *    auth proxy is a real configuration, and the field used to be a sentence
 *    saying the provider took no key — which was true of the lookup and not of
 *    the deployment.
 *
 * Expanding one row does not collapse the others: comparing two endpoints'
 * settings is a normal thing to do here, and an accordion that closes the row
 * you were reading makes it impossible.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronRight, KeyRound, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { useId, useState, type JSX } from 'react';

import type { Config, ModelsResponse, ProviderInfo, ProviderInstanceInfo } from '@ghostai/protocol';

import { cn } from '@/lib/cn.js';
import { api } from '@/lib/api.js';
import { queryKeys } from '@/lib/query.js';
import { Badge } from '@/components/ui/badge.js';
import { Button } from '@/components/ui/button.js';
import { Input, Label, Textarea } from '@/components/ui/field.js';
import { toast } from '@/components/ui/toast.js';
import { Section, SelectField, TextField } from './controls.js';
import {
  toCreateProviderPatch,
  toDeleteProviderPatch,
  toProviderForm,
  toProviderPatch,
  type ProviderForm,
} from './provider-form.js';
import { useSaveCredential, useSaveSettings } from './use-settings.js';

/**
 * A `-2`, `-3`, … suffix, added only when the bare type is taken.
 *
 * The same rule as `nextInstanceId` in `@ghostai/providers`, restated here
 * because the panel needs an id *before* the round trip that would tell it one —
 * the server accepts whatever the patch names, so proposing a free one is the
 * client's job. A collision is not silent if it happens: the patch would merge
 * into the existing instance, which is why the taken set is the live config.
 */
export function proposeInstanceId(type: string, taken: readonly string[]): string {
  const used = new Set(taken);
  if (!used.has(type)) return type;
  for (let n = 2; ; n += 1) {
    const candidate = `${type}-${String(n)}`;
    if (!used.has(candidate)) return candidate;
  }
}

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

  const { types, instances } = providers.data;

  return (
    <Section
      title="Providers"
      description="Each row is one endpoint. Add the same type more than once to run against two servers. Keys are written to the encrypted vault and are never returned by the API."
    >
      <AddProvider types={types} taken={Object.keys(config.providers)} />

      {instances.length === 0 ? (
        <p className="page__note">
          No providers yet. Add one above, then choose a model in the Agent panel.
        </p>
      ) : (
        <ul className="stack settings-list">
          {instances.map((instance) => (
            <li key={instance.id}>
              <ProviderRow instance={instance} config={config} />
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function AddProvider({
  types,
  taken,
}: {
  readonly types: readonly ProviderInfo[];
  readonly taken: readonly string[];
}): JSX.Element {
  const [type, setType] = useState('');
  const [label, setLabel] = useState('');
  const { save, saving } = useSaveSettings();

  const chosen = types.find((candidate) => candidate.id === type);

  return (
    <div className="stack settings-panel provider-add">
      <SelectField
        label="Add a provider"
        value={type}
        placeholder="Choose a type"
        options={types.map((candidate) => ({ value: candidate.id, label: candidate.displayName }))}
        onValueChange={setType}
        hint={
          chosen?.defaultApiBase === undefined
            ? 'Any OpenAI-compatible endpoint works; pick Custom if yours is not listed.'
            : `Defaults to ${chosen.defaultApiBase}. You can change it after adding.`
        }
      />

      <TextField
        label="Name"
        value={label}
        placeholder={chosen?.displayName ?? 'Optional'}
        onValueChange={setLabel}
        hint="What this endpoint is called in the list. Blank uses the provider's own name."
      />

      <div className="row">
        <Button
          variant="primary"
          disabled={type === '' || saving}
          onClick={() => {
            save(toCreateProviderPatch(proposeInstanceId(type, taken), type, label));
            setType('');
            setLabel('');
          }}
        >
          <Plus />
          Add provider
        </Button>
      </div>
    </div>
  );
}

function ProviderRow({
  instance,
  config,
}: {
  readonly instance: ProviderInstanceInfo;
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
        <span className="provider-row__name truncate">{instance.displayName}</span>

        {instance.isLocal && <Badge tone="neutral">local</Badge>}
        {instance.isGateway && <Badge tone="info">gateway</Badge>}
        {instance.isOAuth && <Badge tone="info">oauth</Badge>}
        {!instance.enabled && <Badge tone="warning">off</Badge>}

        <span className="spacer" />

        {/* The dot is a badge with a word in it. A bare coloured dot carries the
            state in colour alone, which is the one encoding some readers do not
            receive at all. */}
        <Badge tone={instance.credentialsPresent ? 'success' : 'neutral'}>
          {instance.credentialsPresent ? 'key saved' : 'no key'}
        </Badge>
      </button>

      {open && (
        <div id={bodyId} className="stack provider-row__body">
          <CredentialField instance={instance} />
          <ConnectionForm instance={instance} config={config} />
        </div>
      )}
    </div>
  );
}

function CredentialField({ instance }: { readonly instance: ProviderInstanceInfo }): JSX.Element {
  const [value, setValue] = useState('');
  const { save, saving } = useSaveCredential();
  const id = useId();

  return (
    <div className="stack settings-field">
      <Label htmlFor={id}>{instance.isLocal ? 'API token (optional)' : 'API key'}</Label>
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
          placeholder={instance.credentialsPresent ? 'Replace the saved key' : 'Paste a key'}
          className="provider-row__key-input"
          onChange={(event) => {
            setValue(event.target.value);
          }}
        />
        <Button
          variant="primary"
          disabled={value.trim() === '' || saving}
          onClick={() => {
            // Keyed by the *instance*, so two endpoints of one type hold
            // different keys.
            save({ namespace: 'providers', key: instance.id, value: value.trim() });
            // Cleared here rather than in the success handler: the value has
            // left for the vault, and keeping it on screen until a round trip
            // completes is the window this clears.
            setValue('');
          }}
        >
          <KeyRound />
          Save key
        </Button>
        {instance.credentialsPresent && (
          <Button
            variant="ghost"
            disabled={saving}
            onClick={() => {
              save({ namespace: 'providers', key: instance.id, value: null });
            }}
          >
            Remove key
          </Button>
        )}
      </div>
      <p className="settings-field__hint">
        {instance.isLocal
          ? 'Most local servers need none. Fill this in if yours sits behind an authenticating proxy.'
          : 'Stored in the encrypted vault.'}
        {instance.envKey !== undefined &&
          ` ${instance.envKey} in the environment is used when no key is saved.`}
      </p>
    </div>
  );
}

function ConnectionForm({
  instance,
  config,
}: {
  readonly instance: ProviderInstanceInfo;
  readonly config: Config;
}): JSX.Element {
  const [form, setForm] = useState<ProviderForm>(() =>
    toProviderForm(config.providers[instance.id]),
  );
  const [dirty, setDirty] = useState(false);
  const { save, saving } = useSaveSettings();
  const remove = useRemoveProvider();
  const models = useModelRefresh();
  const modelsId = useId();

  const update = <K extends keyof ProviderForm>(key: K, next: ProviderForm[K]): void => {
    setForm((current) => ({ ...current, [key]: next }));
    setDirty(true);
  };

  return (
    <div className="stack settings-panel">
      <TextField
        label="Name"
        value={form.label}
        placeholder={instance.type}
        onValueChange={(value) => {
          update('label', value);
        }}
        hint="Blank uses the provider's own name."
      />

      <TextField
        label="API base"
        value={form.apiBase}
        placeholder={instance.apiBase}
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
          {instance.supportsModelListing
            ? 'This endpoint lists its own models, so leaving this empty is normal. Anything here is offered as well, and is what the Agent panel falls back to when the endpoint cannot be reached.'
            : 'Nothing enumerates this endpoint, so this list is the catalogue the Agent panel offers.'}
        </p>
        {instance.supportsModelListing && (
          <div className="row">
            <Button
              variant="ghost"
              disabled={models.isPending}
              onClick={() => {
                models.mutate();
              }}
            >
              <RefreshCw />
              {models.isPending ? 'Checking…' : 'Check for models now'}
            </Button>
          </div>
        )}
      </div>

      <div className="row">
        <Button
          disabled={!dirty || saving}
          onClick={() => {
            save(toProviderPatch(instance.id, form));
            setDirty(false);
          }}
        >
          {saving ? 'Saving…' : 'Save connection'}
        </Button>
        <span role="status" aria-live="polite" className="settings-save-bar__state">
          {dirty ? 'Unsaved changes' : ''}
        </span>
        <span className="spacer" />
        <Button
          variant="danger"
          disabled={remove.isPending}
          onClick={() => {
            remove.mutate(instance.id);
          }}
        >
          <Trash2 />
          Remove provider
        </Button>
      </div>
    </div>
  );
}

/**
 * Deleting an instance.
 *
 * Its own mutation rather than `useSaveSettings` so the toast can say what
 * happened to the key: the server drops the vault entry with the config entry,
 * and an operator who does not know that would reasonably assume a re-added
 * endpoint of the same name still has its credential.
 */
function useRemoveProvider(): ReturnType<typeof useMutation<unknown, Error, string>> {
  const queryClient = useQueryClient();

  return useMutation<unknown, Error, string>({
    mutationFn: (instanceId: string) => api.patchSettings(toDeleteProviderPatch(instanceId)),
    onSuccess: async () => {
      await queryClient.invalidateQueries();
      toast.success('Provider removed', 'Its saved key was deleted with it.');
    },
    onError: (error) => {
      toast.error('Could not remove the provider', error.message);
    },
  });
}

/** Forces a re-fetch of every endpoint's catalogue, past both caches. */
function useModelRefresh(): ReturnType<typeof useMutation<ModelsResponse>> {
  const queryClient = useQueryClient();

  return useMutation<ModelsResponse>({
    mutationFn: () => api.refreshModels(),
    onSuccess: (response) => {
      queryClient.setQueryData(queryKeys.models, response);
      const failed = Object.entries(response.errors);
      if (failed.length === 0) {
        toast.success('Model lists refreshed');
        return;
      }
      // Named, not counted: "1 provider failed" sends the operator looking, and
      // the reason is the thing that tells them whether to start the server.
      const [id, reason] = failed[0] ?? ['', ''];
      toast.error(`Could not reach ${id}`, reason);
    },
    onError: (error) => {
      toast.error('Could not refresh the model lists', error.message);
    },
  });
}
