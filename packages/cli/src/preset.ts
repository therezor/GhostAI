/**
 * `ghostai preset` — pick agents from the catalogue, and get the boxes they need.
 *
 * This replaces `ghost install`, which built every shipped toolbox and
 * installed every shipped agent because both shipped inside the CLI and there
 * was nothing to choose between. The catalogue is a package of its own now, so
 * the question "which of these do you actually want" is a real one — and the
 * answer decides which images get built, which is the difference between one
 * `docker build` and six.
 *
 * **A toolbox is built because an agent asked for it, never on its own.** The
 * selection is a list of agents; the boxes fall out of `toolbox.name` on the
 * ones chosen. That is why there is no `--presets-only` any more: choosing only
 * agents that need no container *is* the flag, and it is a checkbox rather than
 * something to remember.
 *
 * **It stops short of approving anything unless somebody says so, and prints
 * the policy before it asks.** Building an image and installing its manifest
 * are reversible, mechanical steps; approving one is a statement that a person
 * read what that container may do — its network ceiling, the capabilities it
 * adds back, the hardening it switches off. A prompt showing only names would
 * make that sentence false, so this run ends up printing a screen of policy
 * before a `y`. That is the right trade for the one action here that re-running
 * cannot undo.
 *
 * Everything that touches the world is injected — the fetcher, the image
 * builder, the daemon probe, the prompt — so the tests need neither a registry
 * nor a daemon nor a terminal.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { GhostError, ensureDir, loadConfig, saveConfig } from '@ghostwire/core';
import { dockerEngine } from '@ghostwire/runtime';
import { ToolboxStore, weakenedIn } from '@ghostwire/security';
import {
  DEFAULT_WORKSPACE_ID,
  TOOLBOX_DEFAULT_KEY,
  type AgentEntry,
  type AgentPreset,
  type Config,
  type Toolbox,
} from '@ghostwire/protocol';

import { planInstall, type PresetPaths } from './agent.js';
import type { Ask } from './ask.js';
import {
  CATALOGUE_PACKAGE,
  assertCatalogueLayout,
  catalogueDir,
  catalogueSkillsDir,
  catalogueToolbox,
  fetchCatalogue,
  type Fetcher,
} from './catalogue.js';
import type { CliT, Translations } from './i18n.js';
import {
  installSkills,
  skillsTargetDir,
  type SkillInstallResult,
} from './skill-install.js';
import {
  findPreset,
  listAllPresets,
  presetDirs,
  readPreset,
} from './presets.js';

/** The placeholder `build.sh` and this both replace with the built image id. */
const IMAGE_PLACEHOLDER = '__IMAGE_ID__';

/**
 * Builds one image and returns its id.
 *
 * Injected, so the tests exercise every branch around it without a daemon. The
 * default streams the build rather than buffering it — an image that takes four
 * minutes with no output looks hung — and takes no timeout, because a first
 * build downloads base layers over whatever link the machine has.
 */
export type ImageBuilder = (context: string, tag: string) => string;

export interface PresetOptions {
  readonly action: 'list' | 'install' | 'update';
  /** Preset ids from the command line. Empty means ask, when there is an `ask`. */
  readonly ids?: readonly string[];
  /** A checkout of the presets repository, instead of the fetched copy. */
  readonly from?: string | undefined;
  /** Fetch before reading, even when a copy is already here. */
  readonly refresh?: boolean;
  /** Never fetch. An air-gapped install, or one that knows what it has. */
  readonly offline?: boolean;
  /** Overwrite an `agents.list` entry that may carry an operator's edits. */
  readonly force?: boolean;
  /**
   * Which workspace a preset's skill sheets are copied into.
   *
   * Absent is `default`. A preset is workspace-agnostic — it writes an
   * `agents.list` entry, which every workspace shares — but a sheet lives in
   * one, so this is the one thing an install has to be told.
   */
  readonly workspaceId?: string | undefined;
  /**
   * Approve what this run installs. `undefined` means ask, when `ask` is there
   * to ask with — and approve nothing when it is not.
   */
  readonly approve?: boolean | undefined;
  /**
   * The prompts. Absent means nothing here is interactive: a pipe, a CI job, or
   * a run that named its ids on the command line.
   *
   * Passed in rather than opened here because a caller may already hold a
   * readline on the same stdin, and two readers fight over keypresses.
   */
  readonly ask?: Ask | undefined;
  readonly home?: string | undefined;
  readonly out: (line: string) => void;
  readonly errOut: (line: string) => void;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly t: Translations;
  /** Injected in tests. Defaults to a real `docker build`. */
  readonly build?: ImageBuilder;
  /** Injected in tests. Throws when the daemon is unreachable. */
  readonly probe?: () => void;
  /** Injected in tests. Defaults to a real `npm install`. */
  readonly fetch?: Fetcher;
}

