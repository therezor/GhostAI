/**
 * Reading workspace files: what type a file is, and whether it is text.
 *
 * Here rather than in `@ghostwire/server`, where both of these used to live,
 * because the agent loop needs them too. An attached file has to be turned into
 * something a model can read — bytes for an image, characters for a `.csv` —
 * and that decision has to come out the same way whether it is being made to
 * answer `GET /api/files/text` or to build a provider request. Two copies of
 * the MIME table is two answers to "is this an image".
 *
 * The MIME table is small and deliberately so. It exists to make a browser
 * render an image inline, not to be a complete registry, and a type it does not
 * know becomes `application/octet-stream` — which downloads rather than
 * executes. The corollary matters more than the table does: **it answers
 * `application/octet-stream` for `.py`, `.ts` and `.yaml`**, so nothing may use
 * it to decide whether a file is text. That is `readText`'s job, and it reads
 * the bytes.
 */

import { closeSync, openSync, readSync } from 'node:fs';
import { extname } from 'node:path';

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

export const DEFAULT_MIME_TYPE = 'application/octet-stream';

export function mimeTypeFor(path: string): string {
  return MIME_TYPES[extname(path).toLowerCase()] ?? DEFAULT_MIME_TYPE;
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
export function readText(
  absolutePath: string,
  sizeBytes: number,
): WorkspaceText | undefined {
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
  return {
    content: new TextDecoder('utf-8').decode(bytes),
    truncated: sizeBytes > cap,
  };
}
