/**
 * Applying a settings patch to the live config.
 *
 * `ConfigPatch` is the deep-partial `patchOf()` builds — every field optional
 * and stripped of its default — so a settings panel can save its own section
 * without restating the whole tree. Turning one back into a `Config` is a deep
 * merge, and the three rules that make it correct are:
 *
 *  - **A key the patch does not mention is not touched.** This is the whole
 *    point of `patchOf` over `.partial()`, and it is undone by any merge that
 *    walks the *schema* rather than the patch.
 *  - **An array replaces.** `pinnedSkills: ['a']` means those skills, not those
 *    plus whatever was there; there is no way to express a removal otherwise.
 *  - **A record of values edited as a unit replaces too** — see
 *    `REPLACE_WHOLESALE`. Merging `extraHeaders` key-by-key would make deleting
 *    a header impossible, since the patch has no syntax for "absent".
 *
 * The merged tree is re-parsed through `ConfigSchema` rather than cast. A patch
 * validates field by field, but only the full schema knows the result is a
 * `Config` — and if a future cross-field refinement lands, this is where the
 * bad combination is caught instead of reaching a provider as a 400.
 */

import { GhostError } from '@ghostai/core';
import { ConfigSchema, type Config, type ConfigPatch } from '@ghostai/protocol';

/**
 * Dotted paths whose object value is replaced, not merged. `*` matches one key.
 *
 * The distinction a generic merge cannot make: a *struct* (`agents.defaults`)
 * is a set of independently editable fields, and a *record* is one value the UI
 * edits as a whole. Everything here is the latter.
 */
const REPLACE_WHOLESALE: readonly string[] = ['providers.*.extraHeaders'];

function matchesReplacePath(path: readonly string[]): boolean {
  return REPLACE_WHOLESALE.some((pattern) => {
    const segments = pattern.split('.');
    if (segments.length !== path.length) return false;
    return segments.every((segment, index) => segment === '*' || segment === path[index]);
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function mergeValue(base: unknown, patch: unknown, path: readonly string[]): unknown {
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch;
  if (matchesReplacePath(path)) return patch;

  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    // `undefined` is "not mentioned", not "set to nothing". JSON cannot carry
    // it at all, so the only way it arrives is a JS caller spreading an
    // optional field — and treating that as a deletion would silently drop a
    // setting the caller never meant to name.
    if (value === undefined) continue;
    merged[key] = mergeValue(base[key], value, [...path, key]);
  }
  return merged;
}

/**
 * The live config with a validated patch applied.
 *
 * Pure: the caller decides whether the result is written to `config.json`,
 * handed to `reconfigure`, or only previewed.
 */
export function mergeConfigPatch(config: Config, patch: ConfigPatch): Config {
  const merged = mergeValue(config, patch, []);
  const result = ConfigSchema.safeParse(merged);
  if (!result.success) {
    const issues = result.error.issues.map(
      (issue) => `  ${issue.path.length === 0 ? '(root)' : issue.path.join('.')}: ${issue.message}`,
    );
    throw new GhostError(
      'config',
      `Settings patch produces invalid settings:\n${issues.join('\n')}`,
      {
        cause: result.error,
        details: { issues },
      },
    );
  }
  return result.data;
}
