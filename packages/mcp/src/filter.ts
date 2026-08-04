/**
 * `enabledTools` — which of a server's tools this install advertises at all.
 *
 * Applied to the **upstream** names, before flattening, and that is the whole
 * of the design: the names an operator reads in a server's own documentation
 * are the names they type here. Matching on `mcp_github_create_issue` would
 * make the config a function of this client's naming scheme.
 *
 * Note the layering against the per-agent permission map. This narrows what the
 * *install* holds; `agents.list.<id>.tools` decides who may call what is left.
 * A tool filtered out here occupies no name, appears in no agent editor, and
 * costs no prompt tokens — which is the point for a server advertising forty
 * tools when two of them are wanted.
 */

import type { McpToolDescriptor } from './session.js';

/** The schema's own default: everything the server advertises. */
const WILDCARD = '*';

export interface ToolSelection {
  readonly selected: readonly McpToolDescriptor[];
  /** Entries that matched nothing — a warning, never a failure. */
  readonly unmatched: readonly string[];
}

function matches(pattern: string, name: string): boolean {
  if (pattern === WILDCARD) return true;
  // A trailing `*` and nothing more elaborate. A server grouping its tools by
  // prefix (`repo_`, `issue_`) is common enough to be worth one character of
  // syntax; a full glob would be a second mini-language to specify, validate
  // and document for a field an operator writes once.
  if (pattern.endsWith(WILDCARD)) {
    return name.startsWith(pattern.slice(0, -1));
  }
  return pattern === name;
}

export function selectTools(
  advertised: readonly McpToolDescriptor[],
  enabledTools: readonly string[],
): ToolSelection {
  if (enabledTools.some((pattern) => pattern === WILDCARD)) {
    return { selected: advertised, unmatched: [] };
  }

  const selected = advertised.filter((descriptor) =>
    enabledTools.some((pattern) => matches(pattern, descriptor.name)),
  );
  // Reported so an operator who mistyped a tool name finds out from the
  // Extensions row rather than from a model that never reaches for it.
  const unmatched = enabledTools.filter(
    (pattern) =>
      !advertised.some((descriptor) => matches(pattern, descriptor.name)),
  );

  return { selected, unmatched };
}
