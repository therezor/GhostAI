/**
 * Turning `node:fs` failures into something a model can act on.
 *
 * A raw `ENOENT: no such file or directory, open '/Users/x/.ghostai/workspace/notes.md'`
 * is wrong for this surface twice over. It reports an absolute path, when the
 * tool contract the model was given is workspace-relative — so the model's next
 * call tends to copy the absolute form straight back and be rejected by the
 * jail. And it carries a `kind` of `tool`, when `not_found` and
 * `permission_denied` are distinctions the agent loop and the audit log both
 * care about.
 */

import { GhostError, isAbortError, type ErrorKind } from '@ghostwire/core';
import type { JailAccept } from '@ghostwire/security';

const KIND_BY_CODE: Readonly<Record<string, ErrorKind>> = {
  ENOENT: 'not_found',
  ENOTDIR: 'not_found',
  EISDIR: 'invalid_input',
  EACCES: 'permission_denied',
  EPERM: 'permission_denied',
  EROFS: 'permission_denied',
  ENOSPC: 'storage',
  EMFILE: 'storage',
  ENAMETOOLONG: 'invalid_input',
  ELOOP: 'invalid_input',
};

const MESSAGE_BY_CODE: Readonly<Record<string, string>> = {
  ENOENT: 'does not exist',
  ENOTDIR: 'has a parent that is not a directory',
  EISDIR: 'is a directory',
  EACCES: 'is not readable or writable by this process',
  EPERM: 'is not readable or writable by this process',
  EROFS: 'is on a read-only filesystem',
  ENOSPC: 'could not be written: the filesystem is full',
  ENAMETOOLONG: 'has a name too long for the filesystem',
  ELOOP: 'is behind a symlink loop',
};

/**
 * A sentence explaining where a path actually landed, or `''`.
 *
 * The workspace is a chroot, so `/etc/hosts` addresses a file *inside* it. That
 * is the right behaviour and the wrong silence: without saying so, a model that
 * asked for `/etc/hosts` and got `ENOENT` concludes the host has no hosts file,
 * and one that asked and got content concludes it read the host's. The old
 * design got this for free by refusing — clamping has to pay for it explicitly.
 *
 * Costs a line of tokens only when something was actually rewritten, which is
 * rare once the model has read the tool description.
 */
export function clampNote(requested: string, accepted: JailAccept): string {
  if (accepted.rewrites.length === 0) return '';
  const landed = accepted.relative === '' ? '.' : accepted.relative;
  return ` The workspace is the root: "${requested}" was resolved to "${landed}" inside it.`;
}

/**
 * Re-describes a filesystem error against the workspace-relative path.
 *
 * A `GhostError` passes through untouched: the jail's own rejections are
 * already precise, and re-wrapping one would replace `jail_escape` — the single
 * most security-relevant kind in the taxonomy — with a generic storage failure.
 *
 * `note` carries `clampNote`'s sentence, so a miss on a path the model wrote as
 * absolute explains itself rather than reading as "that file is not there".
 */
export function fsFailure(error: unknown, path: string, note = ''): unknown {
  if (error instanceof GhostError) return error;
  // An abort carries a numeric DOM `code`, which would otherwise be looked up
  // here and come back as an anonymous filesystem failure — turning the user
  // pressing Stop into something that looks like a broken tool.
  if (isAbortError(error)) return error;
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (typeof code !== 'string') return error;
  const kind = KIND_BY_CODE[code] ?? 'tool';
  const detail = MESSAGE_BY_CODE[code] ?? `could not be used (${code})`;
  return new GhostError(kind, `${path} ${detail}.${note}`, {
    cause: error,
    details: { path, code },
  });
}

/** Bytes as something readable in a directory listing. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit] ?? 'TB'}`;
}
