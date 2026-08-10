/**
 * Copying skill sheets out of the catalogue and into a workspace.
 *
 * A preset's `skills` list names directories under `<catalogue>/skills/`; this
 * copies each one to `<workspace>/skills/<name>/`, byte for byte. Both
 * `ghostai preset install` and `ghostai agent install` need it, which is why it
 * is here rather than inside either — the same reason `planInstall` is shared.
 *
 * ## It is a copy, not an install
 *
 * Nothing is rewritten on the way in, and nothing records afterwards that a
 * sheet arrived with a preset. The sheet declares its own `agents:` line, so
 * what an operator reads in the catalogue is what lands in the workspace, and
 * editing it afterwards is editing their own file rather than diverging from
 * something. There is no approval gate and no hash: a sheet is prose, and the
 * preset's own `systemPrompt` — unapproved prose from the same catalogue,
 * already — sets the bar. Running the command is the operator action.
 *
 * ## Nothing here refuses
 *
 * A missing sheet, a symlink, a sheet over the bounds: each costs that sheet and
 * a line in the report. This is deliberately unlike the toolbox half, which
 * refuses — and the asymmetry is the point. An agent whose toolbox is missing
 * cannot run at all, so accepting the entry would write a config the server
 * refuses to boot on. An agent missing a sheet runs, with one fewer index line.
 *
 * ## The bounds are a floor under a bad publish
 *
 * Not a security boundary. The names have already been through
 * `SLUG_ID_PATTERN` at the schema, so a traversal cannot be represented by the
 * time it reaches here; what is left is a catalogue that shipped something
 * enormous by accident, and the answer to that is a warning rather than a
 * half-filled disk.
 */

import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import { join } from 'node:path';

import { SKILLS_DIRNAME, parseSkillAgents } from '@ghostwire/agent';
import {
  DEFAULT_WORKSPACE_ID,
  GhostError,
  parseFrontmatter,
  silentLogger,
  workspaceDirFor,
  type GhostPaths,
} from '@ghostwire/core';

/** Files in one sheet directory. A sheet is a page and its attachments. */
export const MAX_SKILL_FILES = 64;

/**
 * One file in a sheet directory.
 *
 * Deliberately not `SKILL_MAX_BYTES`, which is a *prompt* budget for the page
 * itself. A sheet directory legitimately holds a checklist, a template or a
 * script, and none of those reach the prompt unless the model opens them.
 */
export const MAX_SKILL_FILE_BYTES: number = 1024 * 1024;

/** Everything one install writes, across every sheet. */
export const MAX_SKILL_TOTAL_BYTES: number = 8 * 1024 * 1024;

/** How deep a sheet directory may nest. */
export const MAX_SKILL_DEPTH = 4;

export interface SkillInstallRequest {
  /** The preset asking, used only for the scope cross-check. */
  readonly presetId: string;
  /** Sheet directory names, already `SLUG_ID_PATTERN` by the schema. */
  readonly names: readonly string[];
  /** The catalogue's `skills/`. Absent means every name is missing. */
  readonly catalogueSkillsDir?: string | undefined;
  /** `<workspace>/skills`. Absent skips the copy entirely. */
  readonly targetDir?: string | undefined;
  /** Overwrite a sheet directory the workspace already has. */
  readonly force: boolean;
}

export interface SkillInstallResult {
  /** Sheets written, with how many files each took. */
  readonly written: ReadonlyArray<{
    readonly name: string;
    readonly files: number;
  }>;
  /** Already in the workspace, and left alone. */
  readonly kept: readonly string[];
  /** Named by a preset, not in this catalogue. */
  readonly missing: readonly string[];
  /** One line each, already phrased for the report. */
  readonly warnings: readonly string[];
}

const EMPTY: SkillInstallResult = {
  written: [],
  kept: [],
  missing: [],
  warnings: [],
};

/**
 * Copies the sheets a preset names, and reports rather than throws.
 *
 * Synchronous for the same reason the rest of the install path is: this runs
 * once at a terminal, between a `saveConfig` and a printed report, and an async
 * seam here would buy nothing but a colour on every call site.
 */
export function installSkills(
  request: SkillInstallRequest,
): SkillInstallResult {
  const { names, targetDir } = request;
  if (names.length === 0 || targetDir === undefined) return EMPTY;

  const written: Array<{ name: string; files: number }> = [];
  const kept: string[] = [];
  const missing: string[] = [];
  const warnings: string[] = [];
  const budget = { bytes: MAX_SKILL_TOTAL_BYTES };

  for (const name of names) {
    const source = sheetDir(request.catalogueSkillsDir, name);
    if (source === undefined) {
      missing.push(name);
      continue;
    }

    const destination = join(targetDir, name);
    if (existsSync(destination) && !request.force) {
      kept.push(name);
      continue;
    }

    const copied = copyTree(source, destination, budget, warnings, name);
    if (copied === undefined) continue;

    written.push({ name, files: copied });
    const mismatch = scopeMismatch(source, name, request.presetId);
    if (mismatch !== undefined) warnings.push(mismatch);
  }

  return { written, kept, missing, warnings };
}

/**
 * Where a workspace's sheets go.
 *
 * **Resolution only — nothing is created here.** Every install path calls this
 * while working out its paths, long before it knows whether any preset names a
 * sheet, so a `mkdir` in here would create `<root>/workspace` on every
 * `ghostai agent install` and would turn an unwritable root into an `ENOENT`
 * thrown over whatever the real error was. The directories are made by the copy,
 * which happens only when there is something to write.
 *
 * A named workspace must already exist, and that check *is* this function's
 * job: `workspaceDirFor` validates the *shape* of an id and joins, never
 * consulting the registry, which lives in SQLite. So `-W typo` would otherwise
 * make a tree no UI ever lists and nothing ever reads.
 */
