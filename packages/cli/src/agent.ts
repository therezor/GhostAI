/**
 * `ghost agent` — install agent presets, and list agents and presets.
 *
 * `install` is a config merge, not a package manager. A preset is a JSON file
 * already on the box — bundled in this CLI, installed beside a toolbox
 * manifest by `build.sh`, or written by an operator — and installing it writes
 * one entry into `agents.list` in `config.json`. Nothing is fetched, and after
 * the write the entry is ordinary agent config the web UI edits like any
 * other.
 *
 * The argument is either a path — anything with a separator, a `.json` suffix,
 * or that exists as a file — or a preset id looked up in the directories
 * `presetDirs` names, operator's before shipped. There is one preset format and
 * one place ids are searched; an agent that needs a container is not a
 * different kind of preset, it is a preset whose `toolbox.name` is set. See
 * `presets.ts`.
 *
 * Two refusals do the real work:
 *
 *  - **A preset naming an unapproved toolbox does not install.** An enabled
 *    agent whose toolbox fails `require` makes the runtime's build throw, so
 *    accepting the entry would write a config the server refuses to boot on.
 *    The refusal happens here, where the message can name the fix.
 *  - **An id that already exists needs `--force`.** The existing entry may
 *    carry an operator's edits, and a re-run of `build.sh` plus a reinstall
 *    must not destroy them silently.
 *
 * A preset's `subagents` list is a roster of *other* preset agents, filtered
 * at install time to the ones installed and enabled — the model is never
 * offered a specialist that cannot answer. Re-running with `--force` after
 * installing more of them refreshes the snapshot.
 */

import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import {
  GhostError,
  loadConfig,
  saveConfig,
  type GhostPaths,
} from '@ghostbot/core';
import {
  DEFAULT_AGENT_ID,
  RESERVED_AGENT_IDS,
  isAgentId,
  presetToAgentEntry,
  type AgentPreset,
  type Config,
} from '@ghostbot/protocol';
import { ToolboxStore, assertNetworkWithinCeiling } from '@ghostbot/security';

import { catalogueAgentsDir, catalogueDir } from './catalogue.js';
import type { Translations } from './i18n.js';
import {
  findPreset,
  listAllPresets,
  presetDirs,
  readPreset,
} from './presets.js';

interface AgentCliOptions {
  readonly action: 'install' | 'list';
  /** The preset to install: a path, a toolbox name, or a preset name. */
  readonly name?: string | undefined;
  /** Overwrite an existing `agents.list` entry with the same id. */
  readonly force?: boolean;
  readonly home?: string | undefined;
  readonly out: (line: string) => void;
  readonly errOut: (line: string) => void;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly t: Translations;
}

/**
 * The slice of `GhostPaths` this command reads, plus nothing else.
 *
 * Named rather than taken whole so a test can point the directories wherever
 * it likes without standing up a whole resolved install.
 */
export interface PresetPaths {
  readonly toolboxesDir: string;
  readonly presetsDir: string;
  readonly dbFile: string;
  /**
   * The catalogue's `agents/`, when there is a catalogue. `undefined` is the
   * ordinary state on a fresh install and narrows the search to the operator's
   * own presets rather than failing.
   */
  readonly catalogueAgentsDir?: string | undefined;
}

export function resolvePreset(arg: string, paths: PresetPaths): AgentPreset {
  // A separator or a `.json` suffix is an explicit path even when the file is
  // missing — resolving `./typo.json` to a shipped preset would install
  // something other than what was named.
  const explicitPath =
    arg.includes('/') || arg.includes('\\') || arg.endsWith('.json');
  if (explicitPath || existsSync(arg)) return readPreset(arg);

  const dirs = presetDirs(paths.presetsDir, paths.catalogueAgentsDir);
  const found = findPreset(dirs, arg);
  if (found !== undefined) return readPreset(found);

  const available = listAllPresets(dirs);
  throw new GhostError(
    'invalid_input',
    `No preset is available under "${arg}".\n` +
      `  Pass a preset file, or one of: ${available.join(', ')}.`,
    { details: { name: arg, available } },
  );
}

/** The rule `assertWritableAgentIds` applies to a settings save, applied here. */
function assertInstallableId(id: string): void {
  if (id === DEFAULT_AGENT_ID) return;
  if (isAgentId(id) && !RESERVED_AGENT_IDS.has(id)) return;
  throw new GhostError(
    'invalid_input',
    `"${id}" cannot be used as an agent id.\n` +
      '  Ids are lower-case letters, digits and hyphens, up to 40 characters,\n' +
      '  and cannot be a reserved device name.',
    { details: { agentId: id } },
  );
}

/**
 * What one preset would do to the config, or why it cannot.
 *
 * Every rule an install applies lives behind this one function, because there
 * are two callers — `ghost agent install` and the bulk installer — and a rule
 * that existed twice would be a rule that disagrees with itself. The single
 * install turns a `blocked` into a `GhostError`; the bulk one turns it into a
 * line in its report and carries on.
 */
export type InstallPlan =
  | {
      readonly ok: true;
      readonly preset: AgentPreset;
      readonly config: Config;
      readonly overwrote: boolean;
      /** Subagents left out because they are not installed or not enabled. */
      readonly skipped: readonly string[];
      readonly tools: number;
    }
  | { readonly ok: false; readonly id: string; readonly reason: string };

