/**
 * What may name a workspace.
 *
 * A workspace id is also a directory name — `<root>/workspace/<id>` — and it
 * arrives over HTTP, so this is the only thing standing between a request body
 * and a path. It lives in its own module because two very different places need
 * it and neither should own it: `paths.ts` turns an id into a directory, and
 * `workspace-store.ts` decides whether one may be created.
 *
 * The character rules and their rationale are in `slug-id.ts`, shared with
 * agent ids. What is specific to a workspace is one reservation: **`default` is
 * reserved**, because it names the parent of every other workspace rather than
 * a folder beside them.
 */

import { RESERVED_DEVICE_NAMES, isSlugId, slugify, SLUG_ID_PATTERN } from './slug-id.js';

/** The workspace every install has, and the one that cannot be deleted. */
export const DEFAULT_WORKSPACE_ID = 'default';

/** 1–40 chars, lowercase alphanumerics and hyphens, no leading or trailing hyphen. */
export const WORKSPACE_ID_PATTERN: RegExp = SLUG_ID_PATTERN;

/** Reserved as *names to create*. `default` is still a legal id to resolve. */
export const RESERVED_WORKSPACE_IDS: ReadonlySet<string> = new Set([
  DEFAULT_WORKSPACE_ID,
  ...RESERVED_DEVICE_NAMES,
]);

/** Whether a string may be resolved to a workspace directory. */
export function isWorkspaceId(value: string): boolean {
  return isSlugId(value);
}

/** A display name reduced to a legal workspace id. See `slugify`. */
export function deriveSlug(name: string): string {
  return slugify(name, { reserved: RESERVED_WORKSPACE_IDS, fallback: 'workspace' });
}
