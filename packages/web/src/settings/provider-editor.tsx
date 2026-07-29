/**
 * Editing one provider endpoint.
 *
 * A route of its own rather than a dialog, and the same shape as the agent
 * editor: a list picks, this edits, the back link returns. An endpoint has four
 * sections' worth of settings — identity, connection, credential, catalogue —
 * and a modal holding all of them is a scroll inside a box, with a Save that
 * cannot use the `SaveBar` every other settings screen saves with.
 *
 * **The type is not editable, and it is not a control.** Changing an endpoint's
 * protocol is not an edit, it is a different endpoint — and the credential in
 * the vault is keyed to the id, so a type that could change would be a key
 * handed to a stranger. It is chosen once, in the dialog that creates the
 * instance, and read back here as a fact.
 *
 * **"Fetch models" is the connection test.** There used to be two buttons that
 * did the same round trip: one asked "does this answer" and one asked "what is
 * on it", and `GET /models` is the single request behind both. So there is one
 * button, its failure is the reachability answer, and its success is the
 * catalogue — which is also what makes the check worth pressing when nothing is
 * wrong.
 *
 * The catalogue it fetches is *not* written into the Models field. That field
 * is the list an operator typed, and it exists for endpoints nothing can
 * enumerate — freezing a live snapshot into it would turn a working provider
 * into a stale hard-coded list the first time someone pressed the button.
 */

import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { ArrowLeft, RefreshCw, Trash2 } from 'lucide-react';
import { useId, useState, type JSX } from 'react';
import { useTranslation } from 'react-i18next';

import type { ProviderInstanceInfo } from '@ghostai/protocol';

import { Badge } from '@/components/ui/badge.js';
import { Button } from '@/components/ui/button.js';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu.js';
import { Label, Textarea } from '@/components/ui/field.js';
import { ConfirmDialog } from '@/components/crud/confirm-dialog.js';
import { RowActions } from '@/components/crud/row-actions.js';
import { api } from '@/lib/api.js';
import { queryKeys } from '@/lib/query.js';
import { FieldGrid, SaveBar, Section, SwitchRow, TextField } from './controls.js';
import { KeyField, ProbeLine } from './provider-fields.js';
import {
  initialKeyField,
  toCredentialValue,
  toProviderForm,
  toProviderPatch,
  toProviderTestRequest,
  type ProviderForm,
} from './provider-form.js';
import { useRemoveProvider, useSaveProvider, useTestProvider } from './use-provider.js';
import { useSettings } from './use-settings.js';

export function ProviderEditorRoute(): JSX.Element {
  const { t } = useTranslation();
  const { instanceId } = useParams({ from: '/settings/providers/$instanceId' });
  const settings = useSettings();
  const providers = useQuery({
    queryKey: queryKeys.providers,
    queryFn: ({ signal }) => api.providers(signal),
  });

  if (settings.isPending || providers.isPending) {
    return <p className="page__note">{t('providers.loadingOne')}</p>;
  }
  if (settings.isError || providers.isError) {
    return (
      <p role="alert" className="page__error">
        Could not load the provider: {(settings.error ?? providers.error)?.message}
      </p>
    );
  }

  const instance = providers.data.instances.find((candidate) => candidate.id === instanceId);

  // A stale link — a bookmark to an endpoint that was deleted, or a hand-typed
  // id. Saying so beats an empty form that silently creates one on first save.
  if (instance === undefined) {
    return (
      <div className="stack page page--wide">
        <p role="alert" className="page__error">
          There is no provider called “{instanceId}”.
        </p>
        <Link to="/settings" search={{ panel: 'providers' }} className="page__back">
          <ArrowLeft aria-hidden="true" />
          {t('providers.backToProviders')}
        </Link>
      </div>
    );
  }

  return (
    // Remounts on a change of endpoint, so one provider's edits — and its key
    // field — cannot survive into the next one's boxes.
    <Editor
      key={instance.id}
      instance={instance}
      form={toProviderForm(settings.data.config.providers[instance.id])}
      extraHeaders={settings.data.config.providers[instance.id]?.extraHeaders ?? {}}
    />
  );
}

