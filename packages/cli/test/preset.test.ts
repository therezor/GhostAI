/**
 * `ghostai preset` — the picker, the builds it triggers, and the refusals.
 *
 * Ported from `setup.test.ts`, which tested the all-or-nothing `ghost install`
 * this replaced. Everything that touches the world is injected — the fetcher,
 * the builder, the daemon probe, the prompt — so none of this needs a registry,
 * a daemon or a terminal.
 *
 * The catalogue is a directory this file writes, rather than a package it
 * resolves. That is what `--from` is for, and it is also the only way to test
 * the layout: a fixture with three agents and two boxes says more about the
 * ordering rules than eight real ones would, and it does not change when the
 * presets repository does.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Config } from '@ghostwire/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Ask } from '#src/ask.js';
import { CATALOGUE_RANGE, fetchedCatalogueDir } from '#src/catalogue.js';
import { translationsFor } from '#src/i18n.js';
import { runPreset, type PresetOptions } from '#src/preset.js';
import { runToolbox } from '#src/toolbox.js';

let home: string;
let catalogue: string;
let out: string[];
let errOut: string[];
let built: string[];

const t = translationsFor({ locale: 'en' });
const DIGEST = `sha256:${'a'.repeat(64)}`;

/** Stands in for `docker build`, and records what it was asked to build. */
function fakeBuild(context: string): string {
  built.push(context);
  return DIGEST;
}

