import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GhostError, systemClock } from '@ghostai/core';

import { ExtensionStore } from '#src/extension-store.js';

let base: string;
let database: DatabaseSync;
let store: ExtensionStore;

function install(
  id: string,
  overrides: Record<string, unknown> = {},
  root: string = base,
): string {
  const dir = join(root, id);
  mkdirSync(join(dir, 'dist'), { recursive: true });
  writeFileSync(
    join(dir, 'ghostai.extension.json'),
    JSON.stringify({ schema: 'ghostai.extension/1', id, ...overrides }),
  );
  writeFileSync(
    join(dir, 'dist', 'index.js'),
    'export const extension = {};\n',
  );
  return dir;
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'ghostai-ext-store-')));
  database = new DatabaseSync(':memory:');
  store = new ExtensionStore({ database, dir: base });
});

afterEach(() => {
  database.close();
  rmSync(base, { recursive: true, force: true });
});

describe('ExtensionStore.resolve', () => {
  it('answers rather than throwing, so one bad row cannot end the sweep', () => {
    // The contract that makes it different from `ToolboxStore.require`: the
    // host reconciles a whole directory, and an unapproved extension must not
    // take the other four down with it.
    install('broken', { entry: 'dist/missing.js' });

    const resolution = store.resolve('broken');

    expect(resolution.state).toBe('failed');
    expect(resolution.problem).toBeTruthy();
  });

  it('distinguishes never-approved from changed-since-approved', () => {
    // Two different fixes: approve it, or review the change and approve it
    // again. One "not usable" would put the operator back to reading logs.
    const dir = install('slack');

    expect(store.resolve('slack').state).toBe('unapproved');
    expect(store.resolve('slack').problem).toMatch(/never been approved/);

    store.approve('slack');
    expect(store.resolve('slack').state).toBe('approved');

    writeFileSync(
      join(dir, 'dist', 'index.js'),
      'export const extension = 1;\n',
    );
    expect(store.resolve('slack').state).toBe('drifted');
    expect(store.resolve('slack').problem).toMatch(
      /changed since it was approved/,
    );
  });

  it('revokes an approval by editing the code, with nobody remembering to', () => {
    // The whole point of hashing the directory rather than the manifest. A
    // manifest-only hash would leave this reading `approved`.
    const dir = install('slack');
    store.approve('slack');

    writeFileSync(join(dir, 'dist', 'other.js'), 'export const y = 1;\n');

    expect(store.resolve('slack').state).toBe('drifted');
  });

  it('reports a directory with no manifest as failed rather than absent', () => {
    mkdirSync(join(base, 'empty'), { recursive: true });

    expect(store.resolve('empty').state).toBe('failed');
  });

  it('carries the digest and the approval time once approved', () => {
    install('slack');
    const approved = store.approve('slack');
    const resolved = store.resolve('slack');

    expect(resolved.digest).toBe(approved.digest);
    expect(resolved.digest).toHaveLength(64);
    expect(resolved.approvedAtMs).toBe(approved.approvedAtMs);
  });

  it('records the approval time from the injected clock', () => {
    install('slack');
    const fixed = new ExtensionStore({
      database,
      dir: base,
      clock: { ...systemClock, now: () => 1_700_000_000_000 },
    });

    expect(fixed.approve('slack').approvedAtMs).toBe(1_700_000_000_000);
  });
});

describe('ExtensionStore.approve and revoke', () => {
  it('throws where resolve answers, because approving is one operator request', () => {
    // The asymmetry is deliberate: a refusal is the answer to the button they
    // pressed, where a sweep must survive one bad row.
    expect(() => store.approve('missing')).toThrow();
  });

  it('refuses an id that could not name a directory', () => {
    expect(() => store.dirFor('../evil')).toThrow(GhostError);
    expect(() => store.dirFor('../evil')).toThrow(/Not an extension id/);
  });

  it('re-approves in place rather than accumulating rows', () => {
    const dir = install('slack');
    store.approve('slack');
    writeFileSync(
      join(dir, 'dist', 'index.js'),
      'export const extension = 2;\n',
    );
    store.approve('slack');

    expect(store.resolve('slack').state).toBe('approved');
    const rows = database
      .prepare('SELECT COUNT(*) AS n FROM extension_approvals')
      .get() as { n: number };
    expect(rows.n).toBe(1);
  });

  it('forgets an approval without touching the files', () => {
    install('slack');
    store.approve('slack');
    store.revoke('slack');

    expect(store.resolve('slack').state).toBe('unapproved');
    expect(store.resolve('slack').manifest?.id).toBe('slack');
  });
});

describe('ExtensionStore.installedIds', () => {
  it('lists what looks like an install, sorted', () => {
    install('zulip');
    install('slack');

    expect(store.installedIds()).toEqual(['slack', 'zulip']);
  });

  it('skips a directory that could not be an extension, silently', () => {
    // `.DS_Store`, an unpacked `node_modules`, an editor backup folder.
    // Reporting those as broken extensions would fill the panel with rows
    // nobody can act on.
    install('slack');
    mkdirSync(join(base, 'node_modules'), { recursive: true });
    mkdirSync(join(base, '.cache'), { recursive: true });

    expect(store.installedIds()).toEqual(['slack']);
  });

  it('answers empty when the directory does not exist', () => {
    const absent = new ExtensionStore({
      database,
      dir: join(base, 'nowhere'),
    });

    expect(absent.installedIds()).toEqual([]);
  });
});

describe('ExtensionStore.resolvePath', () => {
  it('resolves an extension from an explicit path', () => {
    const elsewhere = realpathSync(
      mkdtempSync(join(tmpdir(), 'ghostai-load-')),
    );
    try {
      const dir = install('corp', {}, elsewhere);
      const resolution = store.resolvePath(dir);

      expect(resolution?.id).toBe('corp');
      expect(resolution?.state).toBe('unapproved');
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it('ignores a path that is not a directory', () => {
    writeFileSync(join(base, 'a-file'), 'x');

    expect(store.resolvePath(join(base, 'a-file'))).toBeUndefined();
    expect(store.resolvePath(join(base, 'nothing-here'))).toBeUndefined();
  });

  it('reports a directory whose manifest will not parse', () => {
    const dir = join(base, 'bad');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'ghostai.extension.json'), '{');

    expect(store.resolvePath(dir)?.state).toBe('failed');
  });
});
