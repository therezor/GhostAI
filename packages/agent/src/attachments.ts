/**
 * Turning attached files into something a model can actually read.
 *
 * A `FilePart` is a reference — a workspace path and a MIME type — because that
 * is the only form of an attachment that survives being stored. The two
 * alternatives both rot: a signed URL is dead ten minutes later, and inline
 * base64 puts a megabyte in `payload_json` that every replay of that
 * conversation then carries forever. So the bytes are read here instead, once
 * per request, from the jail the turn is already holding.
 *
 * Three ideas are load-bearing.
 *
 *  - **The path goes to the model even when the bytes do too.** An image the
 *    model can see is still a file it may want to crop, convert or measure, and
 *    a 30 MB video is nothing *but* a path. One header line before every
 *    attachment means "use a tool on this" is always available, so the failure
 *    mode of every cap below is degraded rather than blank.
 *
 *  - **"Is it text" is answered by the bytes, never by the MIME type.**
 *    `mimeTypeFor` calls `.py`, `.ts` and `.yaml` `application/octet-stream` —
 *    its table is deliberately small — and those are exactly the files someone
 *    attaches to an agent. `readText`'s NUL-byte check gets them right.
 *
 *  - **The contents are not wrapped in the tool-output nonce.** An attachment
 *    arrives with the message a person typed and carries that message's trust
 *    level; fencing it as untrusted would tell the model to discount the thing
 *    the user just handed it. That is a deliberate difference from tool output,
 *    which comes from the network and does get wrapped. See the path guard
 *    below for what stops it from being a way to read arbitrary files.
 */

import { readFileSync, statSync } from 'node:fs';

import {
  DEFAULT_MIME_TYPE,
  filePart,
  imagePart,
  mimeTypeFor,
  readText,
  textPart,
} from '@ghostai/core';
import type { ChatMessage, ContentPart, FilePart } from '@ghostai/protocol';
import type { WorkspaceJail } from '@ghostai/security';
import { formatBytes } from '@ghostai/tools';

/**
 * The largest image sent inline, as base64.
 *
 * Below every mainstream provider's per-image limit, and the encoding costs a
 * third on top — so this is ~5.5 MB on the wire, per iteration, for as long as
 * the attachment stays in the context window. A photo from a phone fits; a
 * screen recording does not, and becomes a path.
 */
export const MAX_INLINE_IMAGE_BYTES: number = 4 * 1024 * 1024;

/**
 * The most file text pasted into a request.
 *
 * Not `MAX_TEXT_BYTES` (512 KiB), which is sized for a human scrolling an
 * editor: 512 KiB of prose is well over 100k tokens, so one attachment could
 * fill a context window on its own. 32 KiB is a long source file or a few
 * thousand CSV rows, and it keeps the drift in the context meter — which sizes
 * the *stored* `FilePart`, not this — small enough to ignore.
 */
export const MAX_INLINE_TEXT_BYTES: number = 32 * 1024;

/**
 * The most bytes one request will inline across *all* its attachments.
 *
 * The per-file caps above bound one read; this bounds the request, and without
 * it they do not compose. History keeps hundreds of messages and each is
 * re-materialised on every iteration, so a frame carrying one small image a few
 * thousand times — the same path, well under the upload limit — expands to
 * thousands of base64 blocks that `JSON.stringify` then has to serialise into
 * one body. Past this budget attachments still appear, as their path: degraded,
 * which is the whole failure model here, rather than an out-of-memory kill.
 */
export const MAX_TOTAL_INLINE_BYTES: number = 16 * 1024 * 1024;

export interface MaterialiseOptions {
  readonly maxImageBytes?: number;
  readonly maxTextBytes?: number;
  readonly maxTotalBytes?: number;
  /**
   * Whether images may be inlined at all. Defaults to yes.
   *
   * `false` is the agent's `visionEnabled` switched off, and it lands here
   * rather than anywhere downstream because this is the only place an
   * `ImagePart` is produced for a request. It is not a cap — the size the
   * attachment happens to be is irrelevant — so it is answered before the two
   * byte checks and never touches the shared budget.
   */
  readonly images?: boolean;
}

/**
 * A cache of already-read attachments, scoped to one turn.
 *
 * The loop rebuilds the request on every iteration, so a six-tool turn would
 * otherwise read and base64 the same image six times.
 *
 * Keyed by the resolved path, size *and* mtime, so an attachment the agent
 * rewrote mid-turn is read again rather than served from before its own edit —
 * which would leave the model holding two versions of one file in a single
 * context window, with nothing to say which is current. The stat that produces
 * the key runs every iteration; it is the read and the base64 encode that this
 * saves, and those are the expensive half by orders of magnitude.
 */
export type AttachmentCache = Map<string, readonly ContentPart[]>;

/** How much of the request's inline budget is left. Mutable, one per call. */
interface Budget {
  remaining: number;
}