export function skillsTargetDir(
  paths: GhostPaths,
  workspaceId: string,
): string {
  if (workspaceId === DEFAULT_WORKSPACE_ID) {
    return join(paths.workspace, SKILLS_DIRNAME);
  }

  const dir = workspaceDirFor(paths, workspaceId);
  if (!existsSync(dir)) {
    throw new GhostError(
      'invalid_input',
      `There is no ${workspaceId} workspace at ${dir}.\n` +
        '  Workspaces are created in the web UI, or by a session bound to one.\n' +
        '  Leave -W off to install into the default workspace.',
      { details: { workspaceId, dir } },
    );
  }
  return join(dir, SKILLS_DIRNAME);
}

/** The catalogue's copy of one sheet, if it has one with a `SKILL.md`. */
function sheetDir(
  skillsDir: string | undefined,
  name: string,
): string | undefined {
  if (skillsDir === undefined) return undefined;
  const dir = join(skillsDir, name);
  // `lstat`, so a symlinked sheet directory is not followed out of the
  // catalogue — the same property `readSkills` gets free from `Dirent`.
  if (!existsSync(join(dir, 'SKILL.md'))) return undefined;
  return lstatSync(dir).isDirectory() ? dir : undefined;
}

/**
 * Copies one sheet, or reports why it stopped.
 *
 * Returns the file count, or `undefined` when a bound was hit — in which case
 * whatever was already written stays. Rolling back would mean deleting files in
 * a directory an operator may have put things in, which is a larger claim than
 * this has any business making.
 */
function copyTree(
  source: string,
  destination: string,
  budget: { bytes: number },
  warnings: string[],
  name: string,
): number | undefined {
  let files = 0;
  const stack: Array<{ from: string; to: string; depth: number }> = [
    { from: source, to: destination, depth: 0 },
  ];

  while (stack.length > 0) {
    const level = stack.pop();
    if (level === undefined) break;

    if (level.depth > MAX_SKILL_DEPTH) {
      warnings.push(
        `skill "${name}" nests deeper than ${String(MAX_SKILL_DEPTH)} levels; the rest was not copied`,
      );
      return undefined;
    }

    mkdirSync(level.to, { recursive: true, mode: 0o700 });

    for (const entry of readdirSync(level.from, { withFileTypes: true })) {
      const from = join(level.from, entry.name);

      // Neither followed nor copied as a link. A catalogue is npm's output, so
      // a link in one is a packaging accident rather than an attack — but
      // following it would copy from outside the catalogue, and recreating it
      // would put a dangling link in the workspace.
      if (entry.isSymbolicLink()) {
        warnings.push(
          `skill "${name}" contains a symlink (${entry.name}), which was skipped`,
        );
        continue;
      }

      if (entry.isDirectory()) {
        stack.push({
          from,
          to: join(level.to, entry.name),
          depth: level.depth + 1,
        });
        continue;
      }

      if (!entry.isFile()) continue;

      files += 1;
      if (files > MAX_SKILL_FILES) {
        warnings.push(
          `skill "${name}" holds more than ${String(MAX_SKILL_FILES)} files; the rest was not copied`,
        );
        return undefined;
      }

      const bytes = lstatSync(from).size;
      if (bytes > MAX_SKILL_FILE_BYTES) {
        warnings.push(
          `skill "${name}" has a file over ${String(MAX_SKILL_FILE_BYTES / 1024)} KB (${entry.name}), which was skipped`,
        );
        files -= 1;
        continue;
      }

      budget.bytes -= bytes;
      if (budget.bytes < 0) {
        warnings.push(
          `the sheets came to more than ${String(MAX_SKILL_TOTAL_BYTES / 1024 / 1024)} MB; "${name}" was not finished`,
        );
        return undefined;
      }

      copyFileSync(from, join(level.to, entry.name));
    }
  }

  return files;
}

/**
 * The warning for a sheet scoped away from the agent that brought it.
 *
 * Only when the sheet names agents and this preset is not among them. An absent
 * or empty `agents:` means every agent, which includes this one, so it is not a
 * mismatch — stated here because "it did not warn" should read as a decision
 * rather than as a case nobody thought about.
 *
 * `silentLogger` on purpose. A malformed `agents:` line is the *workspace's*
 * problem once the sheet is copied, and `readSkill` warns about it on the turn
 * that reads it, where the operator can act on it. Warning here as well would
 * report the same file twice for one mistake, in a command whose output is
 * about what it installed.
 */
function scopeMismatch(
  source: string,
  name: string,
  presetId: string,
): string | undefined {
  let text: string;
  try {
    text = readFileSync(join(source, 'SKILL.md'), 'utf8');
  } catch {
    // `sheetDir` already proved the file is there, so this is a race or a
    // permission problem — either way not worth a line about scope.
    return undefined;
  }

  const agents = parseSkillAgents(parseFrontmatter(text).fields.agents, {
    skill: name,
    logger: silentLogger,
  });
  if (agents.length === 0 || agents.includes(presetId.toLowerCase())) {
    return undefined;
  }

  return `skill "${name}" is scoped to ${agents.join(', ')}, so the ${presetId} agent will not see it`;
}
