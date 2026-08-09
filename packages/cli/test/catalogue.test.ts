/**
 * Finding the catalogue, and fetching it.
 *
 * The fetcher is injected throughout: nothing here reaches npm, and the one
 * thing that matters about the real one — that the package lands at
 * `<prefix>/node_modules/@ghostbot/catalogue` — is asserted by building that
 * path with the same function the resolver reads it with, so the two cannot
 * drift apart.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { GhostError } from '@ghostbot/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CATALOGUE_ENV_VAR,
  CATALOGUE_PACKAGE,
  CATALOGUE_RANGE,
  assertCatalogueLayout,
  catalogueAgentsDir,
  catalogueToolbox,
  catalogueToolboxesDir,
  fetchCatalogue,
  fetchedCatalogueDir,
} from '#src/catalogue.js';

let root: string;

/** A catalogue in the current layout: `agents/` and `toolboxes/`. */
function writeCatalogue(dir: string): string {
  mkdirSync(join(dir, 'agents'), { recursive: true });
  mkdirSync(join(dir, 'toolboxes', 'coding'), { recursive: true });
  writeFileSync(join(dir, 'toolboxes', 'coding', 'toolbox.json'), '{}');
  return dir;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ghostai-catalogue-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('catalogueDir', () => {
  it('takes an explicit directory over everything else', async () => {
    const { catalogueDir } = await import('#src/catalogue.js');
    const explicit = writeCatalogue(join(root, 'checkout'));
    writeCatalogue(fetchedCatalogueDir(join(root, 'fetched')));

    expect(
      catalogueDir({ from: explicit, catalogueDir: join(root, 'fetched') }),
    ).toBe(explicit);
  });

  it('reads the same explicit directory from the environment', async () => {
    const { catalogueDir } = await import('#src/catalogue.js');
    const explicit = writeCatalogue(join(root, 'checkout'));

    expect(catalogueDir({ env: { [CATALOGUE_ENV_VAR]: explicit } })).toBe(
      explicit,
    );
  });

  it('does not fall through when the explicit directory is missing', async () => {
    // Pointing `--from` at a typo and silently getting the fetched copy is how
    // somebody ships a preset they never actually ran.
    const { catalogueDir } = await import('#src/catalogue.js');
    writeCatalogue(fetchedCatalogueDir(join(root, 'fetched')));

    expect(
      catalogueDir({
        from: join(root, 'nope'),
        catalogueDir: join(root, 'fetched'),
      }),
    ).toBeUndefined();
  });

  it('finds the fetched copy under the prefix', async () => {
    const { catalogueDir } = await import('#src/catalogue.js');
    const prefix = join(root, 'catalogue');
    const fetched = writeCatalogue(fetchedCatalogueDir(prefix));

    expect(catalogueDir({ catalogueDir: prefix })).toBe(fetched);
  });
});

describe('the layout', () => {
  it('names both subdirectories, and nothing that is absent', () => {
    const dir = writeCatalogue(join(root, 'c'));

    expect(catalogueAgentsDir(dir)).toBe(join(dir, 'agents'));
    expect(catalogueToolboxesDir(dir)).toBe(join(dir, 'toolboxes'));
    expect(catalogueAgentsDir(join(root, 'empty'))).toBeUndefined();
  });

  it('refuses a catalogue with no agents/, naming the version it wants', () => {
    // The 1.x layout: a directory that exists, resolves, and offers nothing.
    const old = join(root, 'old');
    mkdirSync(join(old, 'presets'), { recursive: true });

    expect(() => assertCatalogueLayout(old)).toThrow(GhostError);
    expect(() => assertCatalogueLayout(old)).toThrow(CATALOGUE_RANGE);
  });

  it('answers with a build context only when the manifest is there too', () => {
    // A name with no manifest is a half-checkout, and `docker build` would be
    // the wrong error to report it with.
    const dir = writeCatalogue(join(root, 'c'));
    mkdirSync(join(dir, 'toolboxes', 'halfway'), { recursive: true });

    expect(catalogueToolbox(dir, 'coding')).toBe(
      join(dir, 'toolboxes', 'coding'),
    );
    expect(catalogueToolbox(dir, 'halfway')).toBeUndefined();
    expect(catalogueToolbox(dir, 'nowhere')).toBeUndefined();
  });
});

describe('fetchCatalogue', () => {
  it('asks npm for the pinned range, into the prefix', () => {
    const prefix = join(root, 'catalogue');
    let argv: readonly string[] = [];

    expect(
      () =>
        fetchCatalogue({
          catalogueDir: prefix,
          fetch: (args) => {
            argv = args;
            return 0;
          },
        }),
      // The install is faked, so nothing lands and the existence check fires.
    ).toThrow('does not exist');

    expect(argv).toContain('--prefix');
    expect(argv).toContain(prefix);
    expect(argv).toContain(`${CATALOGUE_PACKAGE}@${CATALOGUE_RANGE}`);
    // A prefix is a place to put one package, not a project: re-running is how
    // an update happens, and neither a manifest nor a lockfile belongs there.
    expect(argv).toContain('--no-save');
    expect(argv).toContain('--no-package-lock');
  });

  it('answers with where the package landed', () => {
    const prefix = join(root, 'catalogue');

    const dir = fetchCatalogue({
      catalogueDir: prefix,
      fetch: () => {
        writeCatalogue(fetchedCatalogueDir(prefix));
        return 0;
      },
    });

    expect(dir).toBe(fetchedCatalogueDir(prefix));
  });

  it('turns a non-zero exit into the sentence with the way out in it', () => {
    expect(() =>
      fetchCatalogue({ catalogueDir: join(root, 'c'), fetch: () => 1 }),
    ).toThrow('--from');
  });
});