/**
 * The one line that precedes every attachment, whatever else follows it.
 *
 * `formatBytes` is the tools' own, not a local copy: the model reads this and
 * `list_dir`'s output in the same context window, and two spellings of "4.2 KB"
 * is a difference it would be entitled to read meaning into.
 */
function header(path: string, mimeType: string, sizeBytes: number): string {
  return `[attachment: ${path} · ${mimeType} · ${formatBytes(sizeBytes)}]`;
}

/**
 * The absolute path of an attachment, or `undefined` if it is not addressable.
 *
 * `check`, and a refusal on any rewrite. The jail *clamps* traversal rather
 * than refusing it — `../../etc/passwd` becomes `etc/passwd` inside the
 * workspace — which is right for a model that guessed at a path and wrong here:
 * this path came off a client frame, and a clamp would silently read a
 * different file than the one named while looking like a success. A genuine
 * upload path never contains `..`, so refusing costs nothing.
 */
function locate(
  part: FilePart,
  jail: WorkspaceJail,
): { readonly absolute: string; readonly relative: string } | undefined {
  // A control character in the path would be interpolated straight into the
  // prompt by `header`, where a newline forges the boundary between one
  // attachment's line and the next. `safeName` in the composer already reduces
  // an upload to `[\w.-]`, but this path arrives on a socket frame — and the
  // channel `attach` port sketched in `@ghostai/channels` will one day carry a
  // filename chosen by whoever sent the message. No real path has one.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(part.path)) return undefined;

  const verdict = jail.check(part.path);
  if (!verdict.ok || verdict.rewrites.length > 0) return undefined;
  // The jail's own relative form, not the requested string. They agree on any
  // path the composer produced, but `./uploads/x.png` normalises without being
  // recorded as a rewrite — and the path shown to the model has to be the one
  // `read_file` and `list_dir` will echo back, or it learns two names for one
  // file.
  //
  // One shape the jail does normalise silently: it treats `\` as a separator
  // with no rewrite recorded, so `a\b.txt` — a legal POSIX filename — resolves
  // as `a/b.txt`. Showing `verdict.relative` rather than `part.path` is what
  // keeps that honest: the model is told the path that was actually read.
  return { absolute: verdict.path, relative: verdict.relative };
}

/**
 * One `FilePart`, as the provider can read it. Never returns a `file` part.
 *
 * Note what the failure branch does *not* say: it names the attachment by the
 * path that was asked for only when that path was legal. A rejected path is
 * reported without echoing it, for the same reason `read_file` reports where a
 * read landed rather than what was requested — repeating it back would teach
 * the model that the workspace has paths it does not have.
 */
export function materialiseFilePart(
  part: FilePart,
  jail: WorkspaceJail,
  options: MaterialiseOptions = {},
  cache?: AttachmentCache,
  budget: Budget = {
    remaining: options.maxTotalBytes ?? MAX_TOTAL_INLINE_BYTES,
  },
): readonly ContentPart[] {
  const maxImageBytes = options.maxImageBytes ?? MAX_INLINE_IMAGE_BYTES;
  const maxTextBytes = options.maxTextBytes ?? MAX_INLINE_TEXT_BYTES;

  const found = locate(part, jail);
  if (found === undefined) {
    return [
      textPart(
        '[attachment: unavailable — the path is not inside this workspace]',
      ),
    ];
  }
  const { absolute, relative } = found;

  // The size on disk, never `part.sizeBytes`: that arrived on a client frame,
  // and every cap below is a memory bound.
  let sizeBytes: number;
  let mtimeMs: number;
  try {
    const stats = statSync(absolute);
    if (stats.isDirectory()) {
      return [textPart(`[attachment: ${relative} — a directory, not a file]`)];
    }
    sizeBytes = stats.size;
    mtimeMs = stats.mtimeMs;
  } catch {
    return [textPart(`[attachment: ${relative} — no longer in the workspace]`)];
  }

  // Derived from the path, not taken from the part. This one value decides
  // whether the file is read as an image or as text, and `part.mimeType` came
  // off a client frame — a text file labelled `image/png` would be base64'd and
  // sent to a vision model as garbage. The table's answer is the same one the
  // upload route recorded, and it falls back to the part only where the table
  // has nothing, so a channel that knows better is not overruled.
  const derived = mimeTypeFor(relative);
  const mimeType = derived === DEFAULT_MIME_TYPE ? part.mimeType : derived;
  const line = header(relative, mimeType, sizeBytes);

  if (sizeBytes === 0) return [textPart(`${line} — the file is empty`)];

  // Identity is path, size and mtime together: a file the agent rewrote
  // mid-turn has to be read again, or the model holds the version from before
  // its own edit beside the one `read_file` just returned.
  // Size and mtime lead so the delimiter needs no NUL: both are digits, and
  // the first `:` after them ends the number. A raw NUL in a source file is
  // a real cost -- it makes the whole file invisible to `grep`.
  const key = `${String(sizeBytes)}:${String(mtimeMs)}:${absolute}`;
  const cached = cache?.get(key);
  if (cached !== undefined) return cached;

  const remember = (parts: readonly ContentPart[]): readonly ContentPart[] => {
    cache?.set(key, parts);
    return parts;
  };

  // An image is inlined as an image or named as a path, and never falls through
  // to the text branch below. Nothing rules out a small uncompressed image
  // holding no NUL byte, and `readText` would then happily fence a screenful of
  // binary as if it were the file's contents.
  if (mimeType.startsWith('image/')) {
    // Before the byte checks and before the budget, because this is not a cap:
    // the model cannot read an image of any size, so spending budget on one
    // would take room away from the text attachments it *can* read.
    if (options.images === false) {
      return remember([
        textPart(`${line} — this model cannot read images; use the file tools`),
      ]);
    }
    if (sizeBytes > maxImageBytes) {
      return remember([
        textPart(`${line} — too large to show; use the file tools to read it`),
      ]);
    }
    if (sizeBytes > budget.remaining) {
      return remember([
        textPart(`${line} — not shown inline; use the file tools to read it`),
      ]);
    }
    budget.remaining -= sizeBytes;
    try {
      // `data`, never `url`: it works offline, works on every provider, needs
      // no second round trip out of our own network, and cannot expire.
      const data = readFileSync(absolute).toString('base64');
      return remember([textPart(line), imagePart(mimeType, { data })]);
    } catch {
      return remember([textPart(`${line} — could not be read`)]);
    }
  }

  if (sizeBytes <= maxTextBytes && sizeBytes <= budget.remaining) {
    let text;
    try {
      text = readText(absolute, sizeBytes);
    } catch {
      return remember([textPart(`${line} — could not be read`)]);
    }
    if (text !== undefined) {
      budget.remaining -= sizeBytes;
      const note = text.truncated
        ? '\n\n[…truncated — read the file for the rest]'
        : '';
      return remember([
        textPart(`${line}\n\n\`\`\`\n${text.content}\n\`\`\`${note}`),
      ]);
    }
  }

  return remember([
    textPart(`${line} — not shown inline; use the file tools to read it`),
  ]);
}

