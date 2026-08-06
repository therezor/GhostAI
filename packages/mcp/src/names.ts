/**
 * A remote tool's name, made safe to advertise.
 *
 * `mcp_{server}_{tool}` is the scheme `@ghostai/tools` named in advance
 * (`define.ts`, on `TOOL_NAME_PATTERN`), and it is doing two jobs at once:
 *
 *  - **Keeping the name legal.** Providers speaking the OpenAI wire accept
 *    `[A-Za-z0-9_-]{1,64}` and reject anything else *mid-turn*, as a 400 that
 *    reads like the model is broken. A server is free to advertise
 *    `search files`; the model is not free to be told about it under that name.
 *  - **Keeping the registry flat.** One shared registry holds built-ins,
 *    toolbox programs and every server's tools, and `ToolRegistry.register`
 *    treats a duplicate as a `conflict` rather than letting load order decide
 *    which one a call reaches. Qualifying by server is what makes two servers
 *    that both advertise `search` able to coexist.
 *
 * The 64-character cap is where this stops being a pure rename. Truncating
 * alone would map two long names onto one, so the tail becomes a digest of the
 * name *before* truncation — which is stable across restarts (the model's
 * prompt cache keys on these) and distinct for names sharing a prefix.
 */

import { TOOL_NAME_PATTERN } from '@ghostai/tools';

const MCP_TOOL_PREFIX = 'mcp';

/** The cap in `TOOL_NAME_PATTERN`, restated because the arithmetic needs it. */
const MAX_NAME_LENGTH = 64;

/** `_` plus eight hex characters. */
const DIGEST_LENGTH = 9;

const UNSAFE_CHARS = /[^A-Za-z0-9-]+/g;

/**
 * FNV-1a, 32-bit.
 *
 * A non-cryptographic hash is the right tool: this is a collision *avoidance*
 * measure between names an operator can see and rename, not a security
 * boundary, and reaching for `node:crypto` would make a pure module async or
 * platform-bound for no gain.
 */
function digest(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    // The FNV prime, as shifts, because `hash * 16777619` overflows a double
    // into imprecision well before it wraps.
    hash +=
      (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
    hash >>>= 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * Underscore is the separator, so it cannot survive inside a segment.
 *
 * Otherwise a server called `a_b` holding `c` and a server called `a` holding
 * `b_c` would both flatten to `mcp_a_b_c`, and the collision would be silent
 * rather than merely possible.
 */
function sanitise(value: string): string {
  return value.replace(UNSAFE_CHARS, '-');
}

/** `mcp_{server}_{tool}`, always matching `TOOL_NAME_PATTERN`. */
export function flattenToolName(serverId: string, toolName: string): string {
  const server = sanitise(serverId);
  const tool = sanitise(toolName);
  const full = `${MCP_TOOL_PREFIX}_${server}_${tool}`;
  if (full.length <= MAX_NAME_LENGTH) return full;

  // The digest goes on the end and the *tool* segment is what gives way: the
  // server prefix is how an operator recognises the row in the agent editor,
  // and losing it would make every truncated name look alike.
  const budget = MAX_NAME_LENGTH - DIGEST_LENGTH;
  return `${full.slice(0, budget)}_${digest(full)}`;
}

/**
 * The final names for one server's tools, with within-server clashes broken.
 *
 * Two upstream names can flatten to one — `read file` and `read-file` both
 * become `read-file` — and the registry would refuse the second as a conflict,
 * losing a tool for a reason nothing reports. Numbering the loser keeps both,
 * and the caller raises a warning naming what happened.
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
  const names = new Map<string, string>();
  const taken = new Set<string>();
  const collisions: string[] = [];

  for (const toolName of toolNames) {
    const base = flattenToolName(serverId, toolName);
    let candidate = base;
    let suffix = 2;
    while (taken.has(candidate)) {
      const tail = `_${String(suffix)}`;
      candidate = `${base.slice(0, MAX_NAME_LENGTH - tail.length)}${tail}`;
      suffix += 1;
    }
    if (candidate !== base) collisions.push(toolName);
    taken.add(candidate);
    names.set(toolName, candidate);
  }

  return { names, collisions };
}

/** Whether a generated name is one a provider will accept. For tests. */
export function isAdvertisableName(name: string): boolean {
  return TOOL_NAME_PATTERN.test(name);
}
