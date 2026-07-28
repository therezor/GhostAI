/**
 * The file browser.
 *
 * It shows the workspace: the one tree the agent's filesystem tools may reach,
 * and therefore the one tree a reader needs to see to know what a turn actually
 * did. Every path in and out is workspace-relative, and nothing here decides
 * whether a path is legal — `WorkspaceJail` does that on the server, for every
 * caller, and a second copy of those rules in a React component would be a
 * weaker one that no security test reads.
 *
 * The decisions:
 *
 *  - **The directory is in the URL.** A file browser whose location lives in
 *    component state loses it on reload, cannot be linked, and turns the
 *    browser's own Back button into a way to leave the page entirely.
 *  - **Filter and sort are not.** They are how the current view is being read,
 *    not where the reader is, and a URL that changed on every keystroke would
 *    fill the history with states nobody wants to walk back through.
 *  - **Deleting asks first.** It is the only irreversible action in the UI, the
 *    server refuses to recurse into a directory, and there is no undo below
 *    this. A dialog is the cheapest possible guard against a misplaced click.
 *  - **So does closing an editor with unsaved edits**, for the same reason: a
 *    dialog closes on `Escape` and on an outside click, which are two ways to
 *    lose work by one keypress.
 *  - **Uploads name their destination explicitly.** `POST /api/files/upload`
 *    takes the full target path, so the file lands in the directory being
 *    looked at rather than wherever the server would have guessed — and a drop
 *    onto the listing is the same call as the button.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import {
  ArrowDown,
  ArrowUp,
  File as FileIcon,
  FilePlus,
  Folder,
  FolderPlus,
  Search,
  Trash2,
  Upload,
} from 'lucide-react';
import { useCallback, useMemo, useRef, useState, type DragEvent, type JSX } from 'react';

import type { FileEntry } from '@ghostai/protocol';

import { cn } from '@/lib/cn.js';
import { api } from '@/lib/api.js';
import { formatBytes, formatRelativeTime } from '@/lib/format.js';
import { queryKeys } from '@/lib/query.js';
import { Button } from '@/components/ui/button.js';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogHeading,
  DialogSubheading,
} from '@/components/ui/dialog.js';
import { Input } from '@/components/ui/field.js';
import { toast } from '@/components/ui/toast.js';
import { FilePreview } from '@/files/file-preview.js';
import { useWorkspace } from '@/workspaces/workspace-context.js';
import {
  breadcrumbs,
  DEFAULT_SORT,
  filterEntries,
  joinPath,
  normalisePath,
  ROOT_PATH,
  sortEntries,
  type SortKey,
  type SortOrder,
} from '@/files/paths.js';

/** What "New…" is being asked for. `undefined` means the dialog is closed. */
type NewKind = 'file' | 'directory';

