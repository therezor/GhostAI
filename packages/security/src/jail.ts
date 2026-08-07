/**
 * The workspace jail.
 *
 * Every path that reaches the filesystem from a model, a channel, an extension or
 * an MCP server passes through here first. It is the only thing in GhostAI
 * permitted to decide that an agent-supplied path is acceptable, which is why
 * `@ghostai/core` documents its own path helpers as *not* being a safety check.
 *
 * The workspace is a **root**, in the `chroot` sense. `/etc/passwd` addresses
 * `<workspace>/etc/passwd`; `../../secrets` addresses `<workspace>/secrets`;
 * `~/.ssh/id_ed25519` addresses `<workspace>/.ssh/id_ed25519`. There is no
 * spelling of a path that means "outside", the same way there is none inside a
 * chroot. Three rules make that defensible:
 *
 *  1. **Lexical normalisation before resolution.** The string handed to the
 *     filesystem is *constructed*, not inspected: the input is split into
 *     segments, roots and drive letters and `~` prefixes are dropped, `.` is
 *     dropped and `..` pops the stack — popping an empty stack being a no-op,
 *     which is the clamp — and what survives is joined onto the canonical root.
 *     Containment therefore holds by construction rather than by comparison,
 *     and there is no input that can be *accepted* as escaping.
 *
 *  2. **`realpath`, then containment.** The result is canonicalised through the
 *     filesystem, so a symlink inside the workspace pointing at `/etc` resolves
 *     to `/etc` and fails the check. This is now the *only* thing that can
 *     refuse a well-formed path, which is exactly why it has to stay: a symlink
 *     is the one escape a lexical rule cannot see. Comparing before
 *     canonicalising is the classic bug — `workspace/link/passwd` has a perfect
 *     `workspace/` prefix and reads whatever `link` points at.
 *
 *  3. **Normalisation is total.** Every input maps either to a path inside the
 *     root or to a refusal *about the filesystem* — a NUL byte, a path the
 *     filesystem cannot answer for, a symlink leading out. No refusal is about
 *     the shape of the string any more; a shape is recorded as a `PathShape`
 *     rewrite and carried on the verdict for the audit log.
 *
 * **`exec` is the exception, and it is deliberate.** `guardExec` refuses an
 * argument whose shape says "outside" rather than clamping it, because clamping
 * is a property of *this* module's resolution and a spawned child does not
 * honour it — `cat /etc/passwd` in a workspace-rooted child reads the real file.
 * `pathShapes` exists so the guard can classify without resolving. Which also
 * means: **a workspace is an organisational boundary, not a security boundary,
 * wherever `exec` is enabled.** A child process can walk out of it.
 *
 * The verdicts are platform-independent on purpose. `\` is treated as a
 * separator and drive letters are handled everywhere, so a config authored on
 * Windows and mounted into a Linux container cannot have a different idea of
 * what is legal than the machine it was written on.
 *
 * Paths that cannot be canonicalised for a reason *other* than "does not exist"
 * — a permission error, a symlink loop, a name too long for the filesystem —
 * are refused. A path whose containment cannot be established is not safe to
 * touch, and the alternative is trusting the string.
 */

import { lstatSync, realpathSync } from 'node:fs';
import {
  basename,
  dirname,
  join,
  relative as pathRelative,
  resolve,
  sep,
} from 'node:path';

import { GhostError, ensureDir } from '@ghostai/core';

/**
 * Why a path was refused. Carried in the error's `details` for the audit log.
 *
 * Every member is a statement about the filesystem. The shapes that used to
 * live here — `absolute`, `traversal`, `home_prefix`, `unc` — became
 * `PathShape`, because they are no longer reasons to refuse.
 */
export type JailRejection =
  | 'empty'
  /** A NUL byte: a truncation bypass, not a typo. */
  | 'nul_byte'
  /** Resolved and canonicalised, and landed outside the root. */
  | 'outside_root'
  /** Canonicalisation failed for a reason other than non-existence. */
  | 'unverifiable';

/**
 * What an input looked like before it was clamped.
 *
 * Never a verdict — the record of a rewrite, for the audit log, for the message
 * a tool hands back to the model, and for `guardExec`, which treats a non-empty
 * list as a refusal.
 */
export type PathShape =
  /** A leading `/` or `\`. */
  | 'absolute'
  /** A leading `~`, which only a shell expands. */
  | 'home_prefix'
  /** At least one `..` segment, whether or not it would have escaped. */
  | 'traversal'
  /** A leading `\\` or `//`. */
  | 'unc'
  /** A leading `C:`. */
  | 'drive';

