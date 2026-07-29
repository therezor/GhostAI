/**
 * Creating a provider: the type, a name, and straight into the editor.
 *
 * The counterpart of "New agent", and deliberately as small. It asks the one
 * question the editor cannot — the **type**, which is fixed for the life of the
 * instance because the credential in the vault is keyed to its id, so an
 * endpoint that could change protocol would be a key handed to a stranger — and
 * a name, because naming a thing while creating it is cheaper than going back
 * for it. Everything else about an endpoint is edited in one place.
 *
 * It opens the editor on success rather than merely growing the list, for the
 * reason the agents dialog does: creating one is the first half of setting it
 * up, and a list that has quietly gained a row leaves the other half to be
 * found.
 */

import { useNavigate } from '@tanstack/react-router';
import { useEffect, useState, type JSX } from 'react';
import { useTranslation } from 'react-i18next';

import type { ProviderInfo } from '@ghostai/protocol';

import { Button } from '@/components/ui/button.js';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogHeading,
  DialogSubheading,
} from '@/components/ui/dialog.js';
import { SelectField, TextField } from './controls.js';
import { EMPTY_PROVIDER_FORM, proposeInstanceId, toCreateProviderPatch } from './provider-form.js';
import { useSaveSettings } from './use-settings.js';

export function AddProviderDialog({
  open,
  onOpenChange,
  types,
  taken,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly types: readonly ProviderInfo[];
  /** The ids already in the config, so the proposed one is free. */
  readonly taken: readonly string[];
}): JSX.Element {
  const { t } = useTranslation();
  const [type, setType] = useState('');
  const [label, setLabel] = useState('');
  const { save, saving } = useSaveSettings();
  const navigate = useNavigate();

  // Keyed on `open` rather than reset in `onOpenChange`, so it holds whichever
  // way the dialog was closed — Cancel, `Escape` or a click outside. The second
  // "New provider" of a session must not open holding the first one's answers.
  useEffect(() => {
    if (!open) return;
    setType('');
    setLabel('');
  }, [open]);

  const chosen = types.find((candidate) => candidate.id === type);

  const submit = (): void => {
    if (type === '' || saving) return;
    const instanceId = proposeInstanceId(type, taken);

    save(toCreateProviderPatch(instanceId, { ...EMPTY_PROVIDER_FORM, type, label }), {
      // On success, not on the next line: `save` is fire-and-forget, and
      // navigating straight after it took the editor to an endpoint the
      // settings cache had never seen — which renders as "There is no provider
      // called …" and makes creating one look like it did nothing.
      onSuccess: () => {
        onOpenChange(false);
        void navigate({ to: '/settings/providers/$instanceId', params: { instanceId } });
      },
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        {/* A real form, so Enter submits — the only interaction anyone wants
            from a dialog with two boxes in it. */}
        <form
          className="stack"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <DialogHeader>
            <DialogHeading>{t('providers.newTitle')}</DialogHeading>
            <DialogSubheading>{t('providers.newHint')}</DialogSubheading>
          </DialogHeader>

          <div className="stack settings-panel">
            <SelectField
              label={t('common.type')}
              value={type}
              placeholder={t('providers.chooseType')}
              options={types.map((candidate) => ({
                value: candidate.id,
                label: candidate.displayName,
              }))}
              onValueChange={setType}
              hint={
                chosen === undefined
                  ? 'Any OpenAI-compatible endpoint works; pick Custom if yours is not listed.'
                  : chosen.defaultApiBase === undefined
                    ? 'This type has no default endpoint, so give it one on the next screen.'
                    : `Defaults to ${chosen.defaultApiBase}, which you can change next.`
              }
            />

            <TextField
              label={t('common.name')}
              value={label}
              placeholder={chosen?.displayName ?? 'Optional'}
              onValueChange={setLabel}
              hint="What this endpoint is called in the list. Blank uses the type's own name."
            />
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                onOpenChange(false);
              }}
            >
              Cancel
            </Button>
            {/* `Create`, and the label does not change while it is pending —
                the same footer `NameDialog` gives every other create in the
                app, down to the disabled state standing in for a spinner. */}
            <Button type="submit" variant="primary" disabled={type === '' || saving}>
              Create
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