function Editor({
  instance,
  form: stored,
  extraHeaders,
}: {
  readonly instance: ProviderInstanceInfo;
  readonly form: ProviderForm;
  readonly extraHeaders: Readonly<Record<string, string>>;
}): JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const modelsId = useId();

  const [form, setForm] = useState<ProviderForm>(stored);
  const [keyField, setKeyField] = useState(() => initialKeyField(instance.credentialsPresent));
  const [dirty, setDirty] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const { save, saving, result: afterSave, probing: probingSave, clear } = useSaveProvider();
  const probe = useTestProvider();
  const { remove, removing } = useRemoveProvider();

  const update = <K extends keyof ProviderForm>(key: K, next: ProviderForm[K]): void => {
    setForm((current) => ({ ...current, [key]: next }));
    setDirty(true);
    // A catalogue fetched from the endpoint as it was is worse than none from
    // the endpoint as it is being typed.
    probe.clear();
    clear();
  };

  /** The connection as the boxes currently describe it — not the stored one. */
  const connection = (): ReturnType<typeof toProviderTestRequest> =>
    toProviderTestRequest({
      form,
      keyField,
      credentialsPresent: instance.credentialsPresent,
      extraHeaders,
      instanceId: instance.id,
    });

  const onSave = (): void => {
    save({
      instanceId: instance.id,
      patch: toProviderPatch(instance.id, form),
      credential: toCredentialValue(keyField, instance.credentialsPresent),
      // No `apiKey`: by the time this runs the vault holds whatever the save
      // just put there — including nothing, if the field was cleared — and
      // reading it back is the only way to check a key this page never held.
      test: instance.supportsModelListing
        ? {
            type: instance.type,
            apiBase: form.apiBase.trim(),
            extraHeaders,
            instanceId: instance.id,
          }
        : null,
    });
    setDirty(false);
    // The typed value has left for the vault; back to the resting state a
    // stored key is shown in.
    setKeyField(initialKeyField(keyField.trim() !== ''));
  };

  const onDelete = (): void => {
    // Leaving on success rather than on the next line: the list this returns to
    // reads the settings tree, and going early lands it on one that still
    // holds the endpoint that is on its way out.
    remove(instance.id, {
      onSuccess: () => {
        void navigate({ to: '/settings', search: { panel: 'providers' } });
      },
    });
  };

  // Whichever check ran last. A save's verdict is prefixed "Saved — but …",
  // because the write is not the thing in doubt.
  const fetched = afterSave ?? probe.result;

  return (
    <div className="stack page page--wide">
      <div className="editor__head">
        <Link to="/settings" search={{ panel: 'providers' }} className="page__back">
          <ArrowLeft aria-hidden="true" />
          Providers
        </Link>

        <div className="cluster editor__title">
          <h1 className="page__title">{form.label === '' ? instance.displayName : form.label}</h1>
          {instance.isLocal && <Badge tone="neutral">local</Badge>}
          {instance.isGateway && <Badge tone="info">gateway</Badge>}
          {!form.enabled && <Badge tone="warning">off</Badge>}
          <span className="spacer" />
          {/* Not a button at the bottom of the form: a destructive action does
              not belong in the reading order of the settings it would destroy. */}
          <RowActions label={instance.displayName}>
            <DropdownMenuItem
              className="menu__item--danger"
              onSelect={() => {
                setConfirmingDelete(true);
              }}
            >
              <Trash2 />
              {t('providers.deleteProvider')}
            </DropdownMenuItem>
          </RowActions>
        </div>

        <p className="page__note">
          A {instance.type} endpoint. The type is fixed for the life of an instance: its saved key
          is keyed to this id, so talking a different protocol is a different endpoint.
        </p>
      </div>

      <Section title={t('providers.identity')} description={t('providers.identityDesc')}>
        <FieldGrid>
          <TextField
            label={t('common.name')}
            value={form.label}
            placeholder={instance.type}
            onValueChange={(value) => {
              update('label', value);
            }}
            hint="Blank uses the provider type's own name."
          />
          <SwitchRow
            label={t('providers.enabled')}
            hint="A disabled endpoint stays configured but is offered to no agent and asked for no models."
            checked={form.enabled}
            onCheckedChange={(checked) => {
              update('enabled', checked);
            }}
          />
        </FieldGrid>
      </Section>

      <Section title={t('providers.connection')} description={t('providers.connectionDesc')}>
        <TextField
          label={t('providers.apiBase')}
          value={form.apiBase}
          placeholder={instance.apiBase}
          spellCheck={false}
          onValueChange={(value) => {
            update('apiBase', value);
          }}
          hint="Empty uses the default shown above."
        />

        <KeyField
          value={keyField}
          isLocal={instance.isLocal}
          envKey={instance.envKey}
          credentialsPresent={instance.credentialsPresent}
          onValueChange={(value) => {
            setKeyField(value);
            setDirty(true);
            probe.clear();
            clear();
          }}
        />
      </Section>

      <Section
        title={t('providers.models')}
        description={
          instance.supportsModelListing
            ? 'This endpoint lists its own models. Fetching asks it — which is also how you find out whether it can be reached at all.'
            : 'Nothing enumerates this endpoint, so this list is the catalogue the agent editor offers.'
        }
      >
        {instance.supportsModelListing && (
          <div className="stack settings-field">
            <div className="row">
              <Button
                variant="secondary"
                disabled={probe.probing || saving}
                onClick={() => {
                  clear();
                  probe.test(connection());
                }}
              >
                <RefreshCw />
                {probe.probing ? 'Fetching…' : 'Fetch models'}
              </Button>
            </div>

            <ProbeLine
              result={fetched}
              probing={probe.probing || probingSave}
              saved={afterSave !== null}
            />

            {fetched?.ok === true && fetched.models.length > 0 && (
              <ul className="provider-catalogue">
                {fetched.models.map((model) => (
                  <li key={model}>{model}</li>
                ))}
              </ul>
            )}
          </div>
        )}

        <div className="stack settings-field">
          <Label htmlFor={modelsId}>
            {instance.supportsModelListing ? 'Extra models' : 'Models'}
          </Label>
          <Textarea
            id={modelsId}
            value={form.models}
            spellCheck={false}
            placeholder={t('providers.modelsPlaceholder')}
            onChange={(event) => {
              update('models', event.target.value);
            }}
          />
          <p className="settings-field__hint">
            {instance.supportsModelListing
              ? 'Offered alongside whatever the endpoint lists, and what the agent editor falls back to when it cannot be reached. Leaving this empty is normal.'
              : 'One model id per line.'}
          </p>
        </div>
      </Section>

      <SaveBar
        dirty={dirty}
        saving={saving}
        onSave={onSave}
        onRevert={() => {
          setForm(stored);
          setKeyField(initialKeyField(instance.credentialsPresent));
          probe.clear();
          clear();
          setDirty(false);
        }}
      />

      <ConfirmDialog
        open={confirmingDelete}
        onOpenChange={setConfirmingDelete}
        title={t('providers.deleteTitle')}
        description={`${instance.displayName} is removed from the settings, and its saved key is deleted with it. Re-adding an endpoint with the same name does not bring the key back.`}
        confirmLabel="Delete"
        pending={removing}
        onConfirm={onDelete}
      />
    </div>
  );
}
