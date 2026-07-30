import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GhostError } from '@ghostai/core';

import { TOOLBOX_DOCS_MAX_BYTES, ToolboxStore } from './toolbox-store.js';

const DIGEST = `sha256:${'d'.repeat(64)}`;

let base: string;
let database: DatabaseSync;
let store: ToolboxStore;

function install(name: string, overrides: Record<string, unknown> = {}): void {
  mkdirSync(join(base, name), { recursive: true });
  writeFileSync(
    join(base, name, 'toolbox.json'),
    JSON.stringify({ schema: 'ghostai.toolbox/1', name, image: DIGEST, ...overrides }),
  );
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'ghostai-profiles-')));
  database = new DatabaseSync(':memory:');
  store = new ToolboxStore({ database, dir: base });
});

afterEach(() => {
  database.close();
  rmSync(base, { recursive: true, force: true });
});

describe('ToolboxStore.require', () => {
  it('distinguishes not-installed from not-approved from edited', () => {
    // Three different things for an operator to do next. Collapsing them into
    // one message turns a two-second fix into a hunt.
    expect(() => store.require('research')).toThrow(/No toolbox is installed/);

    install('research');
    expect(() => store.require('research')).toThrow(/never been approved/);

    store.approve('research');
    expect(store.require('research').toolbox.name).toBe('research');

    install('research', { version: '2.0.0' });
    expect(() => store.require('research')).toThrow(/has changed since it was approved/);
  });

  it('reports the manifest path, for the read-only mount', () => {
    install('research');
    store.approve('research');
    expect(store.require('research').manifestPath).toBe(join(base, 'research', 'toolbox.json'));
  });

  it('refuses an image pinned by tag even after approval', () => {
    // Policy is re-checked on every resolution, not only at approval: a manifest
    // is data, and the machinery must not depend on having been asked nicely.
    install('research', { image: 'alpine:3.21' });
    expect(() => store.approve('research')).toThrow(/digest/);
    expect(() => store.require('research')).toThrow(/digest/);
  });

  it('accepts a bare image id, which is what a local build produces', () => {
    // GhostAI has to run offline, so images are built locally and referenced by
    // content id rather than by a registry digest.
    install('research', { image: DIGEST });
    store.approve('research');
    expect(store.require('research').toolbox.image).toBe(DIGEST);
  });

  it('refuses a toolbox name that is not a slug, rather than joining it into a path', () => {
    expect(() => store.require('../../etc')).toThrow(GhostError);
    expect(() => store.require('../../etc')).toThrow(/Not a toolbox name/);
  });
});

describe('ToolboxStore.approve', () => {
  it('is idempotent and re-approves changed contents in place', () => {
    install('research');
    const first = store.approve('research');
    install('research', { version: '2.0.0' });
    const second = store.approve('research');

    expect(second.manifestSha256).not.toBe(first.manifestSha256);
    expect(store.require('research').toolbox.version).toBe('2.0.0');
  });

  it('refuses to approve something that is not installed', () => {
    expect(() => store.approve('nope')).toThrow(/No toolbox is installed/);
  });
});

describe('ToolboxStore.revoke', () => {
  it('leaves the manifest installed but stops it resolving', () => {
    install('research');
    store.approve('research');
    store.revoke('research');

    expect(() => store.require('research')).toThrow(/never been approved/);
    expect(store.list().map((entry) => entry.name)).toEqual(['research']);
  });
});

describe('ToolboxStore.list', () => {
  it('is empty when nothing is installed and the directory does not exist', () => {
    rmSync(base, { recursive: true, force: true });
    expect(store.list()).toEqual([]);
  });

  it('reports approval state per toolbox', () => {
    install('research');
    install('kali');
    store.approve('kali');

    expect(store.list().map((entry) => [entry.name, entry.approved])).toEqual([
      ['kali', true],
      ['research', false],
    ]);
  });

  it('reports a broken manifest rather than hiding it', () => {
    // A toolbox that vanishes from the list because it fails to parse looks like
    // one that was never installed, and the operator looks in the wrong place.
    mkdirSync(join(base, 'broken'), { recursive: true });
    writeFileSync(join(base, 'broken', 'toolbox.json'), 'not json');

    const entry = store.list().find((candidate) => candidate.name === 'broken');
    expect(entry?.toolbox).toBeUndefined();
    expect(entry?.problem).toMatch(/not valid JSON/);
  });

  it('reports a directory with no manifest at all', () => {
    mkdirSync(join(base, 'empty'), { recursive: true });
    expect(store.list().find((entry) => entry.name === 'empty')?.problem).toBe('no manifest');
  });
});

/**
 * `TOOLS.md`, loaded from beside the manifest.
 *
 * It used to live only inside the image, where the model had to *choose* to run a
 * command to see it — and it did not. On the host the prompt builder can include
 * it, which is the difference between a reference being discoverable and being
 * read.
 */
describe('ToolboxStore: toolbox documentation', () => {
  function writeDocs(name: string, text: string): void {
    mkdirSync(join(base, name), { recursive: true });
    writeFileSync(join(base, name, 'TOOLS.md'), text);
  }

  it('reads it from beside the manifest', () => {
    install('research');
    writeDocs('research', '# research\n\nUse `search --read 3`.');
    store.approve('research');

    expect(store.require('research').docs).toContain('Use `search --read 3`.');
  });

  it('reports no documentation as empty rather than as a failure', () => {
    // A toolbox is complete without it. Refusing to resolve one over a missing
    // `.md` would make prose load-bearing for whether the container runs at all.
    install('research');
    store.approve('research');

    expect(store.require('research').docs).toBe('');
  });

  it('bounds how much of it is loaded', () => {
    // It goes into the cached half of the prompt, so the cost is per session
    // rather than per iteration — but a reference that grew unnoticed would still
    // take a slice of every window on the install.
    install('research');
    writeDocs('research', 'x'.repeat(TOOLBOX_DOCS_MAX_BYTES * 2));
    store.approve('research');

    expect(store.require('research').docs).toHaveLength(TOOLBOX_DOCS_MAX_BYTES);
  });

  it('is not part of the approval hash', () => {
    // The hash covers policy — image, capabilities, network ceiling. Making an
    // operator re-approve a typo fix in documentation would train them to
    // re-approve without reading, which is the one thing the gate cannot survive.
    install('research');
    writeDocs('research', 'first');
    const approved = store.approve('research');

    writeDocs('research', 'second, quite different');

    const after = store.require('research');
    expect(after.manifestSha256).toBe(approved.manifestSha256);
    expect(after.docs).toBe('second, quite different');
  });

  it('carries it on approve as well as on require', () => {
    // `approve` returns the same shape, and the CLI prints from it.
    install('research');
    writeDocs('research', 'the reference');

    expect(store.approve('research').docs).toBe('the reference');
  });
});
