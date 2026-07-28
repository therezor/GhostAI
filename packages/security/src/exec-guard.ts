/**
 * The exec guard: an argv vector in, a validated spawn plan out.
 *
 * What is deliberately absent is a deny-list of shell metacharacters. Patterns
 * for `$(...)`, backticks and `| sh` are the standard shape of this code and
 * they are theatre when the executor is `execFile` with `shell: false`: there is
 * no string for a metacharacter to be interpreted *in*, so the patterns can only
 * ever reject legitimate arguments — a commit message containing `$HOME`, a grep
 * for a pipe character. They protect nothing and break real commands, which is
 * the worst trade available.
 *
 * What actually constrains the child is here instead:
 *
 *  - `argv[0]` against a deny-list, then an allow-list, matched on the basename
 *    so `/usr/bin/git`, `git` and `git.exe` receive the same verdict.
 *  - A shell binary is refused unless the operator listed it explicitly, and the
 *    `-c` family of flags is refused even then. Handing `bash -c "…"` to
 *    `execFile` re-creates the shell parsing the argv contract removes; that is
 *    the one thing on this list a metacharacter scan would have been aiming at.
 *  - Every path-shaped argument through the workspace jail.
 *  - An environment allow-list, so the child inherits `PATH` and nothing that
 *    happens to hold a token.
 *  - An output budget, enforced while the child writes rather than after it
 *    exits.
 *
 * The guard validates and never rewrites. A path-shaped argument that passes
 * stays exactly as the model wrote it, because the child's working directory is
 * the workspace root and substituting an absolute path would corrupt any
 * argument that only looked like a path — `git log a/b`, a regex, a URL.
 *
 * That is also why this is the one place in GhostAI where a path outside the
 * workspace is **refused instead of clamped**. `WorkspaceJail` resolves
 * `/etc/passwd` to `<workspace>/etc/passwd`, but clamping is a property of
 * *its* resolution and a spawned child does not honour it: handing `/etc/passwd`
 * to `cat` with `cwd` at the workspace root reads the real file. So every
 * argument is classified with `pathShapes` — the jail's own lexical rules,
 * reported rather than applied — and a non-empty result stops the command
 * before any filesystem work happens.
 */

import { basename, extname } from 'node:path';

import { GhostError } from '@ghostai/core';
import { type ExecToolConfig, ExecToolConfigSchema } from '@ghostai/protocol';

import { pathShapes, type JailRejection, type PathShape, type WorkspaceJail } from './jail.js';

/**
 * Binaries whose whole purpose is to interpret a string as a program.
 *
 * Refused unless named in `allowedBinaries`: an operator who wants
 * `bash script.sh` can say so, and gets it without the `-c` family.
 */
export const SHELL_BINARIES: readonly string[] = [
  'ash',
  'bash',
  'busybox',
  'cmd',
  'csh',
  'dash',
  'fish',
  'ksh',
  'powershell',
  'pwsh',
  'sh',
  'tcsh',
  'zsh',
];

/** Flags that make a shell — or `env`, `perl`, `python` — take a program string. */
const PROGRAM_STRING_FLAGS: ReadonlySet<string> = new Set([
  '-c',
  '-lc',
  '-ic',
  '--command',
  '/c',
  '/k',
  '-command',
  '-encodedcommand',
]);

/** Stripped before allow/deny matching so a verdict is the same on every platform. */
const EXECUTABLE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.exe',
  '.com',
  '.bat',
  '.cmd',
  '.ps1',
]);

const DRIVE_LETTER = /^[A-Za-z]:/;

export interface ExecGuardOptions {
  readonly jail: WorkspaceJail;
  /** Defaults to the schema's own defaults. */
  readonly config?: ExecToolConfig;
  /** Defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export interface ExecPlan {
  /** Pass to `execFile`/`spawn` as the file. Never through a shell. */
  readonly file: string;
  readonly args: readonly string[];
  /** Always the workspace root, which is what makes relative arguments resolve. */
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  /** `0` means unlimited, matching the config convention. */
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  /** The canonical paths that were validated, for the approval prompt and audit log. */
  readonly paths: readonly string[];
}

const DEFAULT_EXEC_CONFIG: ExecToolConfig = ExecToolConfigSchema.parse({});

