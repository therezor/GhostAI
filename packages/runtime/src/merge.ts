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
 *  - **`null` deletes, but only where deletion is meaningful** — see
 *    `DELETE_BY_NULL`. A record whose *entries* an operator creates and removes
 *    — provider instances, MCP servers — needs a way to say "remove this one",
 *    and the alternative was a bespoke delete method on every port that touches
 *    settings.
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
const REPLACE_WHOLESALE: readonly string[] = [
  'providers.*.extraHeaders',
  // An agent is edited as a whole, and almost every field on it is an
  // *override* that may be absent. Merging per field would make clearing one
  // impossible to express: an absent key means "not mentioned", so an operator
  // emptying the model box would silently keep the model they just deleted.
  // Replacing means the patch is the agent — which is exactly what the editor
  // sends, and what makes an empty box mean "inherit" all the way through.
  //
  // Unlike `providers.*`, which merges per instance: a provider's fields all
  // have values, so none of them has a "cleared" state to express.
  'agents.list.*',
];

/**
 * Dotted paths where a `null` removes the key rather than merging into it.
 *
 * Deliberately a list rather than a blanket rule. `null` anywhere else is a
 * value the schema either accepts or rejects, and letting it delete would mean
 * a patch could punch a hole in a struct — dropping `agents.defaults.model` and
 * failing the re-parse at best, silently reverting it at worst. Every entry
 * here names a *record whose entries an operator adds and removes*.
 */
const DELETE_BY_NULL: readonly string[] = ['providers.*', 'tools.mcpServers.*', 'agents.list.*'];

function matchesPath(patterns: readonly string[], path: readonly string[]): boolean {
  return patterns.some((pattern) => {
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
  if (matchesPath(REPLACE_WHOLESALE, path)) return patch;

  // Collected and applied at the end rather than deleted in place: a dynamic
  // `delete` on an object literal is what the lint rule is about, and rebuilding
  // once is both cheaper and easier to read than mutating mid-walk.
  const deleted = new Set<string>();
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    // `undefined` is "not mentioned", not "set to nothing". JSON cannot carry
    // it at all, so the only way it arrives is a JS caller spreading an
    // optional field — and treating that as a deletion would silently drop a
    // setting the caller never meant to name.
    if (value === undefined) continue;

    const childPath = [...path, key];
    // `null` is different: it can only arrive from a caller that wrote it, and
    // it survives JSON, so it is the one token available to mean "remove this".
    if (value === null && matchesPath(DELETE_BY_NULL, childPath)) {
      deleted.add(key);
      continue;
    }

    merged[key] = mergeValue(base[key], value, childPath);
  }

  if (deleted.size === 0) return merged;
  return Object.fromEntries(Object.entries(merged).filter(([key]) => !deleted.has(key)));
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
