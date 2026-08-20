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
 *  - **An array replaces.** `allowedBinaries: ['git']` means that binary, not it
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

import { GhostError } from '@ghostwire/core';
import {
  ConfigSchema,
  type Config,
  type ConfigPatch,
} from '@ghostwire/protocol';

/**
 * Dotted paths whose object value is replaced, not merged. `*` matches one key.
 *
 * The distinction a generic merge cannot make: a *struct* (`server`, `tools`)
 * is a set of independently editable fields, and a *record* is one value the UI
 * edits as a whole. Everything here is the latter.
 */
const REPLACE_WHOLESALE: readonly string[] = [
  'providers.*.extraHeaders',
  // The same argument as `extraHeaders`, twice: both are edited as one block of
  // text in the MCP editor, and merging key by key would make removing an
  // entry impossible to express — an absent key means "not mentioned".
  'tools.mcpServers.*.env',
  'tools.mcpServers.*.headers',
  // An agent is edited as a whole. Merging per field would make clearing one
  // impossible to express: an absent key means "not mentioned", so an operator
  // emptying the temperature box would silently keep the value they just
  // deleted. Replacing means the patch *is* the agent — which is exactly what
  // the editor sends, and what makes an empty box mean "send nothing" all the
  // way through. The re-parse then fills whatever the patch did not name from
  // the schema, so a replaced entry is still complete.
  //
  // Unlike `providers.*`, which merges per instance: a provider's fields all
  // have values, so none of them has a "cleared" state to express.
  'agents.list.*',
  // An extension parses its own block, so this layer does not know its shape
  // and cannot know which of its keys is a struct field and which a record
  // entry. Replacing is the only rule that is right without that knowledge —
  // and it is what the extension's own settings form sends anyway.
  'extensions.settings.*',
];

/**
 * Dotted paths where a `null` removes the key rather than merging into it.
 *
 * Deliberately a list rather than a blanket rule. `null` anywhere else is a
 * value the schema either accepts or rejects, and letting it delete would mean
 * a patch could punch a hole in a struct — dropping `server.port` and failing
 * the re-parse at best, silently reverting it at worst. Every entry here names a
 * *record whose entries an operator adds and removes*.
 *
 * There is no leaf in this list. There used to be two — an agent's `temperature`
 * and `reasoningEffort` — because the settings block they lived in merged per
 * field and had no other way to say "remove this". An agent replaces wholesale,
 * so omitting the key is already how that is said.
 */
const DELETE_BY_NULL: readonly string[] = [
  'providers.*',
  'tools.mcpServers.*',
  // A leaf, like the two below, and for the same reason: `oauth` is genuinely
  // `.optional()` in the schema, so "this server does not use OAuth" is a real
  // state that needs a way to be said. Without it, switching authorization off
  // in the editor would send a patch that does not mention `oauth` — and an
  // absent key means "not mentioned", so the flow would survive a save that
  // looked like it had removed one.
  'tools.mcpServers.*.oauth',
  'agents.list.*',
  // A record an operator adds to and removes from, like `providers.*`:
  // uninstalling an extension has to be able to take its settings with it.
  'extensions.settings.*',
];

function matchesPath(
  patterns: readonly string[],
  path: readonly string[],
): boolean {
  return patterns.some((pattern) => {
    const segments = pattern.split('.');
    if (segments.length !== path.length) return false;
    return segments.every(
      (segment, index) => segment === '*' || segment === path[index],
    );
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function mergeValue(
  base: unknown,
  patch: unknown,
  path: readonly string[],
): unknown {
  if (!isPlainObject(patch)) return patch;
  if (matchesPath(REPLACE_WHOLESALE, path)) return patch;

  /**
   * A patch that creates something still gets walked.
   *
   * This used to return `patch` verbatim whenever `base` was not an object,
   * which is right for the *merge* — there is nothing to merge into — and wrong
   * for the deletions, because it skipped the `DELETE_BY_NULL` pass below. A
   * `null` meaning "unset" then survived into the merged tree and failed the
   * re-parse as "expected object, received null". Deleting a key from nothing is
   * a no-op; leaving the token that says so in the result is not.
   *
   * It went unnoticed because until `tools.mcpServers.<id>.oauth` no
   * delete-by-null path lived under a record entry an operator can create:
   * `providers.*` has no nullable field, and every other record entry was a
   * whole value rather than a struct with a nullable leaf inside it.
   */
  const source = isPlainObject(base) ? base : {};

  // Collected and applied at the end rather than deleted in place: a dynamic
  // `delete` on an object literal is what the lint rule is about, and rebuilding
  // once is both cheaper and easier to read than mutating mid-walk.
  const deleted = new Set<string>();
  const merged: Record<string, unknown> = { ...source };
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

    merged[key] = mergeValue(source[key], value, childPath);
  }

  if (deleted.size === 0) return merged;
  return Object.fromEntries(
    Object.entries(merged).filter(([key]) => !deleted.has(key)),
  );
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
      (issue) =>
        `  ${issue.path.length === 0 ? '(root)' : issue.path.join('.')}: ${issue.message}`,
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