export interface JailAccept {
  readonly ok: true;
  /**
   * The canonical, absolute path that was verified.
   *
   * Callers must use this for the filesystem call rather than re-deriving one
   * from the input: it is the string that was actually checked.
   */
  readonly path: string;
  /** The workspace-relative form after clamping — what the caller addressed. */
  readonly relative: string;
  /** Empty when the input was already a plain relative path. In detection order. */
  readonly rewrites: readonly PathShape[];
}

type JailCheck =
  | JailAccept
  | {
      readonly ok: false;
      readonly rejection: JailRejection;
      readonly message: string;
    };

interface WorkspaceJailOptions {
  readonly root: string;
  /** Create the root if it is missing. Default `true`. */
  readonly create?: boolean;
  /**
   * Compare paths case-insensitively. Defaults to `true` on win32 only.
   *
   * Not enabled on darwin despite APFS defaulting to case-insensitive: the
   * volume *can* be case-sensitive, and folding case there would accept a
   * prefix that is a genuinely different directory. It is not needed either —
   * input paths are joined onto this object's own canonical root, so the
   * compared prefix is byte-identical by construction.
   */
  readonly caseInsensitive?: boolean;
}

/** Only the two errno values that mean "this path does not exist yet". */
const NON_EXISTENT_CODES: ReadonlySet<string> = new Set(['ENOENT', 'ENOTDIR']);

const SEPARATORS = /[\\/]+/;
const DRIVE_LETTER = /^[A-Za-z]:/;

function reject(rejection: JailRejection, message: string): JailCheck {
  return { ok: false, rejection, message };
}

interface Normalised {
  readonly segments: readonly string[];
  readonly rewrites: readonly PathShape[];
}

/**
 * Splits an input into the segments it addresses inside the root.
 *
 * Two passes. The first folds the path: `.` and empty segments are dropped and
 * `..` pops the stack, popping an empty stack being the clamp. The second
 * strips root markers from the *head* of what survived — a leading `~` segment,
 * a leading drive letter — and it runs on the output rather than on the input
 * for one reason: **the result has to be a fixed point.** The REST layer echoes
 * `relative` back to clients that send it again, so a normalisation that moved
 * on the second pass would walk a path somewhere new on every round trip.
 * Stripping only at input position 0 fails that: `/~` would fold to a literal
 * `~` segment, which re-reads as a home prefix and resolves to the root instead.
 *
 * The cost is that a file named `~something` directly in the workspace root is
 * not addressable. That was already true — the pre-chroot rule refused any
 * leading `~` outright — and it is confined to the root, so `a/~/b` still names
 * a directory called `~`.
 */
function normalise(inputPath: string): Normalised {
  const rewrites: PathShape[] = [];
  const note = (shape: PathShape): void => {
    if (!rewrites.includes(shape)) rewrites.push(shape);
  };

  if (inputPath.startsWith('\\\\') || inputPath.startsWith('//')) note('unc');
  else if (inputPath.startsWith('/') || inputPath.startsWith('\\')) {
    note('absolute');
  }

  /** Drops `.` and empty segments; `..` pops, and popping empty is the clamp. */
  const fold = (parts: readonly string[]): string[] => {
    const segments: string[] = [];
    for (const segment of parts) {
      if (segment === '' || segment === '.') continue;
      if (segment === '..') {
        note('traversal');
        segments.pop();
        continue;
      }
      segments.push(segment);
    }
    return segments;
  };

  // Fold, strip one root marker off the head, fold again. Stripping has to be
  // followed by another fold rather than trusted: `./c:..` folds to `c:..`,
  // whose drive prefix comes off leaving a bare `..` — which, left in the
  // output, would join to the workspace's *parent* and reduce containment to
  // whatever `realpath` happened to say. Each pass strictly shortens the input,
  // so this terminates; it exits when the head is no longer a root marker,
  // which is also what makes the result a fixed point.
  let parts: readonly string[] = inputPath.split(SEPARATORS);
  for (;;) {
    const segments = fold(parts);
    const head = segments[0];
    if (head === undefined) return { segments, rewrites };
    if (DRIVE_LETTER.test(head)) {
      note('drive');
      parts = [head.slice(2), ...segments.slice(1)];
      continue;
    }
    if (head.startsWith('~')) {
      note('home_prefix');
      parts = segments.slice(1);
      continue;
    }
    return { segments, rewrites };
  }
}

