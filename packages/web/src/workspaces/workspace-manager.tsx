/**
 * Add, rename and remove workspaces.
 *
 * A dialog rather than a settings panel: the switcher is where a workspace is
 * chosen, and the place to manage the list is one press from there rather than
 * three navigations away in a tab nobody opens.
 *
 * **Delete detaches, and the copy has to say so.** The folder and everything in
 * it stays on disk — there is no undo for removing a tree someone has been
 * working in, and one click is all it takes to ask for one. Recreating a
 * workspace with the same name adopts the folder again, which is what makes the
 * round trip safe rather than merely reversible in principle.
 *
 * The one flow with real shape is the refusal. A workspace whose conversations
 * still point at it cannot be detached — the server answers 409 and says how
 * many — so the dialog turns that number into the offer that resolves it:
 * move them to Default, then delete. Two explicit steps rather than one
 * cascading delete, because "remove this workspace" and "move seven
 * conversations somewhere else" are different decisions.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FolderPlus, Pencil, Trash2 } from 'lucide-react';
import { useState, type JSX } from 'react';

import { Badge } from '@/components/ui/badge.js';
import { Button } from '@/components/ui/button.js';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogHeading,
  DialogSubheading,
} from '@/components/ui/dialog.js';
import { Input, Label } from '@/components/ui/field.js';
import { toast } from '@/components/ui/toast.js';
import { ApiError, api } from '@/lib/api.js';
import { queryKeys } from '@/lib/query.js';
import type { WorkspaceSummary } from '@ghostai/protocol';
import { DEFAULT_WORKSPACE_ID, useWorkspace } from './workspace-context.js';

/** A delete the server refused, and what it would take to go through. */
interface Blocked {
  readonly workspace: WorkspaceSummary;
  readonly sessionCount: number;
}

