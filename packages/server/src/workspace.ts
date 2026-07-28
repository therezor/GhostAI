/**
 * Reading the workspace over HTTP.
 *
 * Every path in this module has already been through `WorkspaceJail`, and none
 * of it re-derives one: the jail returns the canonical absolute path it actually
 * verified, and using anything else — re-joining the input, resolving it a second
 * time — is how a check and the filesystem call it guards end up looking at two
 * different files.
 *
 * The MIME table is small and deliberately so. It exists to make a browser
 * render an image inline, not to be a complete registry, and a type this table
 * does not know becomes `application/octet-stream` — which downloads rather than
 * executes.
 */

import { closeSync, openSync, readdirSync, readSync, statSync, type Stats } from 'node:fs';
import { basename, extname, join, relative } from 'node:path';

import type { FileEntry } from '@ghostai/protocol';
import type { WorkspaceJail } from '@ghostai/security';

/** Extension → MIME type, for the types a chat UI actually renders. */
const MIME_TYPES: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

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

export const DEFAULT_MIME_TYPE = 'application/octet-stream';

export function mimeTypeFor(path: string): string {
  return MIME_TYPES[extname(path).toLowerCase()] ?? DEFAULT_MIME_TYPE;
}

/** Whether a browser may render this file in the page rather than download it. */
export function inlineSafe(path: string): boolean {
  return !NEVER_INLINE.has(extname(path).toLowerCase());
}

/** One entry, for a path a caller already has stats for. */
export function entryAt(jail: WorkspaceJail, absolutePath: string, stats: Stats): FileEntry {
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
export function listDirectory(jail: WorkspaceJail, directory: string): FileEntry[] {
  const entries: FileEntry[] = [];

  for (const dirent of readdirSync(directory, { withFileTypes: true })) {
    const verdict = jail.check(relative(jail.root, join(directory, dirent.name)));
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

/**
 * The most bytes a text read returns.
 *
 * A workspace holds whatever the agent wrote to it, and "open the 400 MB log
 * the last turn produced" must not be a way to make the server allocate 400 MB
 * or the tab freeze rendering it. Past this the read returns a prefix and says
 * so, and the editor goes read-only — a saved prefix would delete the rest.
 */
export const MAX_TEXT_BYTES: number = 512 * 1024;

export interface WorkspaceText {
  readonly content: string;
  readonly truncated: boolean;
}

/**
 * One file as text, or `undefined` when the bytes are not text.
 *
 * "Not text" is a NUL byte in the prefix — the same heuristic `git` uses, and
 * for the same reason: it is the one signal that costs nothing and is almost
 * never wrong about a real file. The alternative, trusting the extension, is
 * wrong in both directions here, because the MIME table above is deliberately
 * small and answers `application/octet-stream` for `.py`, `.ts` and every other
 * source file a person would actually want to open.
 *
 * Only the first `MAX_TEXT_BYTES` are read, not the whole file and then a
 * slice: the size is whatever the agent wrote, and `readFileSync` on it is the
 * allocation this exists to avoid.
 */
export function readText(absolutePath: string, sizeBytes: number): WorkspaceText | undefined {
  const cap = Math.min(sizeBytes, MAX_TEXT_BYTES);
  const buffer = Buffer.alloc(cap);

  const descriptor = openSync(absolutePath, 'r');
  let filled = 0;
  try {
    while (filled < cap) {
      const read = readSync(descriptor, buffer, filled, cap - filled, filled);
      if (read === 0) break;
      filled += read;
    }
  } finally {
    closeSync(descriptor);
  }

  const bytes = buffer.subarray(0, filled);
  if (bytes.includes(0)) return undefined;

  // Lossy on purpose. A cut at `MAX_TEXT_BYTES` can land mid-codepoint, which
  // costs one replacement character at the very end of content that is already
  // read-only for being truncated. A fatal decoder would turn that into a
  // failure to open the file at all.
  return { content: new TextDecoder('utf-8').decode(bytes), truncated: sizeBytes > cap };
}