function denied(message: string, details: Readonly<Record<string, unknown>>): GhostError {
  return new GhostError('permission_denied', message, { details });
}

/** The name an allow/deny entry is compared against. */
export function binaryName(argv0: string): string {
  const name = basename(argv0.replaceAll('\\', '/'));
  const extension = extname(name).toLowerCase();
  return EXECUTABLE_EXTENSIONS.has(extension) ? name.slice(0, -extension.length) : name;
}

function isPathShaped(value: string): boolean {
  if (value === '.' || value === '..') return true;
  if (value.startsWith('~')) return true;
  if (DRIVE_LETTER.test(value)) return true;
  return value.includes('/') || value.includes('\\');
}

/**
 * The part of an argument that could be addressing the filesystem.
 *
 * Every argument is a candidate, not only the ones that look like paths: `cat
 * notes.txt` where `notes.txt` is a symlink to `/etc/shadow` is precisely the
 * escape the jail exists to catch, and a separator-based heuristic would wave it
 * through. Arguments that are plainly not paths — a flag, a commit message —
 * cost nothing to check, because a relative string with no `..` in it always
 * resolves inside the workspace and passes.
 */
function pathCandidate(argument: string): string | null {
  if (argument.startsWith('-')) {
    // `--out=../etc/passwd`: the flag is not a path, its value is.
    const equals = argument.indexOf('=');
    if (equals === -1) return null;
    const value = argument.slice(equals + 1);
    return value === '' ? null : value;
  }
  return argument === '' ? null : argument;
}

/**
 * Whether a refusal should stop the command.
 *
 * Everything except `unverifiable` is an argument reaching for something outside
 * the workspace, and is fatal. `unverifiable` is not, on its own: a 5000-character
 * commit message is a path the filesystem cannot answer for, and refusing to
 * commit because a message was long would be the guard inventing a rule nobody
 * asked for. Such an argument is only fatal if it is *shaped* like a path.
 */
function isFatalRejection(rejection: JailRejection, candidate: string): boolean {
  return rejection !== 'unverifiable' || isPathShaped(candidate);
}

/**
 * Refuses a string whose shape addresses something outside the workspace.
 *
 * Checked before `jail.check`, which would clamp it and answer `ok` — and
 * cheaper, since it touches no filesystem.
 */
function assertInsideByShape(
  candidate: string,
  describe: (shapes: readonly PathShape[]) => string,
  details: Readonly<Record<string, unknown>>,
): void {
  const shapes = pathShapes(candidate);
  if (shapes.length === 0) return;
  throw new GhostError('jail_escape', describe(shapes), {
    details: { ...details, path: candidate, shapes },
  });
}

function buildEnv(
  config: ExecToolConfig,
  source: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of config.envAllowlist) {
    const value = source[name];
    if (value !== undefined) env[name] = value;
  }
  if (config.pathAppend !== '') {
    const existing = env.PATH;
    env.PATH = existing === undefined ? config.pathAppend : `${existing}:${config.pathAppend}`;
  }
  return env;
}

/**
 * Validates an argv vector and returns the plan to spawn it.
 *
 * Throws rather than returning a verdict: there is no partially-acceptable
 * command, and a caller that forgot to check a boolean would spawn it anyway.
 */
