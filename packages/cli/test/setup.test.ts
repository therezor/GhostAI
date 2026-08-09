/**
 * `ghost install`, the bulk installer.
 *
 * The builder and the daemon probe are both injected, so nothing here needs
 * Docker. What is asserted is the *order and the refusals*: manifests are
 * installed but never approved, presets that need an unapproved toolbox are
 * held back rather than half-installed, and the run ends by naming what a
 * person still has to review.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Config } from '@ghostbot/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { translationsFor } from '#src/i18n.js';
import { listCatalogueToolboxes } from '#src/presets.js';
import { runSetup } from '#src/setup.js';
import { runToolbox } from '#src/toolbox.js';

let home: string;
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

async function run(
  options: {
    presetsOnly?: boolean;
    build?: typeof fakeBuild;
    approve?: boolean;
    confirm?: (question: string) => Promise<boolean>;
  } = {},
): Promise<number> {
  return await runSetup({
    ...(options.presetsOnly === undefined
      ? {}
      : { presetsOnly: options.presetsOnly }),
    ...(options.approve === undefined ? {} : { approve: options.approve }),
    ...(options.confirm === undefined ? {} : { confirm: options.confirm }),
    home,
    out: (line) => out.push(line),
    errOut: (line) => errOut.push(line),
    env: {},
    t,
    build: options.build ?? fakeBuild,
    probe: () => undefined,
  });
}

function savedConfig(): Config {
  return JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')) as Config;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ghostai-setup-'));
  out = [];
  errOut = [];
  built = [];
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('ghost install', () => {
  it('builds every catalogue toolbox and installs its manifest', async () => {
    expect(await run()).toBe(0);

    const names = listCatalogueToolboxes();
    expect(built).toHaveLength(names.length);
    for (const name of names) {
      expect(existsSync(join(home, 'toolboxes', name, 'toolbox.json'))).toBe(
        true,
      );
    }
  });

  it('pins the built image id into the installed manifest', async () => {
    await run();

    const manifest = readFileSync(
      join(home, 'toolboxes', 'data', 'toolbox.json'),
      'utf8',
    );
    expect(manifest).toContain(DIGEST);
    expect(manifest).not.toContain('__IMAGE_ID__');
  });

  it('approves nothing when there is nobody to ask', async () => {
    // A pipe or a CI job. Answering "yes" by default would approve container
    // policy nobody read, which is the failure the gate exists to stop.
    expect(await run()).toBe(0);

    const text = out.join('\n');
    expect(text).toContain('ghost toolbox approve data');
    expect(savedConfig().agents.list['data-analyst']).toBeUndefined();
  });

  it('prints each policy before asking, so a yes is an informed one', async () => {
    const asked: string[] = [];
    await run({
      confirm: async (question) => {
        asked.push(question);
        // What the operator has seen by the time the question arrives.
        const shown = out.join('\n');
        expect(shown).toContain('network');
        expect(shown).toContain('image      sha256:');
        expect(shown).toContain('data');
        return false;
      },
    });

    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatch(/Approve all 5/);
  });

  it('approves and installs everything in one run when the answer is yes', async () => {
    // The point of asking here rather than after: approving is what unblocks
    // the agents, so the same run finishes the job.
    expect(await run({ confirm: async () => true })).toBe(0);

    const list = savedConfig().agents.list;
    expect(list['data-analyst']).toBeDefined();
    expect(list.researcher).toBeDefined();
    expect(list['team-lead']?.subagents.map((r) => r.id)).toContain('coder');
    expect(out.join('\n')).toContain('Approved data');
  });

  it('--approve does it without asking', async () => {
    const asked: string[] = [];
    expect(
      await run({
        approve: true,
        confirm: async (question) => (asked.push(question), false),
      }),
    ).toBe(0);

    expect(asked).toEqual([]);
    expect(savedConfig().agents.list['data-analyst']).toBeDefined();
  });

  it('--no-approve neither asks nor prints the policies', async () => {
    const asked: string[] = [];
    expect(
      await run({
        approve: false,
        confirm: async (question) => (asked.push(question), true),
      }),
    ).toBe(0);

    expect(asked).toEqual([]);
    expect(savedConfig().agents.list['data-analyst']).toBeUndefined();
    expect(out.join('\n')).toContain('ghost toolbox approve data');
  });

  it('installs the agents that need no container, and holds the rest back', async () => {
    expect(await run()).toBe(0);

    const list = savedConfig().agents.list;
    expect(list.nano).toBeDefined();
    expect(list['team-lead']).toBeDefined();
    // `data-analyst` needs its toolbox approved first — an enabled agent naming
    // an unapproved toolbox is a config the server refuses to boot on.
    expect(list['data-analyst']).toBeUndefined();
    expect(out.join('\n')).toContain('Waiting on those approvals');
  });

  it('installs a toolboxed agent once its toolbox is approved', async () => {
    await run();
    out = [];
    const code = runToolbox({
      action: 'approve',
      id: 'data',
      home,
      out: () => undefined,
      errOut: (line) => errOut.push(line),
      env: {},
      t,
    });
    expect(code).toBe(0);

    expect(await run()).toBe(0);
    expect(savedConfig().agents.list['data-analyst']).toBeDefined();
  });

  it('never runs the builder with --presets-only', async () => {
    // The flag exists so an install with no Docker can still finish.
    expect(await run({ presetsOnly: true })).toBe(0);

    expect(built).toEqual([]);
    expect(existsSync(join(home, 'toolboxes'))).toBe(false);
    expect(savedConfig().agents.list.nano).toBeDefined();
  });

  it('leaves an already-installed agent alone rather than overwriting it', async () => {
    // Bulk never forces: an entry in the config may carry the operator's own
    // edits, and this command is not the place to ask about each one.
    await run({ presetsOnly: true });
    const before = savedConfig().agents.list.nano;

    out = [];
    expect(await run({ presetsOnly: true })).toBe(0);
    expect(savedConfig().agents.list.nano).toEqual(before);
  });

  it('installs delegators last, so their roster is not born empty', async () => {
    // A roster is snapshotted from the agents that exist at install time, so
    // `team-lead` installed before its specialists would be handed an empty
    // team. In one run, ordering is the whole fix.
    await run();
    for (const name of ['coding', 'data', 'media', 'web-research']) {
      runToolbox({
        action: 'approve',
        id: name,
        home,
        out: () => undefined,
        errOut: (line) => errOut.push(line),
        env: {},
        t,
      });
    }
    rmSync(join(home, 'config.json'));
    out = [];

    expect(await run()).toBe(0);

    const roster =
      savedConfig().agents.list['team-lead']?.subagents.map((ref) => ref.id) ??
      [];
    expect(roster).toContain('coder');
    expect(roster).toContain('researcher');
    expect(roster).toContain('media-ops');
    // Not nano: it is a fast lane for the user, not a specialist to delegate
    // to — a delegator asking a no-tools agent to think is doing it itself
    // with extra latency.
    expect(roster).not.toContain('nano');
  });

  it('names a stale roster rather than silently overwriting it', async () => {
    // The two-run shape: `team-lead` installs first with no specialist
    // reachable, the toolboxes are approved, and the second run could now
    // offer it five — but the entry may carry the operator's own edits.
    await run();
    // Every one of its specialists needs a toolbox, so with none approved the
    // roster starts empty.
    expect(savedConfig().agents.list['team-lead']?.subagents).toEqual([]);

    for (const name of ['coding', 'data', 'media', 'web-research']) {
      runToolbox({
        action: 'approve',
        id: name,
        home,
        out: () => undefined,
        errOut: (line) => errOut.push(line),
        env: {},
        t,
      });
    }
    out = [];
    expect(await run()).toBe(0);

    // Untouched...
    expect(savedConfig().agents.list['team-lead']?.subagents).toEqual([]);
    // ...but named, with the command that refreshes it.
    expect(out.join('\n')).toContain('ghost agent install team-lead --force');
  });

  it('stops before the first build when the daemon is unreachable', async () => {
    // One sentence up front beats five failed builds.
    const code = await runSetup({
      home,
      out: (line) => out.push(line),
      errOut: (line) => errOut.push(line),
      env: {},
      t,
      build: fakeBuild,
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
      build: () => {
        throw new Error('docker build failed for ghostai/data:local');
      },
    });

    expect(code).toBe(1);
    expect(errOut.join('\n')).toContain('docker build failed');
    expect(existsSync(join(home, 'toolboxes', 'data', 'toolbox.json'))).toBe(
      false,
    );
  });
});
