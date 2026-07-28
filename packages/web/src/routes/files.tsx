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
 * Three decisions:
 *
 *  - **The directory is in the URL.** A file browser whose location lives in
 *    component state loses it on reload, cannot be linked, and turns the
 *    browser's own Back button into a way to leave the page entirely.
 *  - **Deleting asks first.** It is the only irreversible action in the UI, the
 *    server refuses to recurse into a directory, and there is no undo below
 *    this. A dialog is the cheapest possible guard against a misplaced click.
 *  - **Uploads name their destination explicitly.** `POST /api/files/upload`
 *    takes the full target path, so the file lands in the directory being
 *    looked at rather than wherever the server would have guessed.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { File as FileIcon, Folder, Trash2, Upload } from 'lucide-react';
import { useRef, useState, type JSX } from 'react';

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
import { toast } from '@/components/ui/toast.js';
import { FilePreview } from '@/files/file-preview.js';
import { breadcrumbs, joinPath, normalisePath, ROOT_PATH } from '@/files/paths.js';

export function FilesRoute(): JSX.Element {
  const { path } = useSearch({ from: '/files' });
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const directory = normalisePath(path ?? ROOT_PATH);
  const [preview, setPreview] = useState<FileEntry | undefined>(undefined);
  const [pendingDelete, setPendingDelete] = useState<FileEntry | undefined>(undefined);
  const fileInput = useRef<HTMLInputElement>(null);

  const listing = useQuery({
    queryKey: queryKeys.files(directory),
    // `.` rather than `''` for the root: the query parameter's default only
    // applies when it is absent, so an empty string would reach the jail as one.
    queryFn: ({ signal }) => api.files(directory === ROOT_PATH ? '.' : directory, signal),
  });

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.files(directory) });
  };

  const upload = useMutation({
    mutationFn: async (files: readonly File[]) => {
      // Sequential rather than `Promise.all`: the upload route has a body limit
      // per request and the workspace is a filesystem, so ten parallel writes
      // buy nothing and make a partial failure harder to report.
      for (const file of files) {
        await api.upload(joinPath(directory, file.name), file);
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
    mutationFn: (entry: FileEntry) => api.deleteFile(entry.path),
    onSuccess: (_result, entry) => {
      toast.success(`Deleted ${entry.name}`);
      setPendingDelete(undefined);
      refresh();
    },
    onError: (error: Error) => {
      toast.error('Could not delete the file', error.message);
    },
  });

  const now = Date.now();

  return (
    <div className="stack page page--wide">
      <div className="cluster page__header">
        <h1 className="page__title">Files</h1>
        <span className="spacer" />
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

      <Breadcrumbs
        path={directory}
        onNavigate={(next) => {
          void navigate({ to: '/files', search: next === ROOT_PATH ? {} : { path: next } });
        }}
      />

      {listing.isPending && <p className="page__note">Loading…</p>}
      {listing.isError && (
        <p role="alert" className="page__error">
          Could not list this directory: {listing.error.message}
        </p>
      )}

      {listing.isSuccess &&
        (listing.data.entries.length === 0 ? (
          <p className="page__note">This directory is empty.</p>
        ) : (
          <table className="file-table">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Size</th>
                <th scope="col" className="file-table__modified">
                  Modified
                </th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {listing.data.entries.map((entry) => (
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
                          void navigate({ to: '/files', search: { path: entry.path } });
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
                    {!entry.isDirectory && (
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
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ))}

      <Dialog
        open={preview !== undefined}
        onOpenChange={(open) => {
          if (!open) setPreview(undefined);
        }}
      >
        <DialogContent className="dialog--preview">
          <DialogHeader>
            <DialogHeading>{preview?.name ?? ''}</DialogHeading>
            <DialogSubheading>{preview?.path ?? ''}</DialogSubheading>
          </DialogHeader>
          {preview !== undefined && <FilePreview entry={preview} />}
        </DialogContent>
      </Dialog>

      <Dialog
        open={pendingDelete !== undefined}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(undefined);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogHeading>Delete this file?</DialogHeading>
            <DialogSubheading>
              {pendingDelete?.path ?? ''} is removed from the workspace. There is no undo.
            </DialogSubheading>
          </DialogHeader>
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