export function guardExec(argv: readonly string[], options: ExecGuardOptions): ExecPlan {
  const config = options.config ?? DEFAULT_EXEC_CONFIG;
  const jail = options.jail;

  if (!config.enable) {
    throw denied('The exec tool is disabled by configuration', {});
  }

  const argv0 = argv[0];
  if (argv0 === undefined || argv0 === '') {
    throw new GhostError('invalid_input', 'argv must start with a program to run');
  }
  for (const argument of argv) {
    if (argument.includes('\0')) {
      throw denied('Arguments must not contain NUL bytes', { argv });
    }
  }

  const name = binaryName(argv0);
  if (config.deniedBinaries.includes(name)) {
    throw denied(`Binary is denied by configuration: ${name}`, { binary: name });
  }
  const allowed = config.allowedBinaries;
  if (allowed.length > 0 && !allowed.includes(name)) {
    throw denied(`Binary is not in the allow-list: ${name}`, { binary: name, allowed });
  }
  if (SHELL_BINARIES.includes(name)) {
    if (!allowed.includes(name)) {
      throw denied(
        `${name} is a shell. Pass the program and its arguments as argv instead, or add "${name}" to allowedBinaries.`,
        { binary: name },
      );
    }
    const programFlag = argv
      .slice(1)
      .find((argument) => PROGRAM_STRING_FLAGS.has(argument.toLowerCase()));
    if (programFlag !== undefined) {
      throw denied(
        `${name} ${programFlag} re-introduces shell parsing. Pass the program and its arguments as argv instead.`,
        { binary: name, flag: programFlag },
      );
    }
  }

  const paths: string[] = [];

  // A program given as a path must be inside the workspace; a bare name is
  // resolved from `PATH` by the OS, and an absolute path is a system binary the
  // allow/deny lists have already ruled on.
  let file = argv0;
  if (isPathShaped(argv0) && !argv0.startsWith('/') && !DRIVE_LETTER.test(argv0)) {
    assertInsideByShape(
      argv0,
      (shapes) => `Program path points outside the workspace (${shapes.join(', ')}): ${argv0}`,
      {},
    );
    const verdict = jail.check(argv0);
    if (!verdict.ok) {
      throw new GhostError(
        'jail_escape',
        `Program path is not inside the workspace: ${verdict.message}`,
        {
          details: { path: argv0, rejection: verdict.rejection },
        },
      );
    }
    file = verdict.path;
    paths.push(verdict.path);
  }

  for (const argument of argv.slice(1)) {
    const candidate = pathCandidate(argument);
    if (candidate === null) continue;
    assertInsideByShape(
      candidate,
      (shapes) => `Argument points outside the workspace (${shapes.join(', ')}): ${candidate}`,
      { argument },
    );
    const verdict = jail.check(candidate);
    if (!verdict.ok) {
      if (!isFatalRejection(verdict.rejection, candidate)) continue;
      throw new GhostError(
        'jail_escape',
        `Argument is not inside the workspace: ${verdict.message}`,
        {
          details: { argument, path: candidate, rejection: verdict.rejection },
        },
      );
    }
    // Recorded for the approval prompt and the audit log, so only arguments the
    // caller actually wrote as paths are listed. A URL is excluded: it resolves
    // harmlessly inside the workspace, but reporting it as a file it touches
    // would be a lie.
    if (isPathShaped(candidate) && !candidate.includes('://')) paths.push(verdict.path);
  }

  return {
    file,
    args: argv.slice(1),
    cwd: jail.root,
    env: buildEnv(config, options.env ?? process.env),
    timeoutMs: config.timeoutMs,
    maxOutputBytes: config.maxOutputBytes,
    paths,
  };
}

export interface OutputCapResult {
  readonly text: string;
  readonly truncated: boolean;
  /** Bytes actually kept, which is the cap when `truncated`. */
  readonly bytes: number;
}

export interface OutputCap {
  /** Returns `false` once the budget is spent, so the caller can stop reading. */
  push(chunk: Uint8Array): boolean;
  done(): OutputCapResult;
}

/**
 * Accumulates child output against a byte budget.
 *
 * Bytes, not characters, because the budget exists to bound memory and a
 * character is between one and four of them. Decoding happens once at the end,
 * so a chunk boundary landing mid-codepoint cannot produce a replacement
 * character in the middle of otherwise intact output.
 */
export function createOutputCap(maxBytes: number): OutputCap {
  const chunks: Uint8Array[] = [];
  let kept = 0;
  let truncated = false;

  return {
    push(chunk) {
      if (maxBytes <= 0) {
        chunks.push(chunk);
        kept += chunk.byteLength;
        return true;
      }
      const remaining = maxBytes - kept;
      if (remaining <= 0) {
        truncated = true;
        return false;
      }
      if (chunk.byteLength <= remaining) {
        chunks.push(chunk);
        kept += chunk.byteLength;
        return true;
      }
      chunks.push(chunk.subarray(0, remaining));
      kept = maxBytes;
      truncated = true;
      return false;
    },
    done() {
      return { text: Buffer.concat(chunks).toString('utf8'), truncated, bytes: kept };
    },
  };
}