export function planInstall(
  preset: AgentPreset,
  config: Config,
  paths: PresetPaths,
  force: boolean,
): InstallPlan {
  assertInstallableId(preset.id);

  if (preset.toolbox.name !== '') {
    // The same checks the runtime's build applies, run before the write: an
    // entry that fails them is a config the server refuses to boot on.
    const database = new DatabaseSync(paths.dbFile);
    try {
      const store = new ToolboxStore({ database, dir: paths.toolboxesDir });
      const approved = store.require(preset.toolbox.name);
      assertNetworkWithinCeiling(
        approved.toolbox,
        preset.toolbox.network,
        preset.id,
      );
    } catch (error) {
      return {
        ok: false,
        id: preset.id,
        reason: error instanceof GhostError ? error.message : String(error),
      };
    } finally {
      database.close();
    }
  }

  const existing = config.agents.list[preset.id];
  if (existing !== undefined && !force) {
    return {
      ok: false,
      id: preset.id,
      reason:
        `An agent named "${preset.id}" already exists and may carry your own edits.\n` +
        `  Re-run with --force to overwrite it with the preset.`,
    };
  }

  // The roster snapshot: only specialists that are installed and enabled are
  // offered to the model. `--force` re-runs refresh it.
  const roster = preset.subagents.filter(
    (ref) => config.agents.list[ref.id]?.enabled === true,
  );
  const entry = { ...presetToAgentEntry(preset), subagents: roster };

  return {
    ok: true,
    preset,
    config: {
      ...config,
      agents: {
        ...config.agents,
        list: { ...config.agents.list, [preset.id]: entry },
      },
    },
    overwrote: existing !== undefined,
    skipped: preset.subagents
      .filter((ref) => config.agents.list[ref.id]?.enabled !== true)
      .map((ref) => ref.id),
    tools: Object.keys(entry.tools).length,
  };
}

function install(
  options: AgentCliOptions,
  config: Config,
  file: string,
  paths: PresetPaths,
): number {
  const { out } = options;
  const preset = resolvePreset(options.name ?? '', paths);
  const plan = planInstall(preset, config, paths, options.force === true);
  if (!plan.ok) {
    throw new GhostError('invalid_input', plan.reason, {
      details: { agentId: plan.id },
    });
  }

  saveConfig(file, plan.config);

  out(
    `Installed ${preset.id}${plan.overwrote ? ' (overwrote the existing agent)' : ''}:`,
  );
  out(`    label      ${preset.label === '' ? preset.id : preset.label}`);
  out(
    `    toolbox    ${preset.toolbox.name === '' ? 'none — commands run on this machine' : preset.toolbox.name}`,
  );
  out(`    tools      ${String(plan.tools)} granted`);
  const roster = plan.config.agents.list[preset.id]?.subagents ?? [];
  if (roster.length > 0) {
    out(`    delegates  ${roster.map((ref) => ref.id).join(', ')}`);
  }
  for (const id of plan.skipped) {
    out(
      `    skipped    subagent "${id}" — not installed or disabled.` +
        ` Install it, then re-run with --force to refresh the roster.`,
    );
  }
  out('');
  out('Edit it any time in the web UI under Agents. A running server picks');
  out('this up on its next settings save or restart.');
  return 0;
}

function list(
  options: AgentCliOptions,
  config: Config,
  paths: PresetPaths,
): number {
  const { out } = options;
  const entries = Object.entries(config.agents.list);

  if (entries.length === 0) {
    out('No agents are configured; sessions run as the built-in default.');
  }
  for (const [id, entry] of entries) {
    out(`${id}  [${entry.enabled ? 'enabled' : 'disabled'}]`);
    if (entry.label !== '') out(`    label      ${entry.label}`);
    if (entry.toolbox.name !== '') out(`    toolbox    ${entry.toolbox.name}`);
    if (entry.subagents.length > 0) {
      out(`    delegates  ${entry.subagents.map((ref) => ref.id).join(', ')}`);
    }
    out('');
  }

  // The filename is the agent id, so an id already in `agents.list` is one
  // already installed — no file has to be opened to know that.
  const available = listAllPresets(
    presetDirs(paths.presetsDir, paths.catalogueAgentsDir),
  ).filter((id) => config.agents.list[id] === undefined);
  if (available.length > 0) {
    out(`Presets not yet installed: ${available.join(', ')}`);
    // One line rather than one per id, and it names the *other* command,
    // because that is the one that also builds the toolbox an agent needs.
    // `ghost agent install <id>` still works and is what a script wants; a
    // person picking from a list wants the picker.
    out('    ghost preset install');
  }
  return 0;
}

/** `PresetPaths` for this invocation, with the catalogue looked up once. */
function presetPathsOf(
  paths: GhostPaths,
  options: AgentCliOptions,
): PresetPaths {
  const dir = catalogueDir({
    catalogueDir: paths.catalogueDir,
    ...(options.env === undefined ? {} : { env: options.env }),
  });
  return {
    toolboxesDir: paths.toolboxesDir,
    presetsDir: paths.presetsDir,
    dbFile: paths.dbFile,
    catalogueAgentsDir: dir === undefined ? undefined : catalogueAgentsDir(dir),
  };
}

export function runAgent(options: AgentCliOptions): number {
  const { errOut } = options;

  try {
    const loaded = loadConfig({
      ...(options.home === undefined ? {} : { root: options.home }),
      ...(options.env === undefined ? {} : { env: options.env }),
    });

    const paths = presetPathsOf(loaded.paths, options);

    if (options.action === 'list') {
      return list(options, loaded.config, paths);
    }

    if (options.name === undefined || options.name === '') {
      errOut(
        'Which preset? Pass a preset id or a file — see `ghost agent list`.',
      );
      return 2;
    }
    return install(options, loaded.config, loaded.file, paths);
  } catch (error) {
    // `GhostError` messages are written to be read by the person who caused
    // them — they already name the file and what to do next.
    errOut(error instanceof GhostError ? error.message : String(error));
    return 1;
  }
}
