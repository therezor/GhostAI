/**
 * Finding the catalogue, and fetching it when it is not here yet.
 *
 * The catalogue is `@ghostbot/presets` — the agent presets and the toolbox
 * definitions some of them run in — and it is published from a repository of
 * its own rather than living in this one. That is the whole reason this file
 * exists: presets used to be a workspace package that shipped inside the CLI,
 * so finding them was `require.resolve` and nothing else. They are now data
 * that arrives separately and on its own cadence, which makes "where is it"
 * and "get it" two real questions.
 *
 * **Three places, nearest first, and the first one wins:**
 *
 *  1. An explicit directory — `--from`, or `GHOSTAI_CATALOGUE`. A checkout of
 *     the presets repository, which is what somebody writing a preset has.
 *  2. `<root>/catalogue/node_modules/@ghostbot/catalogue` — what `fetch` put
 *     there.
 *  3. `require.resolve('@ghostbot/presets/package.json')` — a global or
 *     workspace install. Kept because it costs one `try` and it is what worked
 *     before the split; an operator who already has the package does not have
 *     to fetch a second copy of it.
 *
 * Every one of them returns `undefined` rather than throwing when it is not
 * there. A missing catalogue is an ordinary state — a fresh install has none —
 * and the command above turns it into a sentence with a fix in it.
 *
 * **Fetching is npm's job, not ours.** `npm install --prefix` into
 * `<root>/catalogue` is why the package lands a level down under
 * `node_modules/` instead of being unpacked here directly, and the nesting is
 * worth it: npm already does integrity checking, version resolution and the
 * update case, and the alternative is a tarball reader this repo would own.
 * Node has no `tar`, so "unpack it ourselves" is not the small option it
 * sounds like.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import { GhostError } from '@ghostbot/core';

/** The package the catalogue is published as. */
export const CATALOGUE_PACKAGE = '@ghostbot/presets';

/**
 * The range `fetch` asks for.
 *
 * A range rather than `latest`, so a future breaking change to the layout has
 * to be adopted by editing this line rather than arriving on its own the next
 * time somebody runs `ghost preset update`.
 *
 * This package was briefly published as `@ghostbot/catalogue`, whose 1.x kept
 * its presets under `presets/` rather than `agents/`. The rename is what lets
 * this start at 1.0.0 rather than carrying a major bump to step over that
 * layout: under a new name there is no old layout to skip.
 */
export const CATALOGUE_RANGE = '^1.0.0';

/** Points `catalogueDir` at a checkout, for somebody writing a preset. */
export const CATALOGUE_ENV_VAR = 'GHOSTAI_CATALOGUE';