function dockerBuild(context: string, tag: string): string {
  // `--iidfile` rather than parsing stdout: the latter is racy when two builds
  // run and reports a short id that cannot be pinned. Same argument as the
  // presets repository's `build.sh`, which is the other implementation of this.
  const iidFile = join(
    process.env.TMPDIR ?? '/tmp',
    `ghostai-iid-${tag.replace(/[^a-z0-9]/gi, '-')}`,
  );
  const result = spawnSync(
    'docker',
    ['build', '--iidfile', iidFile, '-t', tag, context],
    { stdio: 'inherit', windowsHide: true },
  );
  if (result.error !== undefined) {
    throw new GhostError(
      'tool',
      `Could not run docker: ${result.error.message}`,
      { cause: result.error },
    );
  }
  if (result.status !== 0) {
    throw new GhostError('tool', `docker build failed for ${tag}`);
  }

  const id = readFileSync(iidFile, 'utf8').trim();
  if (!/^sha256:[0-9a-f]{64}$/.test(id)) {
    throw new GhostError('tool', `Unexpected image id for ${tag}: ${id}`);
  }
  return id;
}

/** Everything an operator has to weigh before approving. Mirrors `toolbox.ts`. */
function describe(toolbox: Toolbox): readonly string[] {
  const lines = [
    `    image      ${toolbox.image}`,
    `    network    ${toolbox.network.maxMode}`,
    `    limits     ${String(toolbox.limits.memoryMb)} MB, ${String(toolbox.limits.cpus)} cpu`,
  ];
  if (toolbox.caps.add.length > 0) {
    lines.push(`    caps       +${toolbox.caps.add.join(' +')}`);
  }
  for (const warning of weakenedIn(toolbox)) {
    lines.push(`    ${warning}  <-- review this`);
  }
  return lines;
}

/** Builds one toolbox and installs its manifest. Never approves it. */
function installToolbox(
  name: string,
  context: string,
  paths: { readonly toolboxesDir: string },
  build: ImageBuilder,
): void {
  const imageId = build(context, `ghostai/${name}:local`);

  const target = join(paths.toolboxesDir, name);
  mkdirSync(target, { recursive: true });
  // The placeholder is replaced rather than the file generated, so the manifest
  // an operator reviews in the catalogue is the manifest that gets installed
  // apart from one field.
  const manifest = readFileSync(join(context, 'toolbox.json'), 'utf8').replace(
    IMAGE_PLACEHOLDER,
    imageId,
  );
  writeFileSync(join(target, 'toolbox.json'), manifest);
}

/** One row of the picker, and everything the report needs about it. */
interface Offer {
  readonly id: string;
  readonly preset: AgentPreset;
  readonly installed: boolean;
}

/**
 * Every preset on offer, operator's own and the catalogue's, deduplicated.
 *
 * Reads each one, unlike `ghostai agent list` which reads only names: this has to
 * show the toolbox and the label, and it is about to install them anyway. A
 * file that does not parse is a line in the report rather than the end of the
 * run — one broken preset in a directory must not hide the other seven.
 */
