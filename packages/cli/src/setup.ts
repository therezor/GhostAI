/**
 * `ghost install` — build the catalogue's toolboxes and install its presets.
 *
 * The tedious half of setting an install up, in one command: six `docker
 * build`s and eight config merges that an operator would otherwise run by hand
 * in the right order.
 *
 * **It stops short of approving anything, deliberately.** Building an image and
 * installing its manifest are reversible, mechanical steps; approving one is a
 * statement that a person read what that container may do — its network
 * ceiling, the capabilities it adds back, the hardening it switches off. Six
 * of those decisions behind one keystroke is the rubber stamp the whole gate
 * exists to prevent, so this run ends by printing what each box asks for and
 * the `ghost toolbox approve` line that grants it. The presets whose toolbox is
 * still unapproved are reported the same way rather than half-installed: an
 * enabled agent naming an unapproved toolbox is a config the server refuses to
 * boot on.
 *
 * A preset that needs no container — `team-lead`, `nano` — installs here and
 * now, because there is nothing to review.
 *
 * The builder is injected so tests never need a daemon, and the default probes
 * the daemon once before the first build: "Docker is not running" is worth one
 * sentence up front rather than five failed builds.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { GhostError, loadConfig, saveConfig } from '@ghostbot/core';
import { dockerEngine } from '@ghostbot/runtime';
import { ToolboxStore, weakenedIn } from '@ghostbot/security';
import type {
  AgentEntry,
  AgentPreset,
  Config,
  Toolbox,
} from '@ghostbot/protocol';

import { planInstall, resolvePreset, type PresetPaths } from './agent.js';
import type { Translations } from './i18n.js';
import {
  catalogueToolboxesDir,
  listAllPresets,
  listCatalogueToolboxes,
  presetDirs,
} from './presets.js';

/** The placeholder `build.sh` and this both replace with the built image id. */
const IMAGE_PLACEHOLDER = '__IMAGE_ID__';

/**
 * Builds one image and returns its id.
 *
 * Injected, so `setup.test.ts` exercises every branch around it without a
 * daemon. The default streams the build rather than buffering it — an image
 * that takes four minutes with no output looks hung — and takes no timeout,
 * because a first build downloads base layers over whatever link the machine
 * has.
 */
export type ImageBuilder = (context: string, tag: string) => string;

export interface SetupOptions {
  /** Skip the toolboxes entirely: config merges only, and no Docker. */
  readonly presetsOnly?: boolean;
  /**
   * Approve what this run installs. `undefined` means ask, when `confirm` is
   * there to ask with — and approve nothing when it is not.
   */
  readonly approve?: boolean | undefined;
  /**
   * Asks the operator one yes/no. Absent means nothing is interactive here:
   * a pipe, a CI job, or `ghost init` running with its own reader closed.
   *
   * Passed in rather than opened here because `ghost init` already holds a
   * readline on the same stdin, and two readers fight over keypresses.
   */
  readonly confirm?: (question: string) => Promise<boolean>;
  readonly home?: string | undefined;
  readonly out: (line: string) => void;
  readonly errOut: (line: string) => void;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly t: Translations;
  /** Injected in tests. Defaults to a real `docker build`. */
  readonly build?: ImageBuilder;
  /** Injected in tests. Throws when the daemon is unreachable. */
  readonly probe?: () => void;
}

