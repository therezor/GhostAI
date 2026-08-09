/**
 * A remote tool's name, made safe to advertise: `mcp_{server}_{tool}`.
 *
 * The arithmetic — the character class, the 64-character cap, the digest tail
 * that keeps two truncated names apart — is `namespacedToolName` in
 * `@ghostwire/tools`, because the extension host needs exactly the same rule
 * under a different prefix and a copy would drift the first time the cap moved.
 * What is MCP's here is the prefix and nothing else.
 */

import { namespacedToolName, namespacedToolNames } from '@ghostwire/tools';

const MCP_TOOL_PREFIX = 'mcp';

/** `mcp_{server}_{tool}`, always matching `TOOL_NAME_PATTERN`. */
export function flattenToolName(serverId: string, toolName: string): string {
  return namespacedToolName(MCP_TOOL_PREFIX, serverId, toolName);
}

/**
 * The final names for one server's tools, with within-server clashes broken.
 *
 * Insertion order decides who keeps the plain name, and the caller hands these
 * in the order the server advertised them: that is the only ordering the
 * operator can see in the server's own documentation.
 */
export function flattenToolNames(
  serverId: string,
  toolNames: readonly string[],
): {
  readonly names: ReadonlyMap<string, string>;
  readonly collisions: readonly string[];
} {
  return namespacedToolNames(MCP_TOOL_PREFIX, serverId, toolNames);
}

export { isAdvertisableName } from '@ghostwire/tools';
