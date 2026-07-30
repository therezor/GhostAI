/**
 * Creating a workspace: a name, and the folder it gets.
 *
 * It used to be a `NameDialog` — one box, and the folder was whatever
 * `deriveWorkspaceId` made of the name. That is a fine default and a poor rule:
 * "Client Acme (2024 rebuild)" became `client-acme-2024-rebuild`, and the only
 * way to get the short folder someone actually wanted to `cd` into was to create
 * it under a name they did not want and rename it afterwards. The two things
 * were already independent everywhere below this — the registry stores them in
 * separate columns and `POST /api/workspaces` has always accepted an `id` — so
 * this is a field the UI was not offering rather than a capability being added.
 *
 * **The folder is asked here because here it is free.** Creating the directory
 * is a `mkdir`; changing it afterwards is a `rename(2)` under a tree somebody
 * may be working in, plus a repoint of every conversation that named the old
 * one. The editor does do that — it is the one screen where the cost is worth
 * stating — but the cheap moment to get it right is before anything is in it.
 *
 * The box is left empty by most people, and empty is not "no answer": it means
 * "the one derived from the name", which the placeholder shows as it is typed.
 */

import type { TFunction } from 'i18next';
import { useEffect, useState, type JSX } from 'react';
import { useTranslation } from 'react-i18next';

import {
  RESERVED_WORKSPACE_IDS,
  deriveWorkspaceId,
  isWorkspaceId,
  type WorkspaceSummary,
} from '@ghostai/protocol';

import { Button } from '@/components/ui/button.js';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogHeading,
  DialogSubheading,
} from '@/components/ui/dialog.js';
import { TextField } from '@/settings/controls.js';
import { WORKSPACE_ROOT_PATH } from './folder.js';

export function CreateWorkspaceDialog({
  open,
  onOpenChange,
  existing,
  pending,
  onSubmit,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** The workspaces already registered, so a taken folder is refused here. */
  readonly existing: readonly WorkspaceSummary[];
  readonly pending: boolean;
  /** `folder` is empty when the derived one will do — the server derives it. */
  readonly onSubmit: (values: { readonly name: string; readonly folder: string }) => void;
}): JSX.Element {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [folder, setFolder] = useState('');

  // Keyed on `open` rather than reset in `onOpenChange`, so it holds whichever
  // way the dialog was closed — Cancel, `Escape` or a click outside. The second
  // "New workspace" of a session must not open holding the first one's answers.
  useEffect(() => {
    if (!open) return;
    setName('');
    setFolder('');
  }, [open]);

  const trimmedName = name.trim();
  const trimmedFolder = folder.trim();
  const derived = trimmedName === '' ? '' : deriveWorkspaceId(trimmedName);
  const proposed = trimmedFolder === '' ? derived : trimmedFolder;

  const folderError = folderProblem(trimmedFolder, existing, t);
  const submittable = trimmedName !== '' && folderError === undefined && !pending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        {/* A real form, so Enter submits — the only interaction anyone wants
            from a dialog with two boxes in it. */}
        <form
          className="stack"
          onSubmit={(event) => {
            event.preventDefault();
            if (submittable) onSubmit({ name: trimmedName, folder: trimmedFolder });
          }}
        >
          <DialogHeader>
            <DialogHeading>{t('workspaces.newTitle')}</DialogHeading>
            <DialogSubheading>{t('workspaces.newHint')}</DialogSubheading>
          </DialogHeader>

          <div className="stack settings-panel">
            <TextField
              label={t('common.name')}
              autoFocus
              value={name}
              placeholder={t('workspaces.namePlaceholder')}
              onValueChange={setName}
              hint="What the workspace is called in the switcher and the list. Rename it whenever you like."
            />

            <TextField
              label={t('workspaces.folder')}
              value={folder}
              className="workspaces__folder-input"
              spellCheck={false}
              // The derived folder, live, rather than a static example: it is
              // what pressing Create would actually produce, and seeing it
              // change while the name is typed is what explains the field.
              placeholder={derived === '' ? 'client-acme' : derived}
              onValueChange={setFolder}
              error={folderError}
              hint={
                proposed === ''
                  ? t('workspaces.folderHint')
                  : `Creates ${WORKSPACE_ROOT_PATH}${proposed}. You can move it later from the workspace's own screen.`
              }
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
            <Button type="submit" variant="primary" disabled={!submittable}>
              Create
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * What is wrong with the folder that was typed, if anything.
 *
 * Only the *typed* one is judged. A derived folder that collides is not an
 * error: the registry answers a taken slug with `client-acme-2`, which is the
 * behaviour that lets two workspaces share a name, and refusing it in the
 * browser would break a flow the server handles.
 *
 * The three rules are the store's own, checked a layer early so the message can
 * point at the box rather than arriving as a toast over a closed dialog.
 */
function folderProblem(
  folder: string,
  existing: readonly WorkspaceSummary[],
  t: TFunction,
): string | undefined {
  if (folder === '') return undefined;
  if (!isWorkspaceId(folder)) return t('workspaces.folderShape');
  if (RESERVED_WORKSPACE_IDS.has(folder)) return t('workspaces.folderReserved');
  if (existing.some((workspace) => workspace.id === folder)) return t('workspaces.folderTaken');
  return undefined;
}