function dockerBuild(context: string, tag: string): string {
  // `--iidfile` rather than parsing stdout: the latter is racy when two builds
  // run and reports a short id that cannot be pinned. Same argument as
  // `catalogue/build.sh`, which is the other implementation of this — a fresh
  // clone runs that one before `pnpm build` has produced this one.
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
      {
        cause: result.error,
      },
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
  source: string,
  paths: { readonly toolboxesDir: string },
  build: ImageBuilder,
): void {
  const context = join(source, name);
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

export async function runSetup(options: SetupOptions): Promise<number> {
  const { out, errOut } = options;

  try {
    const loaded = loadConfig({
      ...(options.home === undefined ? {} : { root: options.home }),
      ...(options.env === undefined ? {} : { env: options.env }),
    });
    const paths: PresetPaths = {
      toolboxesDir: loaded.paths.toolboxesDir,
      presetsDir: loaded.paths.presetsDir,
      dbFile: loaded.paths.dbFile,
    };

    const source = catalogueToolboxesDir();
    const toolboxes =
      options.presetsOnly === true ? [] : listCatalogueToolboxes();

    if (toolboxes.length > 0 && source !== undefined) {
      // Once, before the first build: five failed builds is a worse way to
      // learn the daemon is down than one sentence.
      const probe =
        options.probe ??
        ((): void => {
          dockerEngine().probe();
        });
      probe();

      const build = options.build ?? dockerBuild;
      for (const name of toolboxes) {
        out(`==> building ${name}`);
        installToolbox(name, source, paths, build);
        out(`    installed ${join(paths.toolboxesDir, name, 'toolbox.json')}`);
      }
      out('');
    }

    // Approval, before the presets rather than after — because approving is
    // what unblocks them, and a run that approved and then made the operator
    // run the same command again would be doing half its job.
    await settleApprovals(options, paths, toolboxes);

    let config = loaded.config;
    const installed: string[] = [];
    const blocked: Array<{ id: string; reason: string }> = [];
    const stale: string[] = [];

    // Delegators last. A preset's roster is snapshotted from the agents that
    // exist when it installs, so `team-lead` installed before its specialists
    // would be handed an empty team — in one run, ordering is the whole fix.
    const ids = [...listAllPresets(presetDirs(paths.presetsDir))].sort(
      (left, right) =>
        Number(resolvePreset(left, paths).subagents.length > 0) -
        Number(resolvePreset(right, paths).subagents.length > 0),
    );

    for (const id of ids) {
      const preset = resolvePreset(id, paths);
      const plan = planInstall(
        preset,
        config,
        paths,
        // Never overwrite in bulk: an entry already in the config may carry
        // edits, and this command is not the place to ask five times.
        false,
      );
      if (plan.ok) {
        config = plan.config;
        installed.push(id);
      } else {
        blocked.push({ id, reason: plan.reason });
        // Already installed, and its roster would now name more specialists
        // than it does — which happens whenever toolboxes were approved
        // between two runs. Not overwritten, because the entry may carry
        // edits; named instead, with the command that refreshes it.
        const current = config.agents.list[id];
        if (current !== undefined && rosterIsStale(preset, current, config)) {
          stale.push(id);
        }
      }
    }

    if (installed.length > 0) saveConfig(loaded.file, config);

    out(
      installed.length === 0
        ? 'No agents were installed.'
        : `Installed ${String(installed.length)} agents: ${installed.join(', ')}`,
    );

    // Whatever is still unapproved after that — the operator said no, or
    // there was nobody to ask. Named with the command that grants it.
    const pending = pendingApprovals(paths, toolboxes);
    if (pending.length > 0) {
      out('');
      out('Still unapproved. An agent cannot work in a toolbox until you');
      out('approve it:');
      for (const { name } of pending) {
        out(`    ghost toolbox approve ${name}`);
      }
    }

    const waiting = blocked.filter(
      ({ id }) => config.agents.list[id] === undefined,
    );
    if (waiting.length > 0) {
      out('');
      // Two different situations, and telling them apart is the difference
      // between a next step and a puzzle: with `--presets-only` no toolbox was
      // built at all, so there is nothing above to approve.
      if (pending.length > 0) {
        out('Waiting on those approvals:');
        for (const { id } of waiting) out(`    ${id}`);
        out('');
        out('Approve them, then re-run `ghost install` — or do both at once');
        out('with `ghost install --approve`.');
      } else {
        out('These agents work in a toolbox, which is not installed yet:');
        for (const { id } of waiting) out(`    ${id}`);
        out('');
        out('Run `ghost install` without --presets-only to build them.');
      }
    }

    if (stale.length > 0) {
      out('');
      out('These agents delegate, and can now reach specialists they were not');
      out('given when they were installed. Refresh each roster when you want');
      out('it — this never overwrites an agent you may have edited:');
      for (const id of stale) out(`    ghost agent install ${id} --force`);
    }
    return 0;
  } catch (error) {
    errOut(error instanceof GhostError ? error.message : String(error));
    return 1;
  }
}

/**
 * Approves the toolboxes this run installed, if the operator says so.
 *
 * **The policy is printed before the question, not after it.** That is what
 * separates one keystroke from a rubber stamp: approving a toolbox is a
 * statement that somebody read what the container may do, and a prompt that
 * showed only names would make the sentence false. What it costs is a screen
 * of text before a `y`, which is the right trade for the one action in this
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
  options: SetupOptions,
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

  const approve =
    options.approve ??
    (options.confirm === undefined
      ? false
      : await options.confirm(
          pending.length === 1
            ? 'Approve it, so agents may work in it?'
            : `Approve all ${String(pending.length)}, so agents may work in them?`,
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
 * Whether a preset's delegation roster would now name specialists the
 * installed entry does not.
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

/** Installed-but-unapproved toolboxes, with what each one asks for. */
function pendingApprovals(
  paths: PresetPaths,
  names: readonly string[],
): ReadonlyArray<{ name: string; toolbox: Toolbox }> {
  const database = new DatabaseSync(paths.dbFile);
  try {
    const store = new ToolboxStore({ database, dir: paths.toolboxesDir });
    const pending: Array<{ name: string; toolbox: Toolbox }> = [];
    for (const entry of store.list()) {
      if (entry.approved || entry.toolbox === undefined) continue;
      if (names.length > 0 && !names.includes(entry.name)) continue;
      pending.push({ name: entry.name, toolbox: entry.toolbox });
    }
    return pending;
  } finally {
    database.close();
  }
}
