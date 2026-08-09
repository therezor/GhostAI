/**
 * `ghostai agent`, the preset installer.
 *
 * What is asserted here is the *merge*: that a preset lands in `agents.list`
 * exactly once, that the refusals fire before the write, and that the roster
 * snapshot offers only specialists that can answer. The preset shape itself is
 * `@ghostwire/protocol`'s, and the toolbox gate is `@ghostwire/security`'s —
 * both already tested where they live.
 */

import {
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

import { runAgent } from '#src/agent.js';
import { translationsFor } from '#src/i18n.js';
import { runToolbox } from '#src/toolbox.js';

let home: string;
let out: string[];
let errOut: string[];

const t = translationsFor({ locale: 'en' });
const DIGEST = `sha256:${'d'.repeat(64)}`;

function run(
  action: 'install' | 'list',
  name?: string,
  options: { force?: boolean } = {},
): number {
  return runAgent({
    action,
    ...(name === undefined ? {} : { name }),
    ...(options.force === undefined ? {} : { force: options.force }),
    home,
    out: (line) => out.push(line),
    errOut: (line) => errOut.push(line),
    env: {},
    t,
  });
}

/** A toolbox manifest on disk. Presets never live here — see `installPreset`. */
function installToolbox(name: string): void {
  const dir = join(home, 'toolboxes', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'toolbox.json'),
    JSON.stringify({
      schema: 'ghostai.toolbox/1',
      name,
      image: DIGEST,
      tools: [{ name: 'rg', use: 'Search.' }],
    }),
  );
}

function approveToolbox(name: string): void {
  const code = runToolbox({
    action: 'approve',
    id: name,
    home,
    // Discarded: the approval chrome is `toolbox.test.ts`'s to assert, and
    // capturing it here would leak into this file's `out` expectations.
    out: () => undefined,
    errOut: (line) => errOut.push(line),
    env: {},
    t,
  });
  expect(code).toBe(0);
}