/**
 * The shapes that mean "this string addresses something outside the workspace".
 *
 * Deliberately the **pre-chroot syntactic rule, verbatim**, and deliberately
 * not derived from `normalise`. It exists for `guardExec`, which must refuse
 * what the file tools clamp: the guard hands its argument to a child process
 * unchanged, and a child does not honour this module's idea of a root, so
 * `cat /etc/passwd` with `cwd` at the workspace root reads the real file.
 *
 * Keeping it a separate function is what lets `exec-guard.test.ts` pass
 * unchanged across the chroot change, and an oracle test there asserts the two
 * agree over generated arguments. `normalise` answers "what did I rewrite";
 * this answers "should a child ever see this". They coincide everywhere it
 * matters and are allowed to differ on exotica like `./~/x`, where the stricter
 * of the two is the one the guard uses.
 */
export function pathShapes(inputPath: string): readonly PathShape[] {
  const shapes: PathShape[] = [];
  const raw = inputPath.split(SEPARATORS);

  if (raw[0]?.startsWith('~') === true) shapes.push('home_prefix');
  if (inputPath.startsWith('\\\\') || inputPath.startsWith('//')) {
    shapes.push('unc');
  } else if (inputPath.startsWith('/') || inputPath.startsWith('\\')) {
    shapes.push('absolute');
  }
  if (DRIVE_LETTER.test(inputPath)) shapes.push('drive');
  if (raw.includes('..')) shapes.push('traversal');

  return shapes;
}

/** Whether a name exists as a directory entry, even a broken one. */
function entryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * `realpath` of the deepest ancestor that exists, with the missing tail
 * re-appended.
 *
 * `write_file` legitimately targets a path that does not exist yet, and plain
 * `realpathSync` throws on it — so a jail built on `realpathSync` alone could
 * only ever validate reads. Re-appending is safe because the missing segments
 * cannot be symlinks: they do not exist. Every segment that *does* exist has
 * already been canonicalised by the successful call.
 *
 * The one trap, and the reason for the `entryExists` guard: `realpathSync`
 * answers `ENOENT` for a **dangling** symlink as well as for a name that is not
 * there at all, and the two must not be treated alike. A dangling link is an
 * existing directory entry whose target is missing, so popping it and
 * re-appending the name hands back a path inside the root that a write then
 * follows straight out of it — `<ws>/x → ../../vault.json` would pass
 * containment and then be created outside. `lstat` is what tells the two apart:
 * it succeeds on the link itself. Such a path is `unverifiable`, not absent.
 *
 * The walk stops at `floor`, which is always an ancestor of `target` because the
 * caller built the target by joining a `..`-free segment list onto it. A failure
 * at the floor itself means the workspace root has been deleted or unmounted
 * underneath the process, and there is nothing to verify against.
 */
function realpathBoundary(target: string, floor: string): string {
  const tail: string[] = [];
  let current = target;

  for (;;) {
    try {
      const real = realpathSync(current);
      return tail.length === 0 ? real : resolve(real, ...tail);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (
        code === undefined ||
        !NON_EXISTENT_CODES.has(code) ||
        current === floor
      ) {
        throw error;
      }
      if (entryExists(current)) throw error;
      tail.unshift(basename(current));
      current = dirname(current);
    }
  }
}

export class WorkspaceJail {
  /** The canonical, absolute workspace root. Every legal path is under it. */
  readonly root: string;

  private readonly caseInsensitive: boolean;

  constructor(options: WorkspaceJailOptions) {
    const requested = resolve(options.root);
    let real: string;
    try {
      if (options.create ?? true) ensureDir(requested);
      real = realpathSync(requested);
    } catch (error) {
      throw new GhostError(
        'config',
        `Workspace root is unusable: ${requested}`,
        {
          cause: error,
          details: { root: requested },
        },
      );
    }
    this.root = real;
    this.caseInsensitive =
      options.caseInsensitive ?? process.platform === 'win32';
  }

  /**
   * Resolves a path against the workspace root without throwing.
   *
   * Use this where a rejection is an expected outcome to be reported — the exec
   * guard checking every argument, a batch of paths from one tool call — and
   * `accept`/`resolve` everywhere else.
   */
  check(inputPath: string): JailCheck {
    if (inputPath === '') return reject('empty', 'Path is empty');
    if (inputPath.includes('\0')) {
      return reject('nul_byte', 'Path contains a NUL byte');
    }

    const { segments, rewrites } = normalise(this.withoutRootPrefix(inputPath));
    const relativePath = segments.join(sep);
    const target = join(this.root, ...segments);

    let real: string;
    try {
      real = realpathBoundary(target, this.root);
    } catch (error) {
      return reject(
        'unverifiable',
        `Path cannot be verified: ${inputPath} (${(error as NodeJS.ErrnoException).code ?? 'unknown'})`,
      );
    }

    if (!this.contains(real)) {
      // The only way to arrive here after a lexical normalisation that cannot
      // produce an escaping string is a symlink inside the workspace pointing
      // out of it.
      return reject(
        'outside_root',
        `Path resolves outside the workspace: ${inputPath}`,
      );
    }
    return { ok: true, path: real, relative: relativePath, rewrites };
  }

