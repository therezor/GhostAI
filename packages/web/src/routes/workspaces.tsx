/**
 * The workspaces list.
 *
 * This used to be a dialog hanging off the sidebar switcher, and moving it to a
 * page is not a cosmetic promotion. A workspace is a folder the agent works in
 * and a scope every conversation belongs to; it is the same *kind* of thing as
 * a file or an agent, and it was the only one of the three whose management
 * lived in a modal — with its own row stylesheet, its own inline rename form,
 * and a delete that fired on a single click with nothing between it and the
 * folder. Two of those were bugs that only looked like styling.
 *
 * So: the same `page page--wide` frame as Files and Agents, the same
 * `list-toolbar` and `SearchFilter`, the same `data-table`, the same kebab, and
 * the same `ConfirmDialog` in front of the one irreversible action.
 *
 * **Delete detaches, and the copy has to say so.** The folder and everything in
 * it stays on disk. Recreating a workspace with the same name adopts the folder
 * again, which is what makes the round trip safe rather than merely reversible
 * in principle.
 *
 * The one flow with real shape is the refusal. A workspace whose conversations
 * still point at it cannot be detached — the server answers 409 and says how
 * many — so the second dialog turns that number into the offer that resolves
 * it: move them to Default, then delete. Two explicit steps rather than one
 * cascading delete, because "remove this workspace" and "move seven
 * conversations somewhere else" are different decisions.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FolderPlus, Pencil, Trash2 } from 'lucide-react';
import { useMemo, useState, type JSX } from 'react';

import type { WorkspaceSummary } from '@ghostai/protocol';

import { Badge } from '@/components/ui/badge.js';
import { Button } from '@/components/ui/button.js';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu.js';
import { SearchFilter } from '@/components/ui/search-filter.js';
import { toast } from '@/components/ui/toast.js';
import { ConfirmDialog } from '@/components/crud/confirm-dialog.js';
import { NameDialog } from '@/components/crud/name-dialog.js';
import { RowActions } from '@/components/crud/row-actions.js';
import { SortHeader } from '@/components/crud/sort-header.js';
import {
  filterRows,
  nextSort,
  sortRows,
  type Comparators,
  type SortOrder,
} from '@/components/crud/sort.js';
import { ApiError, api } from '@/lib/api.js';
import { formatRelativeTime } from '@/lib/format.js';
import { queryKeys } from '@/lib/query.js';
import { DEFAULT_WORKSPACE_ID, useWorkspace } from '@/workspaces/workspace-context.js';

type SortKey = 'name' | 'sessions' | 'updated';

/** Only the name reads from A. A count and a time are asked "which is biggest / newest". */
const ASCENDING_FIRST: readonly SortKey[] = ['name'];

const COMPARE: Comparators<WorkspaceSummary, SortKey> = {
  name: (a, b) => a.name.localeCompare(b.name),
  sessions: (a, b) => a.sessionCount - b.sessionCount,
  updated: (a, b) => a.updatedAtMs - b.updatedAtMs,
};

/** A delete the server refused, and what it would take to go through. */
interface Blocked {
  readonly workspace: WorkspaceSummary;
  readonly sessionCount: number;
}

