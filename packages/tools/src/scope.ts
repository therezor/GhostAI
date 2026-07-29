/**
 * Which of a registry's tools one agent may call.
 *
 * The registry is shared and must stay that way: an MCP server is one
 * connection and one set of registrations no matter how many agents are
 * configured, and giving each agent its own registry would open that connection
 * once per agent and tear it down N times on unload. So an agent gets a *view*
 * rather than a copy, and this module is the rule that view applies.
 *
 * Two conventions, both borrowed rather than invented:
 *
 *  - **An empty `allow` means "everything not denied."** The same reading as
 *    `ExecToolConfig.allowedBinaries`, and for the same reason: the alternative
 *    — empty meaning "nothing" — turns a freshly created agent into one that
 *    cannot do anything and looks broken to whoever just created it.
 *  - **`deny` beats `allow`.** An operator switching a tool off for an agent
 *    should not have that undone by a blanket allow-list somewhere else in the
 *    same object, and a rule where the answer depends on which list is longer
 *    is one nobody can predict.
 */

/** An agent's tool selection. Both lists are names as the model sees them. */
export interface ToolSelection {
  readonly allow?: readonly string[];
  readonly deny?: readonly string[];
}

/** Whether a selection lets `name` through. See the module header for the rules. */
export function selectionAllows(selection: ToolSelection | undefined, name: string): boolean {
  if (selection === undefined) return true;
  if (selection.deny?.includes(name) === true) return false;
  if (selection.allow !== undefined && selection.allow.length > 0) {
    return selection.allow.includes(name);
  }
  return true;
}

/**
 * Whether a selection is the identity — no restriction at all.
 *
 * Lets the registry hand back itself rather than a wrapper for the common case,
 * which is every agent that has not been given a tool list.
 */
export function isUnrestricted(selection: ToolSelection | undefined): boolean {
  if (selection === undefined) return true;
  const denied = selection.deny?.length ?? 0;
  const allowed = selection.allow?.length ?? 0;
  return denied === 0 && allowed === 0;
}