export function WorkspaceManager({
  open,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}): JSX.Element {
  const queryClient = useQueryClient();
  const { workspaceId, select } = useWorkspace();

  const [name, setName] = useState('');
  const [renaming, setRenaming] = useState<string | undefined>(undefined);
  const [blocked, setBlocked] = useState<Blocked | undefined>(undefined);

  const workspaces = useQuery({
    queryKey: queryKeys.workspaces,
    queryFn: ({ signal }) => api.workspaces(signal),
    enabled: open,
  });

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.workspaces });
    // The session list is scoped by workspace, and a delete moves sessions.
    void queryClient.invalidateQueries({ queryKey: ['sessions'] });
  };

  const create = useMutation({
    mutationFn: (value: string) => api.createWorkspace(value),
    onSuccess: (created) => {
      setName('');
      refresh();
      toast({ role: 'success', title: `Created ${created.name}` });
    },
    onError: (error: Error) => {
      toast({ role: 'danger', title: 'Could not create it', description: error.message });
    },
  });

  const rename = useMutation({
    mutationFn: ({ id, value }: { id: string; value: string }) => api.renameWorkspace(id, value),
    onSuccess: () => {
      setRenaming(undefined);
      refresh();
    },
    onError: (error: Error) => {
      toast({ role: 'danger', title: 'Could not rename it', description: error.message });
    },
  });

  const remove = useMutation({
    mutationFn: (workspace: WorkspaceSummary) => api.deleteWorkspace(workspace.id),
    onSuccess: (_result, workspace) => {
      // Moving off it first: staying on a workspace that no longer exists would
      // leave the Files page 404ing on every request.
      if (workspace.id === workspaceId) select(DEFAULT_WORKSPACE_ID);
      setBlocked(undefined);
      refresh();
      toast({
        role: 'success',
        title: `Removed ${workspace.name}`,
        description: 'Its folder and files are still on disk.',
      });
    },
    onError: (error: Error, workspace) => {
      // The 409 is not a failure to report, it is a question to ask.
      const sessionCount = sessionCountOf(error);
      if (sessionCount !== undefined) {
        setBlocked({ workspace, sessionCount });
        return;
      }
      toast({ role: 'danger', title: 'Could not remove it', description: error.message });
    },
  });

  const move = useMutation({
    mutationFn: (workspace: WorkspaceSummary) =>
      api.moveWorkspaceSessions(workspace.id, DEFAULT_WORKSPACE_ID),
    onSuccess: (_result, workspace) => {
      remove.mutate(workspace);
    },
    onError: (error: Error) => {
      toast({ role: 'danger', title: 'Could not move the conversations', description: error.message });
    },
  });

  const rows = workspaces.data?.workspaces ?? [];

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogHeading>Workspaces</DialogHeading>
            <DialogSubheading>
              A workspace is a folder the agent works in. Default holds all the others, so it can
              reach their files; the named ones cannot reach each other.
            </DialogSubheading>
          </DialogHeader>

          <ul className="stack workspace-list">
            {rows.map((workspace) => (
              <li key={workspace.id} className="workspace-row">
                {renaming === workspace.id ? (
                  <form
                    className="workspace-row__rename"
                    onSubmit={(event) => {
                      event.preventDefault();
                      const value = new FormData(event.currentTarget).get('name');
                      if (typeof value === 'string' && value.trim() !== '') {
                        rename.mutate({ id: workspace.id, value: value.trim() });
                      }
                    }}
                  >
                    <Label htmlFor={`rename-${workspace.id}`} className="sr-only">
                      New name for {workspace.name}
                    </Label>
                    <Input
                      id={`rename-${workspace.id}`}
                      name="name"
                      defaultValue={workspace.name}
                      autoFocus
                    />
                    <Button type="submit" disabled={rename.isPending}>
                      Save
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => {
                        setRenaming(undefined);
                      }}
                    >
                      Cancel
                    </Button>
                  </form>
                ) : (
                  <>
                    <span className="workspace-row__name truncate">{workspace.name}</span>
                    {workspace.isDefault && <Badge tone="neutral">default</Badge>}
                    <span className="workspace-row__count">
                      {workspace.sessionCount} chat{workspace.sessionCount === 1 ? '' : 's'}
                    </span>
                    <span className="spacer" />
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Rename ${workspace.name}`}
                      onClick={() => {
                        setRenaming(workspace.id);
                      }}
                    >
                      <Pencil />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Remove ${workspace.name}`}
                      // The default is the parent of every other workspace;
                      // there is no coherent thing removing it could mean.
                      disabled={workspace.isDefault || remove.isPending}
                      onClick={() => {
                        remove.mutate(workspace);
                      }}
                    >
                      <Trash2 />
                    </Button>
                  </>
                )}
              </li>
            ))}
          </ul>

          <form
            className="workspace-create"
            onSubmit={(event) => {
              event.preventDefault();
              if (name.trim() !== '') create.mutate(name.trim());
            }}
          >
            <Label htmlFor="workspace-name">New workspace</Label>
            <div className="row workspace-create__row">
              <Input
                id="workspace-name"
                value={name}
                placeholder="Client Acme"
                onChange={(event) => {
                  setName(event.target.value);
                }}
              />
              <Button type="submit" disabled={name.trim() === '' || create.isPending}>
                <FolderPlus />
                Add
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={blocked !== undefined}
        onOpenChange={(next) => {
          if (!next) setBlocked(undefined);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogHeading>Move the conversations first?</DialogHeading>
            <DialogSubheading>
              {blocked === undefined
                ? ''
                : `${String(blocked.sessionCount)} conversation${
                    blocked.sessionCount === 1 ? '' : 's'
                  } still belong to ${blocked.workspace.name}. Moving them to Default keeps their history; the files stay where they are either way.`}
            </DialogSubheading>
          </DialogHeader>

          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => {
                setBlocked(undefined);
              }}
            >
              Cancel
            </Button>
            <Button
              disabled={move.isPending || remove.isPending}
              onClick={() => {
                if (blocked !== undefined) move.mutate(blocked.workspace);
              }}
            >
              Move and remove
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * The count a 409 carried, if it is the one this dialog knows how to answer.
 *
 * Reading the typed `details` rather than the message: the message is prose and
 * a wording change should not silently turn an offer to fix the problem into a
 * generic error toast.
 */
function sessionCountOf(error: Error): number | undefined {
  if (!(error instanceof ApiError) || error.status !== 409) return undefined;
  const count = (error.details as { sessionCount?: unknown } | undefined)?.sessionCount;
  return typeof count === 'number' ? count : undefined;
}
