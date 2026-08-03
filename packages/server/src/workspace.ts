/**
 * Reading the workspace over HTTP.
 *
 * Every path in this module has already been through `WorkspaceJail`, and none
 * of it re-derives one: the jail returns the canonical absolute path it actually
 * verified, and using anything else — re-joining the input, resolving it a second
 * time — is how a check and the filesystem call it guards end up looking at two
 * different files.
 *
 * `mimeTypeFor` and `readText` moved down to `@ghostai/core` and are re-exported
 * here so this module stays the one place the HTTP layer imports from. They had
 * to move: the agent loop turns an attached file into something a model can read
 * and has to reach the same verdict this route does, and `@ghostai/agent` cannot
 * import a server.
 */

import { readdirSync, statSync, type Stats } from 'node:fs';
import { basename, extname, join, relative } from 'node:path';

import { mimeTypeFor } from '@ghostai/core';
import type { FileEntry } from '@ghostai/protocol';
import type { WorkspaceJail } from '@ghostai/security';

export {
  DEFAULT_MIME_TYPE,
  MAX_TEXT_BYTES,
  mimeTypeFor,
  readText,
  type WorkspaceText,
} from '@ghostai/core';

/**
 * Types a browser executes in the origin that served them.
 *
 * An SVG is a document: it can carry `<script>`, and served as `image/svg+xml`
 * from this origin that script runs with the session cookie attached. The
 * workspace is a tree a language model writes to, so "the agent wrote a file the
 * user then opened" is a realistic path to it rather than a contrived one.
 * These are served as a download instead — the file is still retrievable, it
 * simply does not execute.
 */
const NEVER_INLINE: ReadonlySet<string> = new Set([
  '.svg',
  '.html',
  '.htm',
  '.xhtml',
  '.xml',
  '.js',
  '.mjs',
  '.wasm',
]);

/** Whether a browser may render this file in the page rather than download it. */
export function inlineSafe(path: string): boolean {
  return !NEVER_INLINE.has(extname(path).toLowerCase());
}

/** One entry, for a path a caller already has stats for. */
export function entryAt(
  jail: WorkspaceJail,
  absolutePath: string,
  stats: Stats,
): FileEntry {
  return entryFor(jail, absolutePath, basename(absolutePath), stats);
}

function entryFor(
  jail: WorkspaceJail,
  absolutePath: string,
  name: string,
  stats: Stats,
): FileEntry {
  const isDirectory = stats.isDirectory();
  return {
    // Workspace-relative, always: an absolute path in a response tells a client
    // where the server keeps its files, and nothing above this layer can use one.
    path: jail.relative(absolutePath),
    name,
    isDirectory,
    sizeBytes: isDirectory ? 0 : stats.size,
    modifiedAtMs: Math.floor(stats.mtimeMs),
    ...(isDirectory ? {} : { mimeType: mimeTypeFor(absolutePath) }),
  };
}

/**
 * One directory, directories first and then by name.
 *
 * Not recursive, and not sorted by mtime: a file browser is navigated, and the
 * order a navigator needs is the one that does not move when a file is written.
 *
 * Every entry goes back through `jail.check`, which is what drops a symlink
 * pointing out of the workspace. `contains` would not: it compares the path as
 * written, and `<workspace>/escape → /etc` has a perfect prefix. Listing it
 * would advertise a file the jail then refuses to open, which reads as a bug in
 * the UI rather than as the refusal it is.
 */
export function listDirectory(
  jail: WorkspaceJail,
  directory: string,
): FileEntry[] {
  const entries: FileEntry[] = [];

  for (const dirent of readdirSync(directory, { withFileTypes: true })) {
    const verdict = jail.check(
      relative(jail.root, join(directory, dirent.name)),
    );
    if (!verdict.ok) continue;

    let stats: Stats;
    try {
      // The canonical path the jail verified, not one re-derived from the name.
      stats = statSync(verdict.path);
    } catch {
      // A file deleted between `readdir` and `stat` — a turn cleaning up while
      // the panel refreshes. One missing row beats a failed listing.
      continue;
    }
    entries.push(entryFor(jail, verdict.path, dirent.name, stats));
  }

  return entries.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}