export function FilesRoute(): JSX.Element {
  const { path, workspace: fromUrl } = useSearch({ from: '/files' });
  const { workspaceId } = useWorkspace();
  // The URL wins when it has one, so a link to a file is complete and
  // shareable — this page's own doctrine is that its location lives in the
  // address bar. The context is what the parameter defaults to.
  const workspace = fromUrl ?? workspaceId;
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const directory = normalisePath(path ?? ROOT_PATH);
  const [preview, setPreview] = useState<FileEntry | undefined>(undefined);
  const [previewDirty, setPreviewDirty] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<FileEntry | undefined>(undefined);
  const [creating, setCreating] = useState<NewKind | undefined>(undefined);
  const [filter, setFilter] = useState('');
  const [sort, setSort] = useState<SortOrder>(DEFAULT_SORT);
  const [dropping, setDropping] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const listing = useQuery({
    queryKey: queryKeys.files(workspace, directory),
    // `.` rather than `''` for the root: the query parameter's default only
    // applies when it is absent, so an empty string would reach the jail as one.
    queryFn: ({ signal }) =>
      api.files(workspace, directory === ROOT_PATH ? '.' : directory, signal),
  });

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.files(workspace, directory) });
  };

  const upload = useMutation({
    mutationFn: async (files: readonly File[]) => {
      // Sequential rather than `Promise.all`: the upload route has a body limit
      // per request and the workspace is a filesystem, so ten parallel writes
      // buy nothing and make a partial failure harder to report.
      for (const file of files) {
        await api.upload(workspace, joinPath(directory, file.name), file);
      }
      return files.length;
    },
    onSuccess: (count) => {
      toast.success(`Uploaded ${String(count)} file${count === 1 ? '' : 's'}`);
      refresh();
    },
    onError: (error: Error) => {
      toast.error('Upload failed', error.message);
    },
  });

  const remove = useMutation({
    // A directory always goes recursively, because the dialog behind this has
    // already said so and counted what it holds. The flag exists to stop a
    // *stray request* from recursing, not to make the UI ask twice.
    mutationFn: (entry: FileEntry) => api.deleteFile(workspace, entry.path, entry.isDirectory),
    onSuccess: (_result, entry) => {
      toast.success(`Deleted ${entry.name}`);
      setPendingDelete(undefined);
      refresh();
    },
    onError: (error: Error) => {
      toast.error('Could not delete it', error.message);
    },
  });

  /**
   * What the folder about to be deleted holds.
   *
   * Fetched when the dialog opens rather than listed up front: the count is the
   * one thing that turns "Delete drafts?" into a decision, and asking for it
   * per row would be one request per directory on every listing.
   */
  const pendingContents = useQuery({
    queryKey: queryKeys.files(workspace, pendingDelete?.path ?? ''),
    queryFn: ({ signal }) => api.files(workspace, pendingDelete?.path ?? '.', signal),
    enabled: pendingDelete?.isDirectory === true,
  });

  const create = useMutation({
    mutationFn: ({ kind, name }: { readonly kind: NewKind; readonly name: string }) => {
      const target = joinPath(directory, name.trim());
      // An empty file rather than a placeholder line: what the reader asked for
      // is a name to start typing under, and anything written into it is
      // content they did not write.
      return kind === 'file'
        ? api.writeText(workspace, target, '')
        : api.createDirectory(workspace, target);
    },
    onSuccess: (entry, { kind }) => {
      setCreating(undefined);
      refresh();
      toast.success(`Created ${entry.name}`);
      // Straight into it, which is the only reason to have made it.
      if (kind === 'file') setPreview(entry);
    },
    onError: (error: Error) => {
      toast.error('Could not create it', error.message);
    },
  });

  /** Stable, so the editor's `useEffect` does not re-fire on every render here. */
  const handleDirtyChange = useCallback((dirty: boolean) => {
    setPreviewDirty(dirty);
  }, []);

  const closePreview = (): void => {
    setPreview(undefined);
    setPreviewDirty(false);
    setDiscarding(false);
  };

  const entries = useMemo(
    () => sortEntries(filterEntries(listing.data?.entries ?? [], filter), sort),
    [listing.data, filter, sort],
  );

  const toggleSort = (key: SortKey): void => {
    setSort((current) =>
      current.key === key
        ? { key, descending: !current.descending }
        : // A new column starts in the order that column is usually read: names
          // from A, but sizes and times largest and newest first, because
          // "what is big" and "what just changed" are the questions being asked.
          { key, descending: key !== 'name' },
    );
  };

  const onDrop = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault();
    setDropping(false);
    const files = [...event.dataTransfer.files];
    if (files.length > 0) upload.mutate(files);
  };

  const now = Date.now();
  const total = listing.data?.entries.length ?? 0;

  return (
    <div className="stack page page--wide">
      <div className="cluster page__header">
        <h1 className="page__title">Files</h1>
        <span className="spacer" />
        <Button
          variant="ghost"
          onClick={() => {
            setCreating('file');
          }}
        >
          <FilePlus />
          New file
        </Button>
        <Button
          variant="ghost"
          onClick={() => {
            setCreating('directory');
          }}
        >
          <FolderPlus />
          New folder
        </Button>
        <Button
          disabled={upload.isPending}
          onClick={() => {
            fileInput.current?.click();
          }}
        >
          <Upload />
          {upload.isPending ? 'Uploading…' : 'Upload'}
        </Button>
        <input
          ref={fileInput}
          type="file"
          multiple
          aria-label="Upload files"
          className="sr-only"
          onChange={(event) => {
            const files = [...(event.target.files ?? [])];
            // Reset first: picking the same file twice in a row is otherwise
            // not a change event, and the second attempt does nothing at all.
            event.target.value = '';
            if (files.length > 0) upload.mutate(files);
          }}
        />
      </div>

      <div className="cluster file-toolbar">
        <Breadcrumbs
          path={directory}
          onNavigate={(next) => {
            setFilter('');
            void navigate({
              to: '/files',
              search: {
                ...(next === ROOT_PATH ? {} : { path: next }),
                workspace,
              },
            });
          }}
        />
        <span className="spacer" />
        <div className="row file-filter">
          <Search />
          <Input
            type="search"
            value={filter}
            aria-label="Filter by name"
            placeholder="Filter"
            onChange={(event) => {
              setFilter(event.target.value);
            }}
          />
        </div>
      </div>

      {listing.isPending && <p className="page__note">Loading…</p>}
      {listing.isError && (
        <p role="alert" className="page__error">
          Could not list this directory: {listing.error.message}
        </p>
      )}

      {listing.isSuccess && (
        <div
          className={cn('file-drop', dropping && 'file-drop--over')}
          onDragOver={(event) => {
            event.preventDefault();
            setDropping(true);
          }}
          onDragLeave={(event) => {
            // Only when the pointer actually left the region: `dragleave` also
            // fires crossing into a child, which would flicker the highlight
            // once per row the cursor passes over.
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
              setDropping(false);
            }
          }}
          onDrop={onDrop}
        >
          {total === 0 ? (
            <p className="page__note">This directory is empty. Drop a file here to upload it.</p>
          ) : entries.length === 0 ? (
            <p className="page__note">
              Nothing here matches “{filter}”. {String(total)} entries are hidden.
            </p>
          ) : (
            <table className="file-table">
              <thead>
                <tr>
                  <SortHeader label="Name" sortKey="name" sort={sort} onSort={toggleSort} />
                  <SortHeader label="Size" sortKey="size" sort={sort} onSort={toggleSort} />
                  <SortHeader
                    label="Modified"
                    sortKey="modified"
                    sort={sort}
                    onSort={toggleSort}
                    className="file-table__modified"
                  />
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => (
                  <tr key={entry.path}>
                    <td>
                      <button
                        type="button"
                        className={cn(
                          'file-table__open',
                          entry.isDirectory && 'file-table__open--directory',
                        )}
                        onClick={() => {
                          if (entry.isDirectory) {
                            setFilter('');
                            void navigate({
                              to: '/files',
                              search: { path: entry.path, workspace },
                            });
                          } else {
                            setPreview(entry);
                          }
                        }}
                      >
                        {entry.isDirectory ? <Folder /> : <FileIcon />}
                        <span className="truncate">{entry.name}</span>
                      </button>
                    </td>
                    <td className="file-table__meta">
                      {entry.isDirectory ? '—' : formatBytes(entry.sizeBytes)}
                    </td>
                    <td className="file-table__meta file-table__modified">
                      {formatRelativeTime(entry.modifiedAtMs, now)}
                    </td>
                    <td className="file-table__actions">
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Delete ${entry.name}`}
                        onClick={() => {
                          setPendingDelete(entry);
                        }}
                      >
                        <Trash2 />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      <Dialog
        open={preview !== undefined}
        onOpenChange={(open) => {
          if (open) return;
          // The one thing here that can lose work. `Escape` and a click on the
          // overlay both arrive as this, so the guard has to live at the point
          // the dialog closes rather than on a button.
          if (previewDirty) setDiscarding(true);
          else closePreview();
        }}
      >
        <DialogContent className="dialog--preview">
          <DialogHeader>
            <DialogHeading>{preview?.name ?? ''}</DialogHeading>
            <DialogSubheading>{preview?.path ?? ''}</DialogSubheading>
          </DialogHeader>
          {preview !== undefined && (
            <FilePreview entry={preview} workspace={workspace} onDirtyChange={handleDirtyChange} />
          )}
        </DialogContent>
      </Dialog>

      <Dialog
        open={discarding}
        onOpenChange={(open) => {
          if (!open) setDiscarding(false);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogHeading>Discard your edits?</DialogHeading>
            <DialogSubheading>
              {preview?.path ?? ''} has changes that were never saved. Closing loses them.
            </DialogSubheading>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => {
                setDiscarding(false);
              }}
            >
              Keep editing
            </Button>
            <Button variant="danger" onClick={closePreview}>
              Discard
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <NewEntryDialog
        kind={creating}
        directory={directory}
        pending={create.isPending}
        onCancel={() => {
          setCreating(undefined);
        }}
        onCreate={(name) => {
          if (creating !== undefined) create.mutate({ kind: creating, name });
        }}
      />

      <Dialog
        open={pendingDelete !== undefined}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(undefined);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogHeading>
              {pendingDelete?.isDirectory === true ? 'Delete this folder?' : 'Delete this file?'}
            </DialogHeading>
            <DialogSubheading>
              {pendingDelete?.path ?? ''} is removed from the workspace. There is no undo.
            </DialogSubheading>
          </DialogHeader>

          {/* The count is what makes this a decision rather than a reflex:
              "Delete drafts?" and "Delete drafts and the 47 things in it?" are
              different questions, and only one of them is the one being asked. */}
          {pendingDelete?.isDirectory === true && pendingContents.isSuccess && (
            <p
              className={cn('notice', pendingContents.data.entries.length > 0 && 'notice--danger')}
            >
              <Trash2 />
              <span>
                {pendingContents.data.entries.length === 0
                  ? 'This folder is empty.'
                  : `Everything inside goes with it — ${String(
                      pendingContents.data.entries.length,
                    )} item${pendingContents.data.entries.length === 1 ? '' : 's'}.`}
              </span>
            </p>
          )}

          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => {
                setPendingDelete(undefined);
              }}
            >
              Cancel
            </Button>
            <Button
              variant="danger"
              disabled={remove.isPending}
              onClick={() => {
                if (pendingDelete !== undefined) remove.mutate(pendingDelete);
              }}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * A column heading that is also the control that sorts by it.
 *
 * `aria-sort` on the `<th>` and a real `<button>` inside it, rather than a
 * click handler on the cell: the sort state has to be announced, and a heading
 * that sorts on click but not on `Enter` is a control a keyboard cannot reach.
 */
function SortHeader({
  label,
  sortKey,
  sort,
  onSort,
  className,
}: {
  readonly label: string;
  readonly sortKey: SortKey;
  readonly sort: SortOrder;
  readonly onSort: (key: SortKey) => void;
  readonly className?: string;
}): JSX.Element {
  const active = sort.key === sortKey;

  return (
    <th
      scope="col"
      className={className}
      aria-sort={active ? (sort.descending ? 'descending' : 'ascending') : 'none'}
    >
      <button
        type="button"
        className="file-table__sort"
        onClick={() => {
          onSort(sortKey);
        }}
      >
        {label}
        {active && (sort.descending ? <ArrowDown /> : <ArrowUp />)}
      </button>
    </th>
  );
}

/**
 * Naming a new file or directory.
 *
 * A `<form>`, so `Enter` submits — which is the only interaction anybody wants
 * from a one-field dialog. Nothing here validates the name: a separator or a
 * traversal in it is the jail's call, on the server, and the error comes back
 * as the toast any other refusal would.
 */
function NewEntryDialog({
  kind,
  directory,
  pending,
  onCancel,
  onCreate,
}: {
  readonly kind: NewKind | undefined;
  readonly directory: string;
  readonly pending: boolean;
  readonly onCancel: () => void;
  readonly onCreate: (name: string) => void;
}): JSX.Element {
  const [name, setName] = useState('');
  const isFile = kind === 'file';

  return (
    <Dialog
      open={kind !== undefined}
      onOpenChange={(open) => {
        if (!open) {
          setName('');
          onCancel();
        }
      }}
    >
      <DialogContent>
        <form
          className="stack"
          onSubmit={(event) => {
            event.preventDefault();
            if (name.trim() !== '') onCreate(name);
          }}
        >
          <DialogHeader>
            <DialogHeading>{isFile ? 'New file' : 'New folder'}</DialogHeading>
            <DialogSubheading>
              Created in {directory === ROOT_PATH ? 'the workspace root' : directory}.
            </DialogSubheading>
          </DialogHeader>

          <Input
            autoFocus
            value={name}
            aria-label={isFile ? 'File name' : 'Folder name'}
            placeholder={isFile ? 'notes.md' : 'drafts'}
            onChange={(event) => {
              setName(event.target.value);
            }}
          />

          <DialogFooter>
            <Button variant="ghost" type="button" onClick={onCancel}>
              Cancel
            </Button>
            <Button variant="primary" type="submit" disabled={pending || name.trim() === ''}>
              Create
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Breadcrumbs({
  path,
  onNavigate,
}: {
  readonly path: string;
  readonly onNavigate: (path: string) => void;
}): JSX.Element {
  const crumbs = breadcrumbs(path);

  return (
    <nav aria-label="Breadcrumb">
      <ol className="breadcrumbs">
        {crumbs.map((crumb, index) => {
          const last = index === crumbs.length - 1;
          return (
            <li key={crumb.path}>
              {index > 0 && <span className="breadcrumbs__separator">/</span>}
              {last ? (
                // The current directory is text, not a link to itself.
                <span aria-current="page" className="breadcrumbs__current">
                  {crumb.label}
                </span>
              ) : (
                <button
                  type="button"
                  className="breadcrumbs__link"
                  onClick={() => {
                    onNavigate(crumb.path);
                  }}
                >
                  {crumb.label}
                </button>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
