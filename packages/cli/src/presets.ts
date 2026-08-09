/**
 * Where agent presets are found on disk.
 *
 * **One kind of thing, in one shape, in one place.** A preset is a JSON file
 * named `<id>.json` — the filename *is* the agent id — and that is true whether
 * it ships with GhostAI or an operator wrote it this morning. There is no
 * second location and no second format: an agent that works in a container
 * says so in its own `toolbox.name` and is otherwise an ordinary preset, which
 * is why one lives beside the toolbox-less ones rather than beside the manifest
 * of the box it names.
 *
 * That is the whole of the resolution order, and it is two directories:
 *
 *  1. `<root>/presets/<id>.json` — an operator's own. Adding one is adding a
 *     file; there is no install step, because there is nothing to install.
 *  2. `presets/<id>.json` in `@ghostbot/catalogue` — the ones that ship.
 *
 * Operator first, so a local `nano.json` wins over the shipped one. What
 * somebody put on this machine is more specific than what this project guessed.
 *
 * **The catalogue is located by resolving the package, not by a relative
 * path.** `require.resolve('@ghostbot/catalogue/package.json')` gives the same
 * answer from a workspace checkout and from a global npm install, where a path
 * relative to `dist/` gives two different ones — the hazard `VERSION` in
 * `program.ts` documents. It is the same move `resolveUiRoot` makes to find the
 * built SPA, and it fails the same way: a missing catalogue is `undefined`
 * rather than a throw, because `program.ts` imports this module's caller
 * statically and `ghost --help` must not depend on it.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join } from 'node:path';

import { GhostError } from '@ghostbot/core';
import { AgentPresetSchema, type AgentPreset } from '@ghostbot/protocol';

/** The extension every preset file carries. The stem is the agent id. */
const PRESET_SUFFIX = '.json';

/**
 * The shipped `presets/` directory, or `undefined` when the catalogue is not
 * installed. Resolved on call rather than at import: this must not do I/O while
 * a module graph is still loading for `ghost --help`.
 */
export function cataloguePresetsDir(): string | undefined {
  return catalogueSubdir('presets');
}

/**
 * The shipped `toolboxes/` directory — one subdirectory per toolbox, each with
 * a `Dockerfile` and the manifest describing its policy. `ghost install` builds
 * from here; nothing reads it at turn time.
 */
export function catalogueToolboxesDir(): string | undefined {
  return catalogueSubdir('toolboxes');
}

function catalogueSubdir(name: string): string | undefined {
  try {
    const require = createRequire(import.meta.url);
    const dir = join(
      dirname(require.resolve('@ghostbot/catalogue/package.json')),
      name,
    );
    return existsSync(dir) ? dir : undefined;
  } catch {
    return undefined;
  }
}

/** Toolbox names in the catalogue, sorted. Empty when it is not installed. */
export function listCatalogueToolboxes(): readonly string[] {
  const dir = catalogueToolboxesDir();
  if (dir === undefined) return [];
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() &&
          existsSync(join(dir, entry.name, 'toolbox.json')),
      )
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * Every directory a preset name is searched in, nearest first.
 *
 * `presetsDir` is `<root>/presets` — passed in rather than resolved here, so a
 * test can point it at a temporary home without moving the real one.
 */
export function presetDirs(presetsDir: string): readonly string[] {
  const catalogue = cataloguePresetsDir();
  return catalogue === undefined ? [presetsDir] : [presetsDir, catalogue];
}

export function parsePreset(text: string, source: string): AgentPreset {
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch (error) {
    throw new GhostError('config', `${source} is not valid JSON`, {
      cause: error,
      details: { source },
    });
  }
  const result = AgentPresetSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map(
      (issue) =>
        `  ${issue.path.length === 0 ? '(root)' : issue.path.join('.')}: ${issue.message}`,
    );
    throw new GhostError(
      'config',
      `${source} is not a valid agent preset:\n${issues.join('\n')}`,
      { cause: result.error, details: { source, issues } },
    );
  }
  return result.data;
}

export function readPreset(path: string): AgentPreset {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new GhostError('config', `${path} could not be read`, {
      cause: error,
      details: { path },
    });
  }
  return parsePreset(text, path);
}

/**
 * The ids in a directory, sorted. A missing directory is empty rather than an
 * error: `<root>/presets` exists only once somebody has put something in it.
 *
 * Reads names, not contents. A test holds every shipped file's `id` equal to
 * its filename, which is what lets a listing stay a `readdir`.
 */
export function listPresets(dir: string): readonly string[] {
  let entries: readonly string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.endsWith(PRESET_SUFFIX))
    .map((entry) => basename(entry, PRESET_SUFFIX))
    .sort();
}

/** The ids installable from any of `dirs`, nearest-first and deduplicated. */
export function listAllPresets(dirs: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  for (const dir of dirs) for (const id of listPresets(dir)) seen.add(id);
  return [...seen].sort();
}

/** The first directory in `dirs` holding `<id>.json`, or `undefined`. */
export function findPreset(
  dirs: readonly string[],
  id: string,
): string | undefined {
  for (const dir of dirs) {
    const path = join(dir, `${id}${PRESET_SUFFIX}`);
    if (existsSync(path)) return path;
  }
  return undefined;
}