/** A standalone preset in `<root>/presets`, the operator's own directory. */
function installPreset(name: string, preset: Record<string, unknown>): void {
  const dir = join(home, 'presets');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.json`), JSON.stringify(preset));
}

function presetFor(
  id: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return { schema: 'ghostai.agent-preset/1', id, ...overrides };
}

function savedConfig(): Config {
  return JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')) as Config;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ghostai-agent-cli-'));
  out = [];
  errOut = [];
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('ghostai agent install', () => {
  it('installs a preset from an explicit path', () => {
    const file = join(home, 'my-agent.json');
    writeFileSync(
      file,
      JSON.stringify(presetFor('scribe', { label: 'Scribe' })),
    );

    expect(run('install', file)).toBe(0);

    const entry = savedConfig().agents.list.scribe;
    expect(entry?.label).toBe('Scribe');
    expect(entry?.enabled).toBe(true);
  });

  it('installs a preset by its id, whether or not it names a toolbox', () => {
    // One lookup for both kinds. The preset is found by its own id — never
    // beside the manifest of the box it happens to name.
    installToolbox('research');
    approveToolbox('research');
    installPreset(
      'scout',
      presetFor('scout', { toolbox: { name: 'research' } }),
    );

    expect(run('install', 'scout')).toBe(0);
    expect(savedConfig().agents.list.scout?.toolbox.name).toBe('research');
  });

  it('refuses a preset whose toolbox was never approved', () => {
    // An enabled agent naming an unapproved toolbox is a config the server
    // refuses to boot on, so the refusal happens here, before the write.
    installToolbox('research');
    installPreset(
      'scout',
      presetFor('scout', { toolbox: { name: 'research' } }),
    );

    expect(run('install', 'scout')).toBe(1);
    expect(errOut.join('\n')).toContain('ghostai toolbox approve research');
    expect(savedConfig).toThrow(); // nothing was written
  });

  it('refuses a network request above the toolbox ceiling', () => {
    // The runtime would refuse the same pair at build; failing at install is
    // the same rule at the moment the operator can still fix the preset.
    installToolbox('research');
    approveToolbox('research');
    installPreset(
      'scout',
      presetFor('scout', {
        toolbox: { name: 'research', network: { mode: 'open' } },
      }),
    );

    expect(run('install', 'scout')).toBe(1);
    expect(errOut.join('\n')).toMatch(/network|ceiling|open/i);
  });

  it('refuses to overwrite an existing agent without --force', () => {
    // The existing entry may carry the operator's own edits.
    const file = join(home, 'scribe.json');
    writeFileSync(file, JSON.stringify(presetFor('scribe')));
    run('install', file);

    expect(run('install', file)).toBe(1);
    expect(errOut.join('\n')).toContain('--force');

    expect(run('install', file, { force: true })).toBe(0);
  });

  it('refuses an id nothing downstream could use', () => {
    const file = join(home, 'bad.json');
    writeFileSync(file, JSON.stringify(presetFor('CON')));

    expect(run('install', file)).toBe(1);
    expect(errOut.join('\n')).toContain('agent id');
  });

  it('names the candidates when nothing matches', () => {
    installPreset('team-lead', presetFor('team-lead'));
    installPreset('nano', presetFor('nano'));

    expect(run('install', 'nope')).toBe(1);
    expect(errOut.join('\n')).toContain('team-lead');
    expect(errOut.join('\n')).toContain('nano');
  });

  it('treats a path-shaped argument as a path even when the file is missing', () => {
    // `./typo.json` must not fall through to an installable preset and install
    // something other than what was named.
    expect(run('install', './typo.json')).toBe(1);
    expect(errOut.join('\n')).toContain('could not be read');
  });

  it('installs a preset an operator dropped into <root>/presets', () => {
    // The drop-in directory, and the reason the loader takes a directory
    // rather than a hard-coded list: adding a preset is adding a file.
    installPreset('scribe', presetFor('scribe', { label: 'Scribe' }));

    expect(run('install', 'scribe')).toBe(0);
    expect(savedConfig().agents.list.scribe?.label).toBe('Scribe');
  });

  it('installs an operator preset by its id', () => {
    // The drop-in directory is searched by id, so a preset an operator put
    // there installs by name just like one given by path.
    installPreset('nano', presetFor('nano', { label: 'My Nano' }));

    expect(run('install', 'nano')).toBe(0);
    expect(savedConfig().agents.list.nano?.label).toBe('My Nano');
  });

  it('refuses a preset file that is not valid JSON, naming it', () => {
    mkdirSync(join(home, 'presets'), { recursive: true });
    writeFileSync(join(home, 'presets', 'broken.json'), '{');

    expect(run('install', 'broken')).toBe(1);
    expect(errOut.join('\n')).toContain('not valid JSON');
  });

  it('installs an agent with tools off and the live sections deleted', () => {
    installPreset(
      'nano',
      presetFor('nano', {
        toolsEnabled: false,
        tools: {},
        livePrompt: ' ',
        wrapUpPrompt: ' ',
      }),
    );

    expect(run('install', 'nano')).toBe(0);

    const entry = savedConfig().agents.list.nano;
    expect(entry?.toolsEnabled).toBe(false);
    expect(entry?.tools).toEqual({});
    // The single space is the three-state spelling for "remove the section".
    expect(entry?.livePrompt).toBe(' ');
    expect(entry?.wrapUpPrompt).toBe(' ');
  });
});

describe('the team-lead roster snapshot', () => {
  /**
   * A toolbox-free stand-in for a specialist, shadowing the shipped preset of
   * the same id. Every real specialist needs an approved toolbox, which this
   * file has no daemon to build — and the roster rule under test is about
   * *which agents exist*, not about what they run in.
   */
  function installSpecialist(id: string): void {
    installPreset(id, presetFor(id));
    expect(run('install', id)).toBe(0);
  }

  beforeEach(() => {
    // The delegator whose roster is under test. Its declared specialists are a
    // fixed set; which of them reach the snapshot is what each case checks.
    installPreset(
      'team-lead',
      presetFor('team-lead', {
        subagents: [{ id: 'researcher' }, { id: 'coder' }],
      }),
    );
  });

  it('offers only specialists that are installed and enabled', () => {
    installSpecialist('coder');
    out = [];

    expect(run('install', 'team-lead')).toBe(0);

    const entry = savedConfig().agents.list['team-lead'];
    expect(entry?.subagents.map((ref) => ref.id)).toEqual(['coder']);
    // The missing specialists are named, with the way to add them later.
    expect(out.join('\n')).toContain('researcher');
    expect(out.join('\n')).toContain('--force');
  });

  it('never offers nano, which is a fast lane rather than a specialist', () => {
    // A delegator handing "think about this" to a no-tools agent is doing the
    // work itself with a round trip added.
    installSpecialist('nano');

    run('install', 'team-lead');

    expect(savedConfig().agents.list['team-lead']?.subagents).toEqual([]);
  });

  it('refreshes the snapshot on a --force re-run', () => {
    run('install', 'team-lead');
    expect(savedConfig().agents.list['team-lead']?.subagents).toEqual([]);

    installSpecialist('coder');
    expect(run('install', 'team-lead', { force: true })).toBe(0);

    expect(
      savedConfig().agents.list['team-lead']?.subagents.map((ref) => ref.id),
    ).toEqual(['coder']);
  });

  it('skips a specialist that is installed but disabled', () => {
    installSpecialist('coder');
    const config = savedConfig();
    const coder = config.agents.list.coder;
    expect(coder).toBeDefined();
    writeFileSync(
      join(home, 'config.json'),
      JSON.stringify({
        ...config,
        agents: {
          ...config.agents,
          list: {
            ...config.agents.list,
            coder: { ...coder, enabled: false },
          },
        },
      }),
    );

    run('install', 'team-lead');

    expect(savedConfig().agents.list['team-lead']?.subagents).toEqual([]);
  });
});

describe('ghostai agent list', () => {
  it('shows the installed agents and the presets still available', () => {
    installPreset('nano', presetFor('nano'));
    installPreset('team-lead', presetFor('team-lead'));
    run('install', 'nano');
    out = [];

    expect(run('list')).toBe(0);
    const text = out.join('\n');
    expect(text).toContain('nano  [enabled]');
    expect(text).toContain('team-lead');
    // Installed, so it is no longer on offer.
    expect(text).not.toMatch(/not yet installed:.*\bnano\b/);
  });

  it('lists every available operator preset', () => {
    // One listing, because there is one kind of preset and one search.
    installPreset('scribe', presetFor('scribe'));
    installPreset('researcher', presetFor('researcher'));

    run('list');

    const text = out.join('\n');
    expect(text).toContain('Presets not yet installed: researcher, scribe');
    // One command, not one per id, and it names the picker rather than this
    // command — that is the one that also builds the toolbox an agent needs.
    expect(text).toContain('ghostai preset install');
  });

  it('names an available preset once', () => {
    installPreset('nano', presetFor('nano'));

    run('list');

    const lines = out
      .join('\n')
      .split('\n')
      .filter((line) => line.includes('nano'));
    expect(lines).toHaveLength(1);
  });
});
