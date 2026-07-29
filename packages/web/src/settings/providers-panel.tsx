/**
 * The Providers panel: the list, and the way into each endpoint.
 *
 * The list is what the operator has *configured*, not what the registry knows,
 * and that inversion is the whole change: a provider used to be a row that
 * always existed and might have settings, and is now an endpoint that exists
 * because someone added it. Two Ollama servers are two rows.
 *
 * Shaped like Agents, because it is the same kind of thing: a table that picks,
 * a `RowActions` kebab for the acts that need no form, and **an editor route**
 * for the rest. Creating one asks the single question the editor cannot — the
 * type, which is fixed for the life of the instance — and then opens the editor,
 * exactly as "New agent" asks for a name and opens that.
 *
 * There is no "refresh every provider's models" button here any more. It asked
 * every configured endpoint at once, so one closed laptop made the whole action
 * look broken, and it answered a question nobody on this screen was asking.
 * Fetching a catalogue is a thing you do *to an endpoint*, and it lives in that
 * endpoint's editor.
 */

import { useQuery } from '@tanstack/react-query';
import { Pencil, Plug, Plus, Power, PowerOff, Trash2 } from 'lucide-react';
import { useState, type JSX } from 'react';
import { useTranslation } from 'react-i18next';

import { Link, useNavigate } from '@tanstack/react-router';
import type { Config, ProviderInstanceInfo } from '@ghostai/protocol';

import { api } from '@/lib/api.js';
import { queryKeys } from '@/lib/query.js';
import { Badge } from '@/components/ui/badge.js';
import { Button } from '@/components/ui/button.js';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu.js';
import { ConfirmDialog } from '@/components/crud/confirm-dialog.js';
import { RowActions } from '@/components/crud/row-actions.js';
import { AddProviderDialog } from './add-provider-dialog.js';
import { Section } from './controls.js';
import { toProviderEnabledPatch } from './provider-form.js';
import { useRemoveProvider } from './use-provider.js';
import { useSaveSettings } from './use-settings.js';

export function ProvidersPanel({ config }: { readonly config: Config }): JSX.Element {
  const { t } = useTranslation();
  const [adding, setAdding] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<ProviderInstanceInfo | undefined>(undefined);
  const { save, saving } = useSaveSettings();
  const { remove, removing } = useRemoveProvider();
  const navigate = useNavigate();

  const providers = useQuery({
    queryKey: queryKeys.providers,
    queryFn: ({ signal }) => api.providers(signal),
  });

  if (providers.isPending) {
    return <p className="page__note">{t('providers.loading')}</p>;
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
    <Section title={t('providers.title')} description={t('providers.panelDesc')}>
      {/* Trailing and in the default variant, like "New agent" and "New
          workspace". A primary fill on the one control that opens a dialog made
          the create the loudest thing in a panel whose subject is the list. */}
      <div className="cluster">
        <span className="spacer" />
        <Button
          onClick={() => {
            setAdding(true);
          }}
        >
          <Plus />
          {t('providers.newProvider')}
        </Button>
      </div>

      {instances.length === 0 ? (
        <p className="page__note">{t('providers.none')}</p>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col">{t('common.name')}</th>
              <th scope="col">{t('providers.endpoint')}</th>
              <th scope="col">Key</th>
              <th scope="col">{t('common.status')}</th>
              <th scope="col" className="data-table__actions">
                <span className="sr-only">{t('common.actions')}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {instances.map((instance) => (
              <tr key={instance.id}>
                <td>
                  <Link
                    to="/settings/providers/$instanceId"
                    params={{ instanceId: instance.id }}
                    className="data-table__open"
                    aria-label={`Edit ${instance.displayName}`}
                  >
                    <Plug />
                    <span className="row">
                      <span className="truncate">{instance.displayName}</span>
                      {instance.isLocal && <Badge tone="neutral">local</Badge>}
                      {instance.isGateway && <Badge tone="info">gateway</Badge>}
                    </span>
                  </Link>
                </td>
                <td className="data-table__meta providers__endpoint truncate">
                  {instance.apiBase}
                </td>
                <td className="data-table__meta">
                  {/* A badge with a word in it, not a bare coloured dot: colour
                      alone is the one encoding some readers do not receive. */}
                  <Badge tone={instance.credentialsPresent ? 'success' : 'neutral'}>
                    {instance.credentialsPresent ? 'key saved' : 'no key'}
                  </Badge>
                </td>
                <td className="data-table__meta">
                  <Badge tone={instance.enabled ? 'success' : 'neutral'}>
                    {instance.enabled ? 'Enabled' : 'Disabled'}
                  </Badge>
                </td>
                <td className="data-table__actions">
                  <RowActions label={instance.displayName}>
                    <DropdownMenuItem
                      onSelect={() => {
                        void navigate({
                          to: '/settings/providers/$instanceId',
                          params: { instanceId: instance.id },
                        });
                      }}
                    >
                      <Pencil />
                      Edit
                    </DropdownMenuItem>
                    {/* Reversible where Delete is not, so it does not ask:
                        switching it back on is the same click. */}
                    <DropdownMenuItem
                      disabled={saving}
                      onSelect={() => {
                        save(toProviderEnabledPatch(instance.id, !instance.enabled));
                      }}
                    >
                      {instance.enabled ? <PowerOff /> : <Power />}
                      {instance.enabled ? 'Disable' : 'Enable'}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      className="menu__item--danger"
                      onSelect={() => {
                        setPendingDelete(instance);
                      }}
                    >
                      <Trash2 />
                      Delete
                    </DropdownMenuItem>
                  </RowActions>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <AddProviderDialog
        open={adding}
        onOpenChange={setAdding}
        types={types}
        taken={Object.keys(config.providers)}
      />

      <ConfirmDialog
        open={pendingDelete !== undefined}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(undefined);
        }}
        title={t('providers.deleteTitle')}
        description={t('providers.deleteHint', { name: pendingDelete?.displayName ?? '' })}
        confirmLabel="Delete"
        pending={removing}
        onConfirm={() => {
          if (pendingDelete === undefined) return;
          // Closed on success, not on the press: a delete that failed should
          // leave the question on screen with its error.
          remove(pendingDelete.id, {
            onSuccess: () => {
              setPendingDelete(undefined);
            },
          });
        }}
      />
    </Section>
  );
}