export interface CatalogueOptions {
  /** `--from`, and the only path that needs no network at all. */
  readonly from?: string | undefined;
  /** `<root>/catalogue` — the npm prefix `fetch` installs into. */
  readonly catalogueDir?: string | undefined;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/** Where `fetch` puts the package inside the prefix it is given. */
export function fetchedCatalogueDir(catalogueDir: string): string {
  return join(catalogueDir, 'node_modules', ...CATALOGUE_PACKAGE.split('/'));
}

/**
 * The catalogue's root directory, or `undefined` when there is none.
 *
 * Resolved on call rather than at import, for the reason `presets.ts` gives:
 * this must not do I/O while a module graph is still loading for
 * `ghost --help`.
 */
export function catalogueDir(
  options: CatalogueOptions = {},
): string | undefined {
  const explicit = options.from ?? options.env?.[CATALOGUE_ENV_VAR];
  // An explicit directory is not searched past: pointing `--from` at a typo and
  // silently getting the fetched copy is how somebody ships a preset they never
  // actually tested.
  if (explicit !== undefined && explicit !== '') {
    return existsSync(explicit) ? explicit : undefined;
  }

  if (options.catalogueDir !== undefined) {
    const fetched = fetchedCatalogueDir(options.catalogueDir);
    if (existsSync(fetched)) return fetched;
  }

  try {
    const require = createRequire(import.meta.url);
    return dirname(require.resolve(`${CATALOGUE_PACKAGE}/package.json`));
  } catch {
    return undefined;
  }
}

/** The agent presets, one `<id>.json` each, or `undefined`. */
export function catalogueAgentsDir(dir: string): string | undefined {
  return subdir(dir, 'agents');
}

/** One directory per toolbox, each with a `Dockerfile` and a manifest. */
export function catalogueToolboxesDir(dir: string): string | undefined {
  return subdir(dir, 'toolboxes');
}

function subdir(dir: string, name: string): string | undefined {
  const path = join(dir, name);
  return existsSync(path) ? path : undefined;
}

/**
 * The build context for one toolbox, or `undefined` when the catalogue does not
 * carry it.
 *
 * A preset can name a toolbox this catalogue has never heard of — an operator's
 * own preset, or one written against a newer catalogue — and that is a sentence
 * to print, not a crash. The `toolbox.json` has to be there as well as the
 * directory: a name with no manifest is a half-checkout, and `docker build`
 * would be the wrong error to report it with.
 */
export function catalogueToolbox(
  dir: string,
  name: string,
): string | undefined {
  const toolboxes = catalogueToolboxesDir(dir);
  if (toolboxes === undefined) return undefined;
  const context = join(toolboxes, name);
  return existsSync(join(context, 'toolbox.json')) ? context : undefined;
}

/**
 * The refusal for a catalogue that resolved but holds no `agents/`.
 *
 * Its own sentence rather than an empty list, because the case that produces it
 * is specific and the fix is not guessable: a checkout from before the layout
 * settled keeps its presets under `presets/`, so `--from` at one gives a
 * directory that exists, parses, and offers nothing. "No presets available"
 * would send somebody looking for a preset to write.
 */
export function assertCatalogueLayout(dir: string): string {
  const agents = catalogueAgentsDir(dir);
  if (agents !== undefined) return agents;
  throw new GhostError(
    'config',
    `${dir} holds no agents/ directory.\n` +
      `  ${CATALOGUE_PACKAGE} ${CATALOGUE_RANGE} is expected, and keeps its presets\n` +
      '  in agents/. Run `ghost preset update` to fetch a current one, or pass\n' +
      '  --from with a checkout of the presets repository.',
    { details: { dir, range: CATALOGUE_RANGE } },
  );
}

/**
 * Runs the fetch. Injected, so no test reaches a registry.
 *
 * Returns the exit status rather than throwing, because the caller has a better
 * message for a failure than the spawn does — it knows about `--from`.
 */
export type Fetcher = (args: readonly string[]) => number;

function npmFetch(args: readonly string[]): number {
  // `stdio: 'inherit'` and no timeout, for the same reason `docker build` gets
  // both: a first fetch over a slow link with no output looks hung.
  const result = spawnSync('npm', args, {
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error !== undefined) {
    throw new GhostError(
      'tool',
      `Could not run npm: ${result.error.message}\n` +
        '  Install npm, or pass --from with a checkout of the presets repository.',
      { cause: result.error },
    );
  }
  return result.status ?? 1;
}

export interface FetchCatalogueOptions {
  /** `<root>/catalogue`, used as an npm prefix. */
  readonly catalogueDir: string;
  readonly range?: string;
  readonly fetch?: Fetcher;
}

/**
 * Installs or updates the catalogue, and answers with where it landed.
 *
 * `--no-save` and `--no-package-lock` because the prefix is a place to put one
 * package, not a project: npm writes neither a manifest nor a lockfile there,
 * and re-running is how an update happens.
 */
export function fetchCatalogue(options: FetchCatalogueOptions): string {
  const range = options.range ?? CATALOGUE_RANGE;
  const fetch = options.fetch ?? npmFetch;
  const status = fetch([
    'install',
    '--prefix',
    options.catalogueDir,
    `${CATALOGUE_PACKAGE}@${range}`,
    '--no-save',
    '--no-package-lock',
    '--no-audit',
    '--no-fund',
  ]);
  if (status !== 0) {
    throw new GhostError(
      'tool',
      `Could not fetch ${CATALOGUE_PACKAGE}@${range}.\n` +
        '  Check the network, or pass --from with a checkout of the presets\n' +
        '  repository to install without one.',
      { details: { range, status } },
    );
  }

  const dir = fetchedCatalogueDir(options.catalogueDir);
  if (!existsSync(dir)) {
    throw new GhostError(
      'tool',
      `npm reported success but ${dir} does not exist.`,
      { details: { dir } },
    );
  }
  return dir;
}
