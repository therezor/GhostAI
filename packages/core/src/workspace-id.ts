/**
 * What may name a workspace.
 *
 * A workspace id is also a directory name — `<root>/workspace/<id>` — and it
 * arrives over HTTP, so this is the only thing standing between a request body
 * and a path. It lives in its own module because two very different places need
 * it and neither should own it: `paths.ts` turns an id into a directory, and
 * `workspace-store.ts` decides whether one may be created.
 *
 * The rules, and why each is a rule rather than a preference:
 *
 *  - **One segment, `[a-z0-9-]`, no leading or trailing hyphen, 1–40 chars.**
 *    `..`, `/`, `\`, `:`, NUL and a leading `~` are all unrepresentable, so a
 *    crafted id cannot become a path outside the workspaces tree. The jail
 *    would catch it anyway; this catches it a layer earlier, where the error
 *    can say something useful.
 *  - **Lowercase only, and that is a security rule.** APFS and NTFS fold case,
 *    so `Work` and `work` would be two registry rows sharing one directory —
 *    two workspaces that believe they are isolated and are not.
 *  - **`default` is reserved**, because it names the parent of every other
 *    workspace rather than a folder beside them.
 *  - **The Windows device names are reserved**, because `mkdir con` fails on
 *    exactly one platform and a workspace that cannot be created on Windows is
 *    a bug report from a user who did nothing wrong.
 */

/** The workspace every install has, and the one that cannot be deleted. */
export const DEFAULT_WORKSPACE_ID = 'default';

/** 1–40 chars, lowercase alphanumerics and hyphens, no leading or trailing hyphen. */
export const WORKSPACE_ID_PATTERN: RegExp = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

const MAX_WORKSPACE_ID_LENGTH = 40;

/** Reserved as *names to create*. `default` is still a legal id to resolve. */
export const RESERVED_WORKSPACE_IDS: ReadonlySet<string> = new Set([
  DEFAULT_WORKSPACE_ID,
  'con',
  'prn',
  'aux',
  'nul',
  ...Array.from({ length: 9 }, (_unused, index) => `com${String(index + 1)}`),
  ...Array.from({ length: 9 }, (_unused, index) => `lpt${String(index + 1)}`),
]);

/** Whether a string may be resolved to a workspace directory. */
export function isWorkspaceId(value: string): boolean {
  return WORKSPACE_ID_PATTERN.test(value);
}

/**
 * A display name reduced to a legal id.
 *
 * Lossy on purpose — the name is stored separately and is what the UI shows, so
 * this only has to produce something legal, stable and recognisable. A name
 * with nothing usable in it falls back to `workspace` rather than failing:
 * the caller then disambiguates against the rows that already exist.
 */
export function deriveSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_WORKSPACE_ID_LENGTH)
    .replace(/-+$/, '');

  return slug === '' || RESERVED_WORKSPACE_IDS.has(slug) ? 'workspace' : slug;
}
