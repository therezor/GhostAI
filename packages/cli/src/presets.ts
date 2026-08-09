/**
 * Where agent presets are found on disk.
 *
 * **One kind of thing, in one shape, in one place.** A preset is a JSON file
 * named `<id>.json` — the filename *is* the agent id — and that is true whether
 * it came from the catalogue or an operator wrote it this morning. There is no
 * second location and no second format: an agent that works in a container
 * says so in its own `toolbox.name` and is otherwise an ordinary preset, which
 * is why one lives beside the toolbox-less ones rather than beside the manifest
 * of the box it names.
 *
 * That is the whole of the resolution order, and it is two directories:
 *
 *  1. `<root>/presets/<id>.json` — an operator's own. Adding one is adding a
 *     file; there is no install step, because there is nothing to install.
 *  2. `agents/<id>.json` in the catalogue — the ones `ghostai preset install`
 *     offers. Where that directory *is* is `catalogue.ts`'s question, and it
 *     is passed in here rather than resolved, because the answer depends on
 *     the root and on `--from`.
 *
 * Operator first, so a local preset wins over the catalogue's of the same
 * name. What somebody put on this machine is more specific than what a package
 * guessed.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';

import { GhostError } from '@ghostwire/core';
import { AgentPresetSchema, type AgentPreset } from '@ghostwire/protocol';

/** The extension every preset file carries. The stem is the agent id. */
const PRESET_SUFFIX = '.json';

/**
 * Every directory a preset name is searched in, nearest first.
 *
 * Both are passed in rather than resolved here, so a test can point them at a
 * temporary home without moving the real one.
 */
export function presetDirs(
  presetsDir: string,
  agentsDir?: string,
): readonly string[] {
  return agentsDir === undefined ? [presetsDir] : [presetsDir, agentsDir];
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