export function WorkspacesRoute(): JSX.Element {
  const queryClient = useQueryClient();
  const { workspaceId, select } = useWorkspace();

  const [filter, setFilter] = useState('');
  const [sort, setSort] = useState<SortOrder<SortKey>>({ key: 'name', descending: false });
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<WorkspaceSummary | undefined>(undefined);
  const [pendingDelete, setPendingDelete] = useState<WorkspaceSummary | undefined>(undefined);
  const [blocked, setBlocked] = useState<Blocked | undefined>(undefined);

  const workspaces = useQuery({
    queryKey: queryKeys.workspaces,
    queryFn: ({ signal }) => api.workspaces(signal),
  });

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.workspaces });
    // The session list is scoped by workspace, and a delete moves sessions.
    void queryClient.invalidateQueries({ queryKey: ['sessions'] });
  };

  const create = useMutation({
    mutationFn: (name: string) => api.createWorkspace(name),
    onSuccess: (created) => {
      setCreating(false);
      refresh();
      toast.success(`Created ${created.name}`);
    },
    onError: (error: Error) => {
      toast.error('Could not create it', error.message);
    },
  });

  const rename = useMutation({
    mutationFn: ({ id, name }: { readonly id: string; readonly name: string }) =>
      api.renameWorkspace(id, name),
    onSuccess: () => {
      setRenaming(undefined);
      refresh();
    },
    onError: (error: Error) => {
      toast.error('Could not rename it', error.message);
    },
  });

  const remove = useMutation({
    mutationFn: (workspace: WorkspaceSummary) => api.deleteWorkspace(workspace.id),
    onSuccess: (_result, workspace) => {
      // Moving off it first: staying on a workspace that no longer exists would
      // leave the Files page 404ing on every request.
      if (workspace.id === workspaceId) select(DEFAULT_WORKSPACE_ID);
      setPendingDelete(undefined);
      setBlocked(undefined);
      refresh();
      toast.success(`Removed ${workspace.name}`, 'Its folder and files are still on disk.');
    },
    onError: (error: Error, workspace) => {
      // The 409 is not a failure to report, it is a question to ask.
      const sessionCount = sessionCountOf(error);
      if (sessionCount !== undefined) {
        setPendingDelete(undefined);
        setBlocked({ workspace, sessionCount });
        return;
      }
      toast.error('Could not remove it', error.message);
    },
  });

  const move = useMutation({
    mutationFn: (workspace: WorkspaceSummary) =>
      api.moveWorkspaceSessions(workspace.id, DEFAULT_WORKSPACE_ID),
    onSuccess: (_result, workspace) => {
      remove.mutate(workspace);
    },
    onError: (error: Error) => {
      toast.error('Could not move the conversations', error.message);
    },
  });

  const all = workspaces.data?.workspaces ?? [];
  const rows = useMemo(
    () =>
      sortRows(
        filterRows(all, filter, (workspace) => workspace.name),
        sort,
        COMPARE,
        {
          // The default workspace holds every other one, so it is the parent of
          // the list rather than a peer in it. It stays at the top in both
          // directions for the same reason a directory does in Files.
          group: (workspace) => (workspace.isDefault ? 0 : 1),
          tiebreak: (a, b) => a.name.localeCompare(b.name),
        },
      ),
    [all, filter, sort],
  );

  const toggleSort = (key: SortKey): void => {
    setSort((current) => nextSort(current, key, ASCENDING_FIRST));
  };

  const now = Date.now();

  return (
    <div className="stack page page--wide">
      <div className="cluster page__header">
        <h1 className="page__title">Workspaces</h1>
        <span className="spacer" />
        <Button
          onClick={() => {
            setCreating(true);
          }}
        >
          <FolderPlus />
          New workspace
        </Button>
      </div>

      <div className="cluster list-toolbar">
        <p className="page__note">
          A workspace is a folder the agent works in. Default holds all the others, so it can reach
          their files; the named ones cannot reach each other.
        </p>
        <span className="spacer" />
        <SearchFilter value={filter} label="Filter workspaces by name" onValueChange={setFilter} />
      </div>

      {workspaces.isPending && <p className="page__note">Loading…</p>}
      {workspaces.isError && (
        <p role="alert" className="page__error">
          Could not load workspaces: {workspaces.error.message}
        </p>
      )}

      {workspaces.isSuccess &&
        (rows.length === 0 ? (
          <p className="page__note">
            Nothing here matches “{filter}”. {String(all.length)} hidden.
          </p>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <SortHeader label="Name" sortKey="name" sort={sort} onSort={toggleSort} />
                <SortHeader label="Chats" sortKey="sessions" sort={sort} onSort={toggleSort} />
                <SortHeader
                  label="Updated"
                  sortKey="updated"
                  sort={sort}
                  onSort={toggleSort}
                  className="data-table__modified"
                />
                <th scope="col" className="data-table__actions">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((workspace) => (
                <tr key={workspace.id}>
                  <td>
                    <span className="row workspace-row__name">
                      <span className="truncate">{workspace.name}</span>
                      {workspace.isDefault && <Badge>default</Badge>}
                    </span>
                  </td>
                  <td className="data-table__meta">{workspace.sessionCount}</td>
                  <td className="data-table__meta data-table__modified">
                    {formatRelativeTime(workspace.updatedAtMs, now)}
                  </td>
                  <td className="data-table__actions">
                    <RowActions label={workspace.name}>
                      <DropdownMenuItem
                        onSelect={() => {
                          setRenaming(workspace);
                        }}
                      >
                        <Pencil />
                        Rename
                      </DropdownMenuItem>
                      {/* The default is the parent of every other workspace;
                          there is no coherent thing removing it could mean. */}
                      {!workspace.isDefault && (
                        <DropdownMenuItem
                          className="menu__item--danger"
                          onSelect={() => {
                            setPendingDelete(workspace);
                          }}
                        >
                          <Trash2 />
                          Remove
                        </DropdownMenuItem>
                      )}
                    </RowActions>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ))}

      <NameDialog
        open={creating}
        onOpenChange={setCreating}
        title="New workspace"
        description="A name, not a path. The folder is created inside the workspace root and the id comes from the name."
        fieldLabel="Name"
        placeholder="Client Acme"
        pending={create.isPending}
        onSubmit={(name) => {
          create.mutate(name);
        }}
      />

      <NameDialog
        open={renaming !== undefined}
        onOpenChange={(open) => {
          if (!open) setRenaming(undefined);
        }}
        title="Rename workspace"
        description="The folder on disk keeps its own name — only the label changes."
        fieldLabel="Name"
        initialValue={renaming?.name ?? ''}
        submitLabel="Save"
        pending={rename.isPending}
        onSubmit={(name) => {
          if (renaming !== undefined) rename.mutate({ id: renaming.id, name });
        }}
      />

      <ConfirmDialog
        open={pendingDelete !== undefined}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(undefined);
        }}
        title="Remove this workspace?"
        description={`${pendingDelete?.name ?? ''} is detached from GhostAI. Its folder and everything in it stays on disk, and recreating it with the same name adopts the folder again.`}
        confirmLabel="Remove"
        pending={remove.isPending}
        onConfirm={() => {
          if (pendingDelete !== undefined) remove.mutate(pendingDelete);
        }}
      />

      <ConfirmDialog
        open={blocked !== undefined}
        onOpenChange={(open) => {
          if (!open) setBlocked(undefined);
        }}
        title="Move the conversations first?"
        description={
          blocked === undefined
            ? ''
            : `${String(blocked.sessionCount)} conversation${
                blocked.sessionCount === 1 ? '' : 's'
              } still belong to ${blocked.workspace.name}. Moving them to Default keeps their history; the files stay where they are either way.`
        }
        confirmLabel="Move and remove"
        tone="primary"
        pending={move.isPending || remove.isPending}
        onConfirm={() => {
          if (blocked !== undefined) move.mutate(blocked.workspace);
        }}
      />
    </div>
  );
}

/**
 * The count a 409 carried, if it is the one this page knows how to answer.
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