  /**
   * Resolves a path against the workspace root and returns the whole verdict.
   *
   * `rewrites` is why this exists beside `resolve`: a caller that clamped a
   * model's `/etc/hosts` into the workspace should say so in what it hands
   * back, or the model believes it read the host's file.
   */
  accept(inputPath: string): JailAccept {
    const verdict = this.check(inputPath);
    if (verdict.ok) return verdict;
    throw new GhostError(
      verdict.rejection === 'empty' ? 'invalid_input' : 'jail_escape',
      verdict.message,
      { details: { path: inputPath, rejection: verdict.rejection } },
    );
  }

  /** `accept(inputPath).path`, for callers that need nothing else. */
  resolve(inputPath: string): string {
    return this.accept(inputPath).path;
  }

  /**
   * Whether an already-absolute path lies inside the root.
   *
   * This is for paths GhostAI produced itself — the session database, a media
   * file being served over HTTP. It does **not** canonicalise, so it is not a
   * check for agent-supplied input; `check` and `accept` are.
   */
  contains(absolutePath: string): boolean {
    const candidate = this.fold(resolve(absolutePath));
    const root = this.fold(this.root);
    if (candidate === root) return true;
    return candidate.startsWith(root.endsWith(sep) ? root : root + sep);
  }

  /** The workspace-relative form of a contained path, for display and logs. */
  relative(absolutePath: string): string {
    const resolved = resolve(absolutePath);
    if (!this.contains(resolved)) {
      throw new GhostError(
        'jail_escape',
        `Path is outside the workspace: ${absolutePath}`,
        {
          details: {
            path: absolutePath,
            rejection: 'outside_root' satisfies JailRejection,
          },
        },
      );
    }
    return pathRelative(this.root, resolved);
  }

  /**
   * The workspace root, removed from the front of a path that repeats it.
   *
   * Clamping treats a leading `/` as the root, which is right for `/notes/x` and
   * silently wrong for the absolute path of the root itself: `<root>/notes/x`
   * clamped segment by segment lands on `<root>/Users/you/project/notes/x` — a
   * real directory tree of junk, created without an error by `write_file` and
   * reported as "not found" by `read_file` for a file that exists.
   *
   * Nothing legitimate is lost. Addressing a directory *inside* the workspace
   * whose path spells out the workspace's own absolute path is not a thing anyone
   * does, and the alternative reading is never what was meant.
   *
   * The result stays a fixed point, which `normalise` explains is the property
   * the REST layer depends on: what comes back no longer starts with the root, so
   * a second pass finds nothing to remove. The leading separator is kept so the
   * path is still recorded as an `absolute` rewrite rather than looking relative.
   */
  private withoutRootPrefix(inputPath: string): string {
    // A workspace at the filesystem root has no prefix to remove, and every
    // absolute path would match it.
    if (this.root === sep || this.root === '/') return inputPath;

    // Compared with separators unified, because a model on a POSIX host can
    // still produce `\` and the two spell the same path. Neither this nor case
    // folding changes the length, which is what makes slicing by it correct.
    const candidate = this.fold(inputPath.replaceAll('\\', '/'));
    const root = this.fold(this.root.replaceAll('\\', '/'));

    if (candidate === root) return '/';
    if (candidate.startsWith(`${root}/`)) {
      return inputPath.slice(this.root.length);
    }
    return inputPath;
  }

  private fold(value: string): string {
    return this.caseInsensitive ? value.toLowerCase() : value;
  }
}

/**
 * Supplies the jail a turn runs inside, keyed by its session's workspace.
 *
 * Declared here rather than in `@ghostai/agent` because it is a statement about
 * jails: the tool registry, an MCP host and the file routes all need to reach
 * one workspace out of several, and none of them should have to depend on the
 * agent loop to say so.
 */
export interface JailResolver {
  forWorkspace(workspaceId: string): WorkspaceJail;
  /** For a session with no stored workspace, and for a preview with no session. */
  readonly default: WorkspaceJail;
}

/** The single-workspace case, for tests and for embedders that have only one. */
export function singleJail(jail: WorkspaceJail): JailResolver {
  return { forWorkspace: () => jail, default: jail };
}
