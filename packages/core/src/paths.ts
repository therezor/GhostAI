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

import { GhostError } from './errors.js';
import { isAgentId } from './agent-id.js';
import { isExtensionId } from './extension-id.js';
import { DEFAULT_WORKSPACE_ID, isWorkspaceId } from './workspace-id.js';

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
export function expandHome(
  inputPath: string,
  home: string = homedir(),
): string {
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
export function resolvePath(
  inputPath: string,
  base: string = process.cwd(),
): string {
  const expanded = expandHome(inputPath);
  return isAbsolute(expanded) ? resolve(expanded) : resolve(base, expanded);
}

/** Every directory and file GhostAI owns, resolved absolute. */
export interface GhostPaths {
  /** `~/.ghostai` unless overridden. Everything below is derived from it. */
  readonly root: string;
  /**
   * The default workspace, and the parent of every named one.
   *
   * A turn in `default` therefore reaches every other workspace's files, which
   * is the deliberate shape: `default` is the broad view and a named workspace
   * is a subtree of it. Named workspaces are isolated from *each other* —
   * `<workspace>/a/link → ../b` resolves outside `a`'s root and the jail
   * refuses it.
   */
  readonly workspace: string;
  /**
   * The parent of every agent's own directory, beside the workspace.
   *
   * **Nothing writes here yet, and memory is no longer what will.** This was
   * described as the home of an agent's memory and skills, on the argument that
   * the jail root *is* the workspace — so anything kept inside it is readable
   * and **writable** by `write_file`, which turns prompt injection into a way of
   * rewriting the agent's own system prompt.
   *
   * That argument is still true, and both features were placed inside the
   * workspace anyway: `<workspace>/skills/` and `<workspace>/memory/`.
   * The trade was taken deliberately in both cases — a skill sheet is meant to
   * be committed beside the project it describes, and memory a person cannot see
   * in a directory listing is memory they cannot correct. `docs/memory.md` and
   * `docs/skills.md` each carry the argument and name the mitigation
   * (`write_file: 'ask'`).
   *
   * The directory and `agentDirFor` are kept because the reasoning above is
   * sound and a per-agent layer may still want it; `paths.test.ts` still asserts
   * it stays outside the workspace.
   */
  readonly agentsDir: string;
  /**
   * The parent of the layer agents working in one folder share.
   *
   * Keyed by workspace, not by agent: this is where facts about a *working
   * folder* live, which is the one thing several agents on one folder have a
   * reason to pool. Outside the jail for the same reason as `agentsDir`.
   */
  readonly sharedDir: string;
  /**
   * Installed toolboxes — one directory per toolbox, each holding a
   * `toolbox.json`.
   *
   * Outside the jail for the same reason as `agentsDir`: a manifest kept inside
   * the workspace would be writable by `write_file`, which turns prompt
   * injection into a way of rewriting the container policy the agent runs
   * under. The approval that makes a manifest usable lives in the database, not
   * here, so a file edited in place stops resolving rather than taking effect.
   */
  readonly toolboxesDir: string;
  /**
   * Sandbox command transcripts, one directory per container.
   *
   * **Outside the workspace, and that is a security boundary rather than
   * tidiness.** These files are written by the *host* process while the container
   * holds the workspace as a writable bind mount. Written inside the workspace, an
   * agent could plant a symlink where the next transcript is about to be created
   * — `ln -s ~/.ssh/authorized_keys .ghost/runs/<id>/stdout.log` — and the host
   * would follow it and write attacker-chosen bytes outside the container, as the
   * GhostAI user. Verified before this moved. The container gets the same files
   * back as a **read-only** mount, so it can still read its own output and cannot
   * create anything in there.
   */
  readonly runsDir: string;
  readonly configFile: string;
  /** One SQLite file: sessions, messages, jobs, runs, auth. */
  readonly dbFile: string;
  readonly logsDir: string;
  /**
   * Installed extensions — one directory per extension, each holding a
   * `ghostai.extension.json` and the code it names.
   *
   * A scan of directories an operator put here, never a package manager's
   * output and never the host's `node_modules`: nothing fetches at install
   * time, which is what keeps an air-gapped install air-gapped.
   */
  readonly extensionsDir: string;
  /**
   * The parent of what an extension writes at runtime.
   *
   * Separate from `extensionsDir`, and that separation is the approval gate
   * rather than tidiness: an extension is authorised by a digest over every
   * byte of its install directory, so state written beside its code would
   * revoke its own approval on the first write.
   */
  readonly extensionDataDir: string;
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

export function resolveGhostPaths(
  options: ResolveGhostPathsOptions = {},
): GhostPaths {
  const home = options.home ?? homedir();
  const env = options.env ?? process.env;
  const rootInput =
    options.root ?? env[HOME_ENV_VAR] ?? join(home, DEFAULT_ROOT_DIRNAME);
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
    agentsDir: join(root, 'agents'),
    sharedDir: join(root, 'shared'),
    toolboxesDir: join(root, 'toolboxes'),
    runsDir: join(root, 'runs'),
    configFile: join(root, 'config.json'),
    dbFile: join(root, 'ghost.db'),
    logsDir: join(root, 'logs'),
    extensionsDir: join(root, 'extensions'),
    extensionDataDir: join(root, 'extension-data'),
    vaultFile: join(root, 'vault.json'),
    keyFile: join(root, 'vault.key'),
  };
}

/**
 * The directory one workspace owns.
 *
 * The **only** place an id becomes a path, which is why it re-validates rather
 * than trusting its caller: ids reach this from a request body, from a query
 * string and from a `workspace_id` column that a determined operator can edit
 * by hand, and a single unchecked call site is the whole containment argument
 * gone. It deliberately does not consult the registry — a workspace that was
 * detached still has sessions, and they must keep resolving to their own files
 * rather than silently falling into someone else's.
 *
 * `default` maps to `paths.workspace` itself. That one special case is the
 * price of "the default workspace is the folder that holds the others", and it
 * is confined to this function.
 */
export function workspaceDirFor(paths: GhostPaths, id: string): string {
  if (id === DEFAULT_WORKSPACE_ID) return paths.workspace;
  if (!isWorkspaceId(id)) {
    throw new GhostError('invalid_input', `Not a workspace id: ${id}`, {
      details: { id },
    });
  }
  return join(paths.workspace, id);
}

/**
 * Creates a directory and returns it, so it composes inside an expression.
 *
 * `0o700` because the workspace holds the credential vault's fallback key,
 * session transcripts, and whatever the agent has been told; the default
 * `0o777 & ~umask` leaves all of that world-readable on a shared host.
 */
/**
 * The directory one agent owns: its memory and its skills.
 *
 * The only place an agent id becomes a path, and it re-validates for the same
 * reason `workspaceDirFor` does — the id reaches here from a WebSocket frame,
 * a request body and an `agent_id` column an operator can edit by hand.
 *
 * Unlike a workspace, `default` gets a directory of its own rather than the
 * parent: there is nothing for it to be the parent *of*, and an agent whose
 * memory sat one level up would see every other agent's.
 */
export function agentDirFor(paths: GhostPaths, id: string): string {
  if (!isAgentId(id)) {
    throw new GhostError('invalid_input', `Not an agent id: ${id}`, {
      details: { id },
    });
  }
  return join(paths.agentsDir, id);
}

/**
 * The directory holding what every agent in one workspace may share.
 *
 * Takes a *workspace* id, and validates it as one — the sharing axis is the
 * working folder, so an agent id here would be a category error that happened
 * to typecheck.
 */
export function sharedDirFor(paths: GhostPaths, workspaceId: string): string {
  if (!isWorkspaceId(workspaceId)) {
    throw new GhostError(
      'invalid_input',
      `Not a workspace id: ${workspaceId}`,
      {
        details: { id: workspaceId },
      },
    );
  }
  return join(paths.sharedDir, workspaceId);
}

/**
 * Where one extension is installed.
 *
 * Re-validates for the reason `agentDirFor` does — an extension id reaches here
 * from a `readdir`, from a route parameter and from `extensions.disabled` in a
 * hand-edited config file, and a single unchecked call site is the containment
 * argument gone.
 */
export function extensionDirFor(paths: GhostPaths, id: string): string {
  return join(paths.extensionsDir, assertExtensionId(id));
}

/**
 * Where one extension may write.
 *
 * A sibling of the install directory rather than a child of it, because the
 * install directory's every byte is what the operator approved: state written
 * inside it would move the digest and revoke the approval on the first write.
 */
export function extensionDataDirFor(paths: GhostPaths, id: string): string {
  return join(paths.extensionDataDir, assertExtensionId(id));
}

function assertExtensionId(id: string): string {
  if (!isExtensionId(id)) {
    throw new GhostError('invalid_input', `Not an extension id: ${id}`, {
      details: { id },
    });
  }
  return id;
}

export function ensureDir(dir: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}
