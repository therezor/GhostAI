/**
 * Workspace paths, as the browser has to handle them.
 *
 * Every path that crosses the API boundary is workspace-relative — the server
 * says so and `WorkspaceJail.relative` enforces it — but "relative" leaves two
 * spellings of the same directory. `GET /api/files` defaults its query to `.`
 * and answers with `path: ''` for the root, because `path.relative(root, root)`
 * is the empty string. So the browser sees both, and a component keying a cache
 * or a breadcrumb on the raw value gets two entries for one directory.
 *
 * Normalising here, once, is the whole reason this file exists. Nothing in it
 * decides whether a path is *allowed*: that is the jail's job, on the server,
 * for every caller. These functions decide what to display and what to ask for.
 */

/** The workspace root, in the one spelling this package uses. */
export const ROOT_PATH = '';

/**
 * The canonical form: no leading `./`, no trailing slash, `.` collapsed to the
 * empty string. Deliberately *not* a safety check — `../` is passed through
 * unchanged, because rejecting it here would put a second, weaker copy of the
 * jail's rules in a place no security test looks at.
 */
export function normalisePath(path: string): string {
  const trimmed = path
    .trim()
    .replace(/^\.\/+/, '')
    .replace(/\/+$/, '');
  return trimmed === '.' ? ROOT_PATH : trimmed;
}

export interface Crumb {
  readonly label: string;
  readonly path: string;
}

/**
 * The trail from the workspace root down to `path`, root included.
 *
 * Root is always the first crumb and is always clickable, so a browser that
 * navigated six levels down has one target to get back rather than six presses
 * of a Back button that is also the browser's.
 */
export function breadcrumbs(path: string): Crumb[] {
  const normalised = normalisePath(path);
  const crumbs: Crumb[] = [{ label: 'workspace', path: ROOT_PATH }];
  if (normalised === ROOT_PATH) return crumbs;

  let accumulated = '';
  for (const segment of normalised.split('/')) {
    if (segment === '') continue;
    accumulated = accumulated === '' ? segment : `${accumulated}/${segment}`;
    crumbs.push({ label: segment, path: accumulated });
  }

  return crumbs;
}

/** `dir` and `name` as one path, without the `//` that `${dir}/${name}` gives at the root. */
export function joinPath(dir: string, name: string): string {
  const normalised = normalisePath(dir);
  return normalised === ROOT_PATH ? name : `${normalised}/${name}`;
}

/** The directory containing `path`, or the root when it is already a top-level entry. */
export function parentOf(path: string): string {
  const normalised = normalisePath(path);
  const cut = normalised.lastIndexOf('/');
  return cut === -1 ? ROOT_PATH : normalised.slice(0, cut);
}

export type PreviewKind = 'image' | 'text' | 'other';

/**
 * How to show a file, decided from the MIME type the *server* assigned.
 *
 * Never from the extension, and the difference matters: the server's table is
 * deliberately small and answers `application/octet-stream` for anything it does
 * not know, which is also the point at which `/api/media/:token` switches to
 * `Content-Disposition: attachment`. Deciding here from the filename would put
 * an `<img>` around a response the server refuses to let a browser render, and
 * the reader would see a broken image rather than a download link.
 */
export function previewKind(mimeType: string | undefined): PreviewKind {
  if (mimeType === undefined) return 'other';
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('text/') || mimeType.startsWith('application/json')) return 'text';
  return 'other';
}

/**
 * The cap on a text preview, in bytes.
 *
 * A workspace holds whatever the agent wrote to it, and "open the 40 MB log the
 * last turn produced" should not be a way to hang the tab. Past this the panel
 * offers the file rather than rendering it.
 */
export const MAX_TEXT_PREVIEW_BYTES = 256 * 1024;