function writeAgent(id: string, preset: Record<string, unknown>): void {
  const dir = join(catalogue, 'agents');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${id}.json`),
    JSON.stringify({ schema: 'ghostai.agent-preset/1', id, ...preset }),
  );
}

function writeToolbox(
  name: string,
  overrides: Record<string, unknown> = {},
): void {
  const dir = join(catalogue, 'toolboxes', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'Dockerfile'), 'FROM scratch\n');
  writeFileSync(
    join(dir, 'toolbox.json'),
    JSON.stringify({
      schema: 'ghostai.toolbox/1',
      name,
      // The placeholder the build replaces. A manifest that shipped a real
      // image id would be one nobody could have built.
      image: '__IMAGE_ID__',
      tools: [{ name: 'rg', use: 'Search.' }],
      ...overrides,
    }),
  );
}

/** Answers the picker with fixed replies, and records what it was asked. */
function fakeAsk(
  picks: readonly number[],
  approve = false,
  asked: string[] = [],
): Ask {
  return {
    text: () => Promise.resolve(''),
    secret: () => Promise.resolve(''),
    choose: () => Promise.resolve(0),
    chooseMany: (question) => {
      asked.push(question);
      return Promise.resolve(picks);
    },
    confirm: (question) => {
      asked.push(question);
      return Promise.resolve(approve);
    },
  };
}

/** Where a fetch would land under this test's home. */
function fetchedDir(): string {
  return fetchedCatalogueDir(join(home, 'catalogue'));
}

/**
 * The options every run shares, for the few cases that build their own.
 *
 * `run` below covers the rest; this exists because two cases need to pass a
 * `fetch` that actually creates something, and one needs `from: undefined`
 * rather than the fixture directory.
 */
function base(): PresetOptions {
  return {
    action: 'install',
    from: catalogue,
    home,
    out: (line) => out.push(line),
    errOut: (line) => errOut.push(line),
    env: {},
    t,
    build: fakeBuild,
    probe: () => undefined,
    fetch: () => {
      throw new Error('the tests must never reach a registry');
    },
  };
}

async function run(
  options: {
    action?: 'list' | 'install' | 'update';
    ids?: readonly string[];
    ask?: Ask;
    approve?: boolean;
    force?: boolean;
    offline?: boolean;
    from?: string | null;
    build?: typeof fakeBuild;
    probe?: () => void;
  } = {},
): Promise<number> {
  return await runPreset({
    action: options.action ?? 'install',
    ...(options.ids === undefined ? {} : { ids: options.ids }),
    ...(options.ask === undefined ? {} : { ask: options.ask }),
    ...(options.approve === undefined ? {} : { approve: options.approve }),
    ...(options.force === undefined ? {} : { force: options.force }),
    ...(options.offline === undefined ? {} : { offline: options.offline }),
    // `null` means "do not pass --from", which is how the no-catalogue cases
    // are written without a second runner.
    ...(options.from === null ? {} : { from: options.from ?? catalogue }),
    home,
    out: (line) => out.push(line),
    errOut: (line) => errOut.push(line),
    env: {},
    t,
    build: options.build ?? fakeBuild,
    probe: options.probe ?? (() => undefined),
    fetch: () => {
      throw new Error('the tests must never reach a registry');
    },
  });
}

/**
 * The agents on disk.
 *
 * Empty when there is no `config.json` at all, which is a state this command
 * produces on purpose: the write happens only if something installed, so a run
 * that installed nothing leaves the file it would have created absent rather
 * than writing an empty one.
 */
function savedAgents(): Config['agents']['list'] {
  const file = join(home, 'config.json');
  if (!existsSync(file)) return {};
  return (JSON.parse(readFileSync(file, 'utf8')) as Config).agents.list;
}

function approve(name: string): void {
  const code = runToolbox({
    action: 'approve',
    id: name,
    home,
    out: () => undefined,
    errOut: (line) => errOut.push(line),
    env: {},
    t,
  });
  expect(code).toBe(0);
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ghostai-preset-home-'));
  catalogue = mkdtempSync(join(tmpdir(), 'ghostai-preset-cat-'));
  out = [];
  errOut = [];
  built = [];

  // Three agents and two boxes: one agent needing no container, one needing a
  // box of its own, and one delegating to both.
  writeAgent('nano', { label: 'Nano', toolsEnabled: false, tools: {} });
  writeAgent('coder', {
    label: 'Coder',
    toolbox: { name: 'coding', network: { mode: 'none', allow: [] } },
  });
  writeAgent('lead', {
    label: 'Team lead',
    subagents: [{ id: 'coder' }, { id: 'nano' }],
  });
  writeToolbox('coding');
  writeToolbox('spare');
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(catalogue, { recursive: true, force: true });
});

describe('ghostai preset list', () => {
  it('shows every preset, and which are already installed', async () => {
    await run({ ids: ['nano'] });
    out = [];

    expect(await run({ action: 'list' })).toBe(0);

    const text = out.join('\n');
    expect(text).toContain('nano (Nano)  [installed]');
    expect(text).toContain('coder (Coder)  coding');
    expect(text).not.toContain('coder (Coder)  coding  [installed]');
  });
});

describe('ghostai preset install', () => {
  it('builds only the boxes the chosen agents asked for', async () => {
    // The whole reason the picker exists. `spare` is in the catalogue and
    // nobody named it, so it is never built.
    expect(await run({ ids: ['coder'] })).toBe(0);

    expect(built).toEqual([join(catalogue, 'toolboxes', 'coding')]);
    expect(existsSync(join(home, 'toolboxes', 'coding', 'toolbox.json'))).toBe(
      true,
    );
    expect(existsSync(join(home, 'toolboxes', 'spare'))).toBe(false);
  });

  it('runs no builder at all when nothing chosen needs a box', async () => {
    // What `--presets-only` used to mean. It is a checkbox now.
    expect(await run({ ids: ['nano'] })).toBe(0);

    expect(built).toEqual([]);
    expect(savedAgents().nano).toBeDefined();
  });

  it('pins the built image id into the installed manifest', async () => {
    await run({ ids: ['coder'] });

    const manifest = readFileSync(
      join(home, 'toolboxes', 'coding', 'toolbox.json'),
      'utf8',
    );
    expect(manifest).toContain(DIGEST);
    expect(manifest).not.toContain('__IMAGE_ID__');
  });

  it('approves nothing when there is nobody to ask', async () => {
    // A pipe or a CI job. Answering "yes" by default would approve container
    // policy nobody read, which is the failure the gate exists to stop.
    expect(await run({ ids: ['coder'] })).toBe(0);

    expect(out.join('\n')).toContain('ghostai toolbox approve coding');
    expect(savedAgents().coder).toBeUndefined();
  });

  it('prints each policy before asking, so a yes is an informed one', async () => {
    const asked: string[] = [];
    const ask: Ask = {
      ...fakeAsk([], false, asked),
      confirm: (question) => {
        asked.push(question);
        // What the operator has seen by the time the question arrives.
        const shown = out.join('\n');
        expect(shown).toContain('network');
        expect(shown).toContain('image      sha256:');
        expect(shown).toContain('coding');
        return Promise.resolve(false);
      },
    };

    await run({ ids: ['coder'], ask });

    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatch(/Approve it/);
  });

  it('approves and installs in one run when the answer is yes', async () => {
    // The point of asking here rather than after: approving is what unblocks
    // the agents, so the same run finishes the job.
    expect(await run({ ids: ['coder'], ask: fakeAsk([], true) })).toBe(0);

    expect(savedAgents().coder).toBeDefined();
    expect(out.join('\n')).toContain('Approved coding');
  });

  it('--approve does it without asking', async () => {
    const asked: string[] = [];
    expect(
      await run({
        ids: ['coder'],
        approve: true,
        ask: fakeAsk([], false, asked),
      }),
    ).toBe(0);

    expect(asked).toEqual([]);
    expect(savedAgents().coder).toBeDefined();
  });

  it('--no-approve neither asks nor prints the policies', async () => {
    const asked: string[] = [];
    expect(
      await run({
        ids: ['coder'],
        approve: false,
        ask: fakeAsk([], true, asked),
      }),
    ).toBe(0);

    expect(asked).toEqual([]);
    expect(savedAgents().coder).toBeUndefined();
    expect(out.join('\n')).not.toContain('review this');
    expect(out.join('\n')).toContain('ghostai toolbox approve coding');
  });

  it('holds back an agent whose box is not approved yet', async () => {
    expect(await run({ ids: ['nano', 'coder'] })).toBe(0);

    const list = savedAgents();
    expect(list.nano).toBeDefined();
    // An enabled agent naming an unapproved toolbox is a config the server
    // refuses to boot on, so the entry is not written at all.
    expect(list.coder).toBeUndefined();
    expect(out.join('\n')).toContain('Waiting on those approvals');
  });

  it('installs a held-back agent once its box is approved', async () => {
    await run({ ids: ['coder'] });
    approve('coding');
    out = [];

    expect(await run({ ids: ['coder'] })).toBe(0);
    expect(savedAgents().coder).toBeDefined();
  });

  it('does not rebuild a box that is already approved', async () => {
    // Rebuilding changes the image id, changes the manifest, and revokes the
    // approval the operator gave — a re-run must not be a silent downgrade.
    await run({ ids: ['coder'] });
    approve('coding');
    built = [];

    expect(await run({ ids: ['coder'] })).toBe(0);
    expect(built).toEqual([]);
  });

  it('leaves an already-installed agent alone rather than overwriting it', async () => {
    await run({ ids: ['nano'] });
    const before = savedAgents().nano;
    out = [];

    expect(await run({ ids: ['nano'] })).toBe(0);

    expect(savedAgents().nano).toEqual(before);
    expect(out.join('\n')).toContain('Re-run with --force');
  });

  it('--force overwrites it', async () => {
    await run({ ids: ['nano'] });
    writeAgent('nano', { label: 'Renamed', toolsEnabled: false, tools: {} });

    expect(await run({ ids: ['nano'], force: true })).toBe(0);
    expect(savedAgents().nano?.label).toBe('Renamed');
  });

  it('installs delegators last, so their roster is not born empty', async () => {
    // A roster is snapshotted from the agents that exist at install time, so
    // `lead` installed before its specialists would be handed an empty team.
    // In one run, ordering is the whole fix — and the ids are given in the
    // order that would break it.
    expect(
      await run({ ids: ['lead', 'nano', 'coder'], ask: fakeAsk([], true) }),
    ).toBe(0);

    const roster = savedAgents().lead?.subagents.map((ref) => ref.id) ?? [];
    expect(roster).toEqual(['coder', 'nano']);
  });

  it('names a stale roster rather than silently overwriting it', async () => {
    // `lead` installs first with no specialist reachable; the second run could
    // now offer it two, but the entry may carry the operator's own edits.
    await run({ ids: ['lead'] });
    expect(savedAgents().lead?.subagents).toEqual([]);

    await run({ ids: ['nano', 'coder'], ask: fakeAsk([], true) });
    out = [];

    expect(await run({ ids: ['lead'] })).toBe(0);

    expect(savedAgents().lead?.subagents).toEqual([]);
    expect(out.join('\n')).toContain('ghostai agent install lead --force');
  });

  it('stops before the first build when the daemon is unreachable', async () => {
    // One sentence up front beats five failed builds.
    const code = await run({
      ids: ['coder'],
      probe: () => {
        throw new Error('Cannot connect to the Docker daemon');
      },
    });

    expect(code).toBe(1);
    expect(built).toEqual([]);
    expect(errOut.join('\n')).toContain('Docker daemon');
  });

  it('reports a failed build without writing a half-pinned manifest', async () => {
    const code = await run({
      ids: ['coder'],
      build: () => {
        throw new Error('docker build failed for ghostai/coding:local');
      },
    });

    expect(code).toBe(1);
    expect(errOut.join('\n')).toContain('docker build failed');
    expect(existsSync(join(home, 'toolboxes', 'coding', 'toolbox.json'))).toBe(
      false,
    );
  });

  it('refuses a preset naming a box the catalogue does not carry', async () => {
    writeAgent('orphan', {
      toolbox: { name: 'nowhere', network: { mode: 'none', allow: [] } },
    });

    expect(await run({ ids: ['orphan'] })).toBe(1);
    expect(errOut.join('\n')).toContain('no toolbox named "nowhere"');
    expect(built).toEqual([]);
  });

  it('refuses an id that is not on offer, naming what is', async () => {
    expect(await run({ ids: ['ghost'] })).toBe(1);
    expect(errOut.join('\n')).toContain('coder, lead, nano');
  });
});

describe('the picker', () => {
  it('installs what was ticked and nothing else', async () => {
    // Indices into the sorted listing: coder, lead, nano.
    expect(await run({ ask: fakeAsk([2]) })).toBe(0);

    const list = savedAgents();
    expect(list.nano).toBeDefined();
    expect(list.coder).toBeUndefined();
    expect(built).toEqual([]);
  });

  it('an empty answer installs nothing, and is not an error', async () => {
    // Pressing enter is a valid way to decline, distinct from having nobody to
    // ask — which is the exit-2 case below.
    expect(await run({ ask: fakeAsk([]) })).toBe(0);
    expect(out.join('\n')).toContain('Nothing chosen');
    expect(existsSync(join(home, 'config.json'))).toBe(false);
  });

  it('refuses with a usage message when there is nobody to ask', async () => {
    expect(await run({})).toBe(2);
    expect(errOut.join('\n')).toContain('ghostai preset list');
  });

  it('shows how much of a box a preset asked for', async () => {
    // Two agents naming one toolbox differ only here, so it has to be on the
    // row an operator picks from.
    writeAgent('scout', {
      toolbox: {
        name: 'coding',
        network: { mode: 'none', allow: [] },
        tools: { '*': 'deny', rg: 'allow' },
      },
    });

    await run({ action: 'list' });

    // Through the plural keys, so `1` reads as one tool rather than `1 tools`.
    expect(out.join('\n')).toContain('scout  coding (1 tool)');
  });
});

describe('finding the catalogue', () => {
  it('refuses a --from that is not there', async () => {
    expect(await run({ from: join(catalogue, 'nope') })).toBe(1);
    expect(errOut.join('\n')).toContain('No catalogue at');
  });

  it('names the version when the layout is the old one', async () => {
    // A checkout from before the layout settled keeps its presets under
    // `presets/` rather than `agents/`, so this is a
    // directory that exists, resolves, and offers nothing. "No presets
    // available" would send somebody looking for a preset to write.
    const old = mkdtempSync(join(tmpdir(), 'ghostai-preset-old-'));
    mkdirSync(join(old, 'presets'), { recursive: true });

    expect(await run({ from: old })).toBe(1);
    expect(errOut.join('\n')).toContain('holds no agents/ directory');
    // The constant, not a copy of it: a range that moves should not need
    // this line edited to keep passing.
    expect(errOut.join('\n')).toContain(CATALOGUE_RANGE);

    rmSync(old, { recursive: true, force: true });
  });

  it('refuses to fetch under --offline, naming the way out', async () => {
    expect(await run({ from: null, offline: true })).toBe(1);
    expect(errOut.join('\n')).toContain('--offline forbids fetching');
  });

  it('takes --from even with --refresh, and does not fetch over it', async () => {
    // `--refresh` is about the *fetched* copy. Against a checkout there is
    // nothing to refresh, and the run must not fail claiming the directory it
    // is looking at is absent.
    expect(await runPreset({ ...base(), action: 'list', refresh: true })).toBe(
      0,
    );
    expect(errOut).toEqual([]);
    expect(out.join('\n')).toContain('coder');
  });
});

describe('ghostai preset update', () => {
  it('always fetches, even when a copy is already here', async () => {
    // The bug this pins: `update` used to find the copy under the prefix,
    // return it, and report success having fetched nothing at all.
    let fetched = 0;
    const code = await runPreset({
      ...base(),
      action: 'update',
      // No `--from`, so it goes looking under the home for a fetched copy.
      from: undefined,
      fetch: () => {
        fetched += 1;
        mkdirSync(join(fetchedDir(), 'agents'), { recursive: true });
        return 0;
      },
    });

    expect(code).toBe(0);
    expect(fetched).toBe(1);
    expect(out.join('\n')).toContain('Catalogue at');
  });

  it('refuses to update a checkout, because git is the command for that', async () => {
    expect(await run({ action: 'update' })).toBe(1);
    expect(errOut.join('\n')).toContain('nothing');
    expect(errOut.join('\n')).toContain('git');
  });
});