/**
 * A legacy image part that no provider can fetch.
 *
 * Before attachments were workspace files, the web put a *relative* signed URL
 * here — `/api/media/<token>` — which every provider silently failed on and
 * which the degradation ladder then stripped, so the turn appeared to succeed
 * without the image. Those rows are still in storage. Nothing rewrites history,
 * but there is no reason to keep paying a guaranteed 4xx and a retry for them
 * on every iteration of every turn.
 */
function isUnfetchable(part: ContentPart): boolean {
  if (part.type !== 'image') return false;
  if (part.data !== undefined) return false;
  return part.url === undefined || !/^[a-z][a-z0-9+.-]*:/i.test(part.url);
}

function materialiseContent(
  content: readonly ContentPart[],
  jail: WorkspaceJail,
  options: MaterialiseOptions,
  cache: AttachmentCache | undefined,
  budget: Budget,
): readonly ContentPart[] | undefined {
  if (!content.some((part) => part.type === 'file' || isUnfetchable(part))) {
    return undefined;
  }

  const parts: ContentPart[] = [];
  for (const part of content) {
    if (part.type === 'file') {
      parts.push(...materialiseFilePart(part, jail, options, cache, budget));
      continue;
    }
    if (isUnfetchable(part)) {
      parts.push(
        textPart(
          '[image: unavailable — this attachment predates workspace attachments]',
        ),
      );
      continue;
    }
    parts.push(part);
  }
  return parts;
}

/**
 * Every message's content, with `file` parts replaced by what a provider reads.
 *
 * Returns the same array when there is nothing to do, which is the common case:
 * most turns have no attachments anywhere in their history, and this runs on
 * every iteration of every one of them.
 */
export function materialiseAttachments(
  messages: readonly ChatMessage[],
  jail: WorkspaceJail,
  options: MaterialiseOptions = {},
  cache?: AttachmentCache,
): readonly ChatMessage[] {
  const out: ChatMessage[] = [];
  let changed = false;
  // One budget for the whole request. The per-file caps bound a single read;
  // only this bounds the request, and without it they do not compose.
  const budget: Budget = {
    remaining: options.maxTotalBytes ?? MAX_TOTAL_INLINE_BYTES,
  };

  for (const message of messages) {
    if (message.role === 'system' || message.role === 'tool') {
      out.push(message);
      continue;
    }
    const content = materialiseContent(
      message.content,
      jail,
      options,
      cache,
      budget,
    );
    if (content === undefined) {
      out.push(message);
      continue;
    }
    changed = true;
    out.push({ ...message, content: [...content] });
  }

  return changed ? out : messages;
}

/** Re-exported so a caller can build the reference this module consumes. */
export { filePart };
