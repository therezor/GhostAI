/**
 * Where things live on disk.
 *
 * The config schema stores paths exactly as the user typed them — `~` and all —
 * because a schema that expanded `~` at parse time would produce a machine's
 * home directory in the config file the moment anything wrote it back, which
 * makes a config non-portable and a Docker mount silently wrong. Expansion is
 * therefore a load-time step, and this is where it happens.
 *
 * These helpers know nothing about *safety*. Resolving a path here does not
 * make it legal for a tool to touch: that is `WorkspaceJail` in
 * `@ghostai/security`, which verifies through `realpath` and is the only thing
 * that may decide an agent-supplied path is acceptable.
 */

import { homedir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { mkdirSync } from 'node:fs';

/** Overrides the root for tests, CI, and multi-instance installs. */
export const HOME_ENV_VAR = 'GHOSTAI_HOME';

const DEFAULT_ROOT_DIRNAME = '.ghostai';

/**
 * Expands a leading `~` to the home directory.
 *
 * Only a bare `~` or a `~/`-prefixed path expands. `~user` is left untouched:
 * resolving another account's home requires a passwd lookup, and silently
 * treating `~alice` as a *relative directory named `~alice`* is both what the
 * shell would not do and the more predictable of the two wrong answers.
 */
export function expandHome(inputPath: string, home: string = homedir()): string {
  if (inputPath === '~') return home;
  if (inputPath.startsWith('~/') || inputPath.startsWith(`~${sep}`)) {
    return join(home, inputPath.slice(2));
  }
  return inputPath;
}

/**
 * Expands `~` and resolves to an absolute path against `base`.
 *
 * `base` defaults to the process working directory, which is only correct for
 * paths that came from a CLI argument. Anything originating in config passes
 * the config file's directory, so a relative `workspace` means "beside the
 * config" rather than "wherever the service happened to be started from".
 */
export function resolvePath(inputPath: string, base: string = process.cwd()): string {
  const expanded = expandHome(inputPath);
  return isAbsolute(expanded) ? resolve(expanded) : resolve(base, expanded);
}

/** Every directory and file GhostAI owns, resolved absolute. */
export interface GhostPaths {
  /** `~/.ghostai` unless overridden. Everything below is derived from it. */
  readonly root: string;
  /** The only tree the agent's filesystem tools may reach. */
  readonly workspace: string;
  readonly configFile: string;
  /** One SQLite file: sessions, messages, jobs, runs, auth, KB vectors. */
  readonly dbFile: string;
  readonly logsDir: string;
  /** A private npm project, never a scan of the host's `node_modules`. */
  readonly pluginsDir: string;
  /** The encrypted credential store. Ciphertext only — safe beside the config. */
  readonly vaultFile: string;
  /** The vault's key file, used only when no OS keychain is available. */
  readonly keyFile: string;
}

export interface ResolveGhostPathsOptions {
  /** Wins over `GHOSTAI_HOME`, which wins over `~/.ghostai`. */
  readonly root?: string;
  /** Defaults to `<root>/workspace`. */
  readonly workspace?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly home?: string;
}

export function resolveGhostPaths(options: ResolveGhostPathsOptions = {}): GhostPaths {
  const home = options.home ?? homedir();
  const env = options.env ?? process.env;
  const rootInput = options.root ?? env[HOME_ENV_VAR] ?? join(home, DEFAULT_ROOT_DIRNAME);
  const root = resolve(expandHome(rootInput, home));

  return {
    root,
    // Relative to the root, not the cwd: a workspace that moved because a
    // service was restarted from a different directory would orphan the
    // agent's memory files while leaving the database pointing at them.
    // Expanded against `home` here rather than left to `resolvePath`, whose
    // own default is the process home — the two must not disagree when a
    // caller supplied one.
    workspace:
      options.workspace === undefined
        ? join(root, 'workspace')
        : resolvePath(expandHome(options.workspace, home), root),
    configFile: join(root, 'config.json'),
    dbFile: join(root, 'ghost.db'),
    logsDir: join(root, 'logs'),
    pluginsDir: join(root, 'plugins'),
    vaultFile: join(root, 'vault.json'),
    keyFile: join(root, 'vault.key'),
  };
}

/**
 * Creates a directory and returns it, so it composes inside an expression.
 *
 * `0o700` because the workspace holds the credential vault's fallback key,
 * session transcripts, and whatever the agent has been told; the default
 * `0o777 & ~umask` leaves all of that world-readable on a shared host.
 */
export function ensureDir(dir: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}
