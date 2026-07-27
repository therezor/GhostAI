/**
 * The workspace jail.
 *
 * Every path that reaches the filesystem from a model, a channel, a plugin or
 * an MCP server passes through here first. It is the only thing in GhostAI
 * permitted to decide that an agent-supplied path is acceptable, which is why
 * `@ghostai/core` documents its own path helpers as *not* being a safety check.
 *
 * Two rules make it defensible:
 *
 *  1. **Syntactic refusal before resolution.** `..`, absolute paths, `~`, UNC
 *     paths, drive letters and NUL bytes are rejected as *inputs*, not merely
 *     resolved and then containment-checked. A path is judged by whether it is
 *     the shape the tool contract asks for — a workspace-relative path — so
 *     containment is the second line of defence rather than the only one.
 *
 *  2. **`realpath`, then containment.** The resolved path is canonicalised
 *     through the filesystem, so a symlink inside the workspace pointing at
 *     `/etc` resolves to `/etc` and fails the check. Comparing before
 *     canonicalising is the classic bug: `workspace/link/passwd` has a perfect
 *     `workspace/` prefix and reads whatever `link` points at.
 *
 * The verdicts are platform-independent on purpose. `\` is treated as a
 * separator and drive letters are rejected everywhere, so a config authored on
 * Windows and mounted into a Linux container cannot have a different idea of
 * what is legal than the machine it was written on.
 *
 * Paths that cannot be canonicalised for a reason *other* than "does not exist"
 * — a permission error, a symlink loop, a name too long for the filesystem —
 * are refused. A path whose containment cannot be established is not safe to
 * touch, and the alternative is trusting the string.
 */

import { realpathSync } from 'node:fs';
import { basename, dirname, relative as pathRelative, resolve, sep } from 'node:path';

import { GhostError, ensureDir } from '@ghostai/core';

/** Why a path was refused. Carried in the error's `details` for the audit log. */
export type JailRejection =
  | 'empty'
  /** A NUL byte: a truncation bypass, not a typo. */
  | 'nul_byte'
  /** A leading `~`, which only a shell expands. */
  | 'home_prefix'
  | 'traversal'
  | 'absolute'
  | 'unc'
  /** Resolved and canonicalised, and landed outside the root. */
  | 'outside_root'
  /** Canonicalisation failed for a reason other than non-existence. */
  | 'unverifiable';

export type JailCheck =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly rejection: JailRejection; readonly message: string };

export interface WorkspaceJailOptions {
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

function isAbsoluteAnywhere(inputPath: string): boolean {
  return inputPath.startsWith('/') || inputPath.startsWith('\\') || DRIVE_LETTER.test(inputPath);
}

function reject(rejection: JailRejection, message: string): JailCheck {
  return { ok: false, rejection, message };
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
 * The walk stops at `floor`, which is always an ancestor of `target` because the
 * caller built the target by resolving a `..`-free relative path against it. A
 * failure at the floor itself means the workspace root has been deleted or
 * unmounted underneath the process, and there is nothing to verify against.
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
      if (code === undefined || !NON_EXISTENT_CODES.has(code) || current === floor) throw error;
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
      throw new GhostError('config', `Workspace root is unusable: ${requested}`, {
        cause: error,
        details: { root: requested },
      });
    }
    this.root = real;
    this.caseInsensitive = options.caseInsensitive ?? process.platform === 'win32';
  }

  /**
   * Validates a workspace-relative path without throwing.
   *
   * Use this where a rejection is an expected outcome to be reported — the exec
   * guard checking every argument, a batch of paths from one tool call — and
   * `resolve` everywhere else.
   */
  check(inputPath: string): JailCheck {
    if (inputPath === '') return reject('empty', 'Path is empty');
    if (inputPath.includes('\0')) {
      return reject('nul_byte', 'Path contains a NUL byte');
    }

    const segments = inputPath.split(SEPARATORS);
    if (segments[0]?.startsWith('~') === true) {
      return reject(
        'home_prefix',
        `Path starts with "~", which is not expanded here: ${inputPath}`,
      );
    }
    if (inputPath.startsWith('\\\\') || inputPath.startsWith('//')) {
      return reject('unc', `UNC paths are not allowed: ${inputPath}`);
    }
    if (isAbsoluteAnywhere(inputPath)) {
      return reject('absolute', `Path must be relative to the workspace: ${inputPath}`);
    }
    if (segments.includes('..')) {
      return reject('traversal', `Path contains a ".." segment: ${inputPath}`);
    }

    let real: string;
    try {
      real = realpathBoundary(resolve(this.root, inputPath), this.root);
    } catch (error) {
      return reject(
        'unverifiable',
        `Path cannot be verified: ${inputPath} (${(error as NodeJS.ErrnoException).code ?? 'unknown'})`,
      );
    }

    if (!this.contains(real)) {
      // The only way to arrive here after the syntactic checks is a symlink
      // inside the workspace pointing out of it.
      return reject('outside_root', `Path resolves outside the workspace: ${inputPath}`);
    }
    return { ok: true, path: real };
  }

  /**
   * Validates a workspace-relative path and returns it canonicalised absolute.
   *
   * Callers must use the returned path for the filesystem call rather than
   * re-deriving one from the input: the returned value is the string that was
   * actually verified.
   */
  resolve(inputPath: string): string {
    const verdict = this.check(inputPath);
    if (verdict.ok) return verdict.path;
    throw new GhostError(
      verdict.rejection === 'empty' ? 'invalid_input' : 'jail_escape',
      verdict.message,
      { details: { path: inputPath, rejection: verdict.rejection } },
    );
  }

  /**
   * Whether an already-absolute path lies inside the root.
   *
   * This is for paths GhostAI produced itself — the session database, a media
   * file being served over HTTP. It does **not** canonicalise, so it is not a
   * check for agent-supplied input; `check` and `resolve` are.
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
      throw new GhostError('jail_escape', `Path is outside the workspace: ${absolutePath}`, {
        details: { path: absolutePath, rejection: 'outside_root' satisfies JailRejection },
      });
    }
    return pathRelative(this.root, resolved);
  }

  private fold(value: string): string {
    return this.caseInsensitive ? value.toLowerCase() : value;
  }
}