function offers(
  paths: PresetPaths,
  config: Config,
  warn: (line: string) => void,
): readonly Offer[] {
  const dirs = presetDirs(paths.presetsDir, paths.catalogueAgentsDir);
  const found: Offer[] = [];
  for (const id of listAllPresets(dirs)) {
    // Operator's directory first, so a local preset of the same name wins —
    // the same resolution `ghostai agent install <id>` uses, through the same
    // function, because two answers to "which file is `coder`" is a bug
    // waiting for somebody to hit it.
    const path = findPreset(dirs, id);
    if (path === undefined) continue;
    try {
      found.push({
        id,
        preset: readPreset(path),
        installed: config.agents.list[id] !== undefined,
      });
    } catch (error) {
      warn(
        `    skipped    ${id} — ${error instanceof GhostError ? firstLine(error.message) : String(error)}`,
      );
    }
  }
  return found;
}

/** The first line of a multi-line message, for a report that wants one. */
function firstLine(message: string): string {
  return message.split('\n')[0] ?? message;
}

/** `<label> — runs in <toolbox>`, which is what the choice actually turns on. */
function labelOf(offer: Offer, t: CliT): string {
  const label = offer.preset.label === '' ? offer.id : offer.preset.label;
  const box =
    offer.preset.toolbox.name === ''
      ? ''
      : `  ${offer.preset.toolbox.name}${describeGrant(offer.preset, t)}`;
  return `${offer.id}${label === offer.id ? '' : ` (${label})`}${box}`;
}

/**
 * How much of the box this preset asked for, when it did not ask for all of it.
 *
 * Worth a few characters in the picker because it is the difference between two
 * agents that name the same toolbox — and because an operator scanning the list
 * has no other way to see that one of them is getting four programs of
 * twenty-four.
 */
function describeGrant(preset: AgentPreset, t: CliT): string {
  const overrides = preset.toolbox.tools;
  if (overrides[TOOLBOX_DEFAULT_KEY] === undefined) return '';
  const named = Object.entries(overrides).filter(
    ([name, permission]) =>
      name !== TOOLBOX_DEFAULT_KEY && permission !== 'deny',
  );
  return ` (${t('preset.tools', { count: named.length })})`;
}

/**
 * The catalogue this run reads, fetching it first when that is called for.
 *
 * Three questions in order, and the order is the whole of it:
 *
 *  1. **Was a directory named?** Then that is the answer or the error, and
 *     nothing is fetched either way. Somebody pointing `--from` at a checkout
 *     is testing *that checkout*, and quietly using a registry copy instead is
 *     how a preset gets published without ever having been run. `--refresh`
 *     and `update` have nothing to do against one, so they say so rather than
 *     appearing to work.
 *  2. **Is a copy here, and is it good enough?** `--refresh` and
 *     `ghostai preset update` are the two ways of saying it is not.
 *  3. Otherwise fetch, unless `--offline` forbids it.
 */
function locate(options: PresetOptions, catalogueRoot: string): string {
  const { out } = options;
  const t = options.t.t;
  const from = options.from ?? '';

  if (from !== '') {
    const found = catalogueDir({
      from,
      ...(options.env === undefined ? {} : { env: options.env }),
    });
    if (found === undefined) {
      throw new GhostError('config', `No catalogue at ${from}.`, {
        details: { from },
      });
    }
    // A directory named on the command line is not something this can update:
    // it is a git checkout, and `git pull` is the command for it. Reporting
    // that beats a `preset update` that prints a path and fetched nothing.
    if (options.action === 'update') {
      throw new GhostError(
        'config',
        `${from} is a checkout, not a fetched catalogue — there is nothing\n` +
          '  to update. Pull it with git, or drop --from to update the fetched one.',
        { details: { from } },
      );
    }
    return found;
  }

  const found = catalogueDir({
    catalogueDir: catalogueRoot,
    ...(options.env === undefined ? {} : { env: options.env }),
  });
  // `update` *is* a refresh — it is the whole command. Without this it returned
  // the copy already here and reported success having fetched nothing.
  const wantsFresh = options.refresh === true || options.action === 'update';
  if (found !== undefined && !wantsFresh) return found;

  if (options.offline === true) {
    if (found !== undefined) return found;
    throw new GhostError(
      'config',
      `No catalogue on this machine, and --offline forbids fetching one.\n` +
        '  Drop --offline, or pass --from with a checkout of the presets repository.',
    );
  }

  out(t('preset.fetching', { package: CATALOGUE_PACKAGE }));
  return fetchCatalogue({
    catalogueDir: catalogueRoot,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
}

export async function runPreset(options: PresetOptions): Promise<number> {
  const { out, errOut } = options;
  const t = options.t.t;

  try {
    const loaded = loadConfig({
      ...(options.home === undefined ? {} : { root: options.home }),
      ...(options.env === undefined ? {} : { env: options.env }),
    });

    const dir = locate(options, loaded.paths.catalogueDir);
    if (options.action === 'update') {
      out(`Catalogue at ${dir}`);
      return 0;
    }
    // Throws when the directory exists but holds no `agents/` — the 1.x layout,
    // which would otherwise offer nothing and read as "no presets exist".
    const agentsDir = assertCatalogueLayout(dir);

    const paths: PresetPaths = {
      toolboxesDir: loaded.paths.toolboxesDir,
      presetsDir: loaded.paths.presetsDir,
      dbFile: loaded.paths.dbFile,
      catalogueAgentsDir: agentsDir,
      catalogueSkillsDir: catalogueSkillsDir(dir),
      // Resolved here rather than inside the copy, so a `-W` naming no
      // workspace fails before anything is built or written.
      skillsDir: skillsTargetDir(
        loaded.paths,
        options.workspaceId ?? DEFAULT_WORKSPACE_ID,
      ),
    };

    const available = offers(paths, loaded.config, out);
    if (available.length === 0) {
      out(`No presets under ${agentsDir} or ${paths.presetsDir}.`);
      return 0;
    }

    if (options.action === 'list') {
      for (const offer of available) {
        out(
          `${labelOf(offer, t)}${offer.installed ? `  [${t('preset.installed')}]` : ''}`,
        );
      }
      return 0;
    }

    const chosen = await select(options, available);
    if (chosen === undefined) {
      errOut(
        'Which presets? Pass ids, or run this in a terminal to pick from a list —\n' +
          '  see `ghostai preset list`.',
      );
      return 2;
    }
    if (chosen.length === 0) {
      out(t('preset.nothingChosen'));
      return 0;
    }

    return await install(options, loaded, paths, dir, chosen);
  } catch (error) {
    // `GhostError` messages are written to be read by the person who caused
    // them — they already name the file and what to do next.
    errOut(error instanceof GhostError ? error.message : String(error));
    return 1;
  }
}

/**
 * Which presets this run installs.
 *
 * `undefined` for "nobody said, and there is nobody to ask" — distinct from an
 * empty list, which is somebody declining. The first is exit 2 with a usage
 * message; the second is exit 0, because pressing enter on the picker is a
 * valid answer and not an error.
 */
async function select(
  options: PresetOptions,
  available: readonly Offer[],
): Promise<readonly Offer[] | undefined> {
  const named = options.ids ?? [];
  if (named.length > 0) {
    const byId = new Map(available.map((offer) => [offer.id, offer]));
    const missing = named.filter((id) => !byId.has(id));
    if (missing.length > 0) {
      throw new GhostError(
        'invalid_input',
        `No preset is available under ${missing.map((id) => `"${id}"`).join(', ')}.\n` +
          `  Available: ${available.map((offer) => offer.id).join(', ')}.`,
        { details: { missing } },
      );
    }
    // Deduplicated and back into catalogue order, so `install b a` and
    // `install a b` do the same thing — which matters because the delegator
    // ordering below is computed from this list.
    const wanted = new Set(named);
    return available.filter((offer) => wanted.has(offer.id));
  }

  const ask = options.ask;
  if (ask === undefined) return undefined;

  const picked = await ask.chooseMany(
    options.t.t('preset.which'),
    available.map((offer) => labelOf(offer, options.t.t)),
    available.map((offer) =>
      offer.installed ? `[${options.t.t('preset.installed')}]` : '',
    ),
  );
  return picked.map((index) => available[index]).filter((o) => o !== undefined);
}

async function install(
  options: PresetOptions,
  loaded: ReturnType<typeof loadConfig>,
  paths: PresetPaths,
  catalogue: string,
  chosen: readonly Offer[],
): Promise<number> {
  const { out } = options;

  // A fresh install has no root directory yet, and both the toolbox store and
  // `saveConfig` write into it. Made once, here, rather than discovered as
  // "unable to open database file" by whichever of them ran first.
  ensureDir(loaded.paths.root);

  // The boxes the *chosen* agents need, in first-mention order and each once.
  // Two agents naming `web-research` is one build.
  const wanted: string[] = [];
  for (const offer of chosen) {
    const name = offer.preset.toolbox.name;
    if (name !== '' && !wanted.includes(name)) wanted.push(name);
  }

  // Already approved and unedited? Then there is nothing to build: rebuilding
  // would change the image id, change the manifest, and revoke the approval the
  // operator gave — turning a re-run into a silent downgrade.
  const toBuild = wanted.filter((name) => !isApproved(paths, name));

  const missing = toBuild.filter(
    (name) => catalogueToolbox(catalogue, name) === undefined,
  );
  if (missing.length > 0) {
    throw new GhostError(
      'config',
      `This catalogue has no toolbox named ${missing.map((n) => `"${n}"`).join(', ')}.\n` +
        '  A preset naming a box the catalogue does not carry cannot be installed.\n' +
        '  Update the catalogue with `ghostai preset update`.',
      { details: { missing } },
    );
  }

  if (toBuild.length > 0) {
    // Once, before the first build: five failed builds is a worse way to learn
    // the daemon is down than one sentence.
    const probe =
      options.probe ??
      ((): void => {
        dockerEngine().probe();
      });
    probe();

    const build = options.build ?? dockerBuild;
    for (const name of toBuild) {
      const context = catalogueToolbox(catalogue, name);
      if (context === undefined) continue;
      out(`==> building ${name}`);
      installToolbox(name, context, paths, build);
      out(`    installed ${join(paths.toolboxesDir, name, 'toolbox.json')}`);
    }
    out('');
  }

  // Approval, before the presets rather than after — because approving is what
  // unblocks them, and a run that approved and then made the operator run the
  // same command again would be doing half its job.
  await settleApprovals(options, paths, wanted);

  let config = loaded.config;
  const installed: string[] = [];
  const blocked: Array<{ id: string; reason: string }> = [];
  const stale: string[] = [];

  // Delegators last. A preset's roster is snapshotted from the agents that
  // exist when it installs, so `team-lead` installed before its specialists
  // would be handed an empty team — in one run, ordering is the whole fix.
  const ordered = [...chosen].sort(
    (left, right) =>
      Number(left.preset.subagents.length > 0) -
      Number(right.preset.subagents.length > 0),
  );

  for (const offer of ordered) {
    const plan = planInstall(
      offer.preset,
      config,
      paths,
      options.force === true,
    );
    if (plan.ok) {
      config = plan.config;
      installed.push(offer.id);
    } else {
      blocked.push({ id: offer.id, reason: plan.reason });
      // Already installed, and its roster would now name more specialists than
      // it does — which happens whenever toolboxes were approved between two
      // runs. Not overwritten, because the entry may carry edits; named
      // instead, with the command that refreshes it.
      const current = config.agents.list[offer.id];
      if (
        current !== undefined &&
        rosterIsStale(offer.preset, current, config)
      ) {
        stale.push(offer.id);
      }
    }
  }

  if (installed.length > 0) saveConfig(loaded.file, config);

  out(
    installed.length === 0
      ? 'No agents were installed.'
      : `Installed ${String(installed.length)} agents: ${installed.join(', ')}`,
  );

  // Only for the presets that actually installed. A blocked one was left alone
  // "in case you have edited them", and overwriting its sheets would be the
  // same edit by another route.
  const sheets = installSheets(options, paths, ordered, installed);

  report(options, paths, config, wanted, blocked, stale, sheets);
  return 0;
}

/** Every chosen preset's sheets, copied and folded into one result. */
function installSheets(
  options: PresetOptions,
  paths: PresetPaths,
  ordered: readonly Offer[],
  installed: readonly string[],
): SkillInstallResult {
  const written: Array<{ name: string; files: number }> = [];
  const kept: string[] = [];
  const missing: string[] = [];
  const warnings: string[] = [];

  for (const offer of ordered) {
    if (!installed.includes(offer.id)) continue;
    const result = installSkills({
      presetId: offer.id,
      names: offer.preset.skills,
      catalogueSkillsDir: paths.catalogueSkillsDir,
      targetDir: paths.skillsDir,
      force: options.force === true,
    });
    // Two presets can name one sheet. The second copy is a no-op the first
    // already did, so the report should not say it twice either.
    for (const sheet of result.written) {
      if (!written.some((seen) => seen.name === sheet.name)) {
        written.push(sheet);
      }
    }
    for (const name of result.kept) {
      if (!kept.includes(name)) kept.push(name);
    }
    for (const name of result.missing) {
      if (!missing.includes(name)) missing.push(name);
    }
    warnings.push(...result.warnings);
  }

  return {
    written,
    // A sheet two presets both name is written by the first and then found
    // already there by the second. Reporting it as both written and kept would
    // be true of neither.
    kept: kept.filter((name) => !written.some((sheet) => sheet.name === name)),
    missing,
    warnings,
  };
}

/** Everything the operator still has to do, each with the command that does it. */
function report(
  options: PresetOptions,
  paths: PresetPaths,
  config: Config,
  wanted: readonly string[],
  blocked: ReadonlyArray<{ id: string; reason: string }>,
  stale: readonly string[],
  sheets: SkillInstallResult,
): void {
  const { out } = options;

  if (sheets.written.length > 0) {
    out('');
    out(`Skill sheets written to ${paths.skillsDir ?? ''}:`);
    for (const { name, files } of sheets.written) {
      out(`    ${name}  (${String(files)} file${files === 1 ? '' : 's'})`);
    }
  }

  if (sheets.kept.length > 0) {
    out('');
    out('Already in the workspace, and left alone in case you have edited');
    out('them:');
    for (const name of sheets.kept) out(`    ${name}`);
    out('');
    out('Re-run with --force to overwrite them.');
  }

  if (sheets.missing.length > 0) {
    out('');
    out('Named by a preset but not in this catalogue:');
    for (const name of sheets.missing) out(`    ${name}`);
  }

  for (const warning of sheets.warnings) {
    out('');
    out(warning);
  }

  const pending = pendingApprovals(paths, wanted);
  if (pending.length > 0) {
    out('');
    out('Still unapproved. An agent cannot work in a toolbox until you');
    out('approve it:');
    for (const { name } of pending) out(`    ghostai toolbox approve ${name}`);
  }

  const waiting = blocked.filter(
    ({ id }) => config.agents.list[id] === undefined,
  );
  if (waiting.length > 0) {
    out('');
    if (pending.length > 0) {
      out('Waiting on those approvals:');
      for (const { id } of waiting) out(`    ${id}`);
      out('');
      out('Approve them, then re-run — or do both at once with');
      out('`ghostai preset install --approve`.');
    } else {
      // Not an approval problem, so the reason is worth printing: an id that
      // cannot be an agent id, a network request above the box's ceiling.
      for (const { id, reason } of waiting) {
        out(`Could not install ${id}:`);
        for (const line of reason.split('\n')) out(`  ${line}`);
      }
    }
  }

  const kept = blocked.filter(
    ({ id }) => config.agents.list[id] !== undefined && !stale.includes(id),
  );
  if (kept.length > 0 && options.force !== true) {
    out('');
    out('Already installed, and left alone in case you have edited them:');
    for (const { id } of kept) out(`    ${id}`);
    out('');
    out('Re-run with --force to overwrite them with the preset.');
  }

  if (stale.length > 0) {
    out('');
    out('These agents delegate, and can now reach specialists they were not');
    out('given when they were installed. Refresh each roster when you want');
    out('it — this never overwrites an agent you may have edited:');
    for (const id of stale) out(`    ghostai agent install ${id} --force`);
  }
}

/**
 * Approves the toolboxes this run installed, if the operator says so.
 *
 * **The policy is printed before the question, not after it.** That is what
 * separates one keystroke from a rubber stamp: approving a toolbox is a
 * statement that somebody read what the container may do, and a prompt that
 * showed only names would make the sentence false. What it costs is a screen of
 * text before a `y`, which is the right trade for the one action in this
 * command that cannot be undone by re-running it.
 *
 * Three ways to answer, and the flag exists so a script has one:
 *
 *  - `--approve` — yes, without asking.
 *  - `--no-approve` — no, without asking.
 *  - Neither — ask, when there is a terminal to ask. With none, approve
 *    nothing: a pipe that answered "yes" by default would approve container
 *    policy nobody read, which is the failure this whole gate exists to stop.
 */
async function settleApprovals(
  options: PresetOptions,
  paths: PresetPaths,
  names: readonly string[],
): Promise<void> {
  const { out } = options;
  const pending = pendingApprovals(paths, names);
  if (pending.length === 0) return;

  if (options.approve !== false) {
    out('These toolboxes are installed but not approved yet. Each runs your');
    out('commands in a container with the policy below:');
    for (const { name, toolbox } of pending) {
      out('');
      out(`  ${name}`);
      for (const line of describe(toolbox)) out(line);
    }
    out('');
  }

  const ask = options.ask;
  const approve =
    options.approve ??
    (ask === undefined
      ? false
      : await ask.confirm(
          pending.length === 1
            ? 'Approve it, so agents may work in it?'
            : `Approve all ${String(pending.length)}, so agents may work in them?`,
          false,
        ));

  if (!approve) return;

  const database = new DatabaseSync(paths.dbFile);
  try {
    const store = new ToolboxStore({ database, dir: paths.toolboxesDir });
    for (const { name } of pending) {
      const approved = store.approve(name);
      out(`Approved ${name} — manifest sha256:${approved.manifestSha256}`);
    }
    out('');
    out('Editing any of those manifests changes its hash and revokes this.');
    out('');
  } finally {
    database.close();
  }
}

/**
 * Whether a preset's delegation roster would now name specialists the installed
 * entry does not.
 *
 * Only ever *grows*: an entry naming someone the preset does not is an
 * operator's own edit, and reporting that as stale would be telling them their
 * customisation is a mistake.
 */
function rosterIsStale(
  preset: AgentPreset,
  entry: AgentEntry,
  config: Config,
): boolean {
  const held = new Set(entry.subagents.map((ref) => ref.id));
  return preset.subagents.some(
    (ref) => !held.has(ref.id) && config.agents.list[ref.id]?.enabled === true,
  );
}

/** Whether this toolbox is installed, approved, and unedited since. */
function isApproved(paths: PresetPaths, name: string): boolean {
  const database = new DatabaseSync(paths.dbFile);
  try {
    const store = new ToolboxStore({ database, dir: paths.toolboxesDir });
    store.require(name);
    return true;
  } catch {
    return false;
  } finally {
    database.close();
  }
}

/**
 * Installed-but-unapproved toolboxes among `names`, with what each one asks for.
 *
 * **An empty `names` is an empty answer, not "everything".** The list is the
 * boxes this run's chosen agents named, so empty means nothing chosen needs a
 * container — and a box left unapproved from some earlier run is not this run's
 * business to ask about. The command that reports on those is
 * `ghostai toolbox list`.
 *
 * It is also what keeps this off the database entirely on the common path: a
 * fresh install picking `nano` has no `ghost.db` yet, and opening one to
 * discover there is nothing to say is how that run failed before.
 */
function pendingApprovals(
  paths: PresetPaths,
  names: readonly string[],
): ReadonlyArray<{ name: string; toolbox: Toolbox }> {
  if (names.length === 0) return [];
  const database = new DatabaseSync(paths.dbFile);
  try {
    const store = new ToolboxStore({ database, dir: paths.toolboxesDir });
    const pending: Array<{ name: string; toolbox: Toolbox }> = [];
    for (const entry of store.list()) {
      if (entry.approved || entry.toolbox === undefined) continue;
      if (!names.includes(entry.name)) continue;
      pending.push({ name: entry.name, toolbox: entry.toolbox });
    }
    return pending;
  } finally {
    database.close();
  }
}
