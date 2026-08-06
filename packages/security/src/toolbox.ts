/**
 * Toolboxes: parsing, policy, and the ceiling.
 *
 * A toolbox is authorised by **content hash**, not by a signature. The question
 * asked at resolution is only ever "are these exact bytes approved?", and an
 * operator answers it once by installing the toolbox. That choice is worth
 * stating because the alternative looks stronger and is not: an Ed25519
 * signature answers *who authored this policy*, which matters when a manifest
 * arrives from somewhere else and proves nothing when the key sits on the same
 * disk as the file it signs. `authorizedToolbox` is written as a single
 * predicate over bytes so a signature path can be added later as a second way to
 * satisfy the same question, without disturbing anything that calls it.
 *
 * Two refusals here are absolute, and the difference between them is the design:
 *
 *  - **An image must be digest-pinned.** A tag is a mutable pointer, so a
 *    toolbox approved once and then repointed is the approval gate defeated
 *    while every hash still matches. Nothing in the review would show it.
 *  - **`NET_ADMIN` is never grantable.** The egress gateway's rules live in a
 *    network namespace the sandbox *shares*; a sandbox holding `NET_ADMIN` can
 *    flush them. This is refused rather than surfaced because it breaks an
 *    invariant the rest of the system relies on, and no operator reviewing a
 *    manifest could be expected to reconstruct that.
 *
 * `seccomp: unconfined` is deliberately *not* in that list. It is genuinely
 * risky and genuinely required for rootless builds inside a container, so it is
 * surfaced in the install review and left to the operator. The rule of thumb:
 * refuse what silently breaks the machinery, surface what is merely dangerous.
 */

import { createHash } from 'node:crypto';

import { GhostError } from '@ghostai/core';
import {
  BUILTIN_TOOL_NAMES,
  ToolboxSchema,
  type AgentToolboxNetwork,
  type ToolboxNetworkMode,
  type Toolbox,
} from '@ghostai/protocol';

import { parseCidr } from './ip.js';

/**
 * The two immutable ways to name an image.
 *
 * `name@sha256:<64 hex>` is a registry digest. A bare `sha256:<64 hex>` is a
 * local image **ID**, which is what `docker build` produces and what a toolbox
 * built on this machine has to reference — there is no registry digest until
 * something is pushed. Both are content addresses, so both are as unrepointable
 * as the other; a tag is neither.
 *
 * **Anchored at both ends deliberately.** A pattern anchored only at the end
 * accepts `-v/:/hostfs@sha256:<64 hex>`, and the image is pushed to `docker run`
 * as a bare argv token — so a manifest could smuggle a flag past the check and
 * bind host root into the sandbox. That is not currently exploitable, because the
 * token after the image happens to be one docker rejects, but it survives by
 * accident of argument order rather than by design.
 */
const IMAGE_DIGEST_PATTERN: RegExp =
  /^[a-z0-9][a-z0-9._\-/:]*@sha256:[0-9a-f]{64}$|^sha256:[0-9a-f]{64}$/;

/**
 * Tool names a toolbox entry may not take.
 *
 * Re-exported from `@ghostai/protocol` rather than restated, and not imported
 * from `@ghostai/tools` where the tools are actually defined: that package sits
 * *above* this one, and security deciding what is allowed by asking the layer
 * it constrains would invert the graph. `protocol` sits under both, and
 * `packages/tools` owns the test that the list still matches `BUILTIN_TOOLS`.
 */
export { BUILTIN_TOOL_NAMES };

/** Capabilities a toolbox may never request. See the module header. */
const FORBIDDEN_CAPABILITIES: readonly string[] = [
  'NET_ADMIN',
  'SYS_ADMIN',
  'SYS_MODULE',
];

/** Ordered weakest to strongest, which is what makes the ceiling a `min`. */
const NETWORK_ORDER: readonly ToolboxNetworkMode[] = [
  'none',
  'allowlist',
  'open',
];

function rank(mode: ToolboxNetworkMode): number {
  return NETWORK_ORDER.indexOf(mode);
}

/**
 * The sha256 of a manifest's exact bytes.
 *
 * Over the bytes, never over a re-serialisation of the parsed object: a toolbox
 * that round-trips through `JSON.stringify` gains and loses whitespace and key
 * order, and an approval keyed on that would break on a formatter rather than on
 * a change of meaning.
 */
export function manifestHash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Parses manifest bytes, with the schema's own errors turned into a sentence. */
export function parseToolbox(bytes: Uint8Array): Toolbox {
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch (error) {
    throw new GhostError('config', 'Profile manifest is not valid JSON', {
      cause: error,
    });
  }
  const result = ToolboxSchema.safeParse(json);
  if (!result.success) {
    const detail = result.error.issues
      .map(
        (issue) =>
          `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`,
      )
      .join('; ');
    throw new GhostError('config', `Profile manifest is not valid: ${detail}`);
  }
  return result.data;
}

/**
 * Refuses a toolbox the machinery cannot honour.
 *
 * Separate from parsing because a manifest can be perfectly well-formed and
 * still ask for something that would quietly disable a guarantee elsewhere.
 */
export function assertToolboxPolicy(toolbox: Toolbox): void {
  if (!IMAGE_DIGEST_PATTERN.test(toolbox.image)) {
    throw new GhostError(
      'config',
      `Toolbox "${toolbox.name}" must pin its image by digest, not by tag: ${toolbox.image}\n` +
        '  A tag can be repointed after approval, which would leave the recorded hash\n' +
        '  matching an image nobody reviewed. Use name@sha256:<digest>.',
      { details: { toolbox: toolbox.name, image: toolbox.image } },
    );
  }

  for (const capability of toolbox.caps.add) {
    const name = capability.toUpperCase().replace(/^CAP_/, '');
    if (FORBIDDEN_CAPABILITIES.includes(name)) {
      throw new GhostError(
        'config',
        `Toolbox "${toolbox.name}" asks for ${capability}, which is never granted.\n` +
          "  The egress gateway's rules live in a namespace the sandbox shares, and a\n" +
          '  sandbox holding NET_ADMIN could flush them.',
        { details: { toolbox: toolbox.name, capability } },
      );
    }
  }

  // A declared entry becomes a callable under `expose: 'tools'`, and one named
  // `read_file` would shadow the jailed built-in with an unjailed shell command.
  // Refused rather than surfaced: no operator reading a manifest would spot that
  // a program name is also a tool name.
  for (const entry of toolbox.tools) {
    if (BUILTIN_TOOL_NAMES.includes(entry.name)) {
      throw new GhostError(
        'config',
        `Toolbox "${toolbox.name}" declares a program called "${entry.name}", which is the
` +
          '  name of a built-in tool. Exposed as a callable it would shadow that tool.',
        { details: { toolbox: toolbox.name, entry: entry.name } },
      );
    }
  }

  for (const cidr of toolbox.network.proxyAllowHosts) {
    if (cidr.trim() === '') {
      throw new GhostError(
        'config',
        `Toolbox "${toolbox.name}" has an empty proxy host entry`,
        {
          details: { toolbox: toolbox.name },
        },
      );
    }
  }
}

/**
 * Refuses an agent asking for more network than its toolbox permits.
 *
 * Thrown at agent resolution rather than clamped at turn time. Silently
 * narrowing would leave `config.json` saying one thing while the sandbox did
 * another, and the operator who wrote `open` would have no way to discover it.
 */
export function assertNetworkWithinCeiling(
  toolbox: Toolbox,
  requested: AgentToolboxNetwork,
  agentId: string,
): void {
  if (rank(requested.mode) > rank(toolbox.network.maxMode)) {
    throw new GhostError(
      'config',
      `Agent "${agentId}" asks for network "${requested.mode}", but toolbox ` +
        `"${toolbox.name}" permits at most "${toolbox.network.maxMode}".`,
      {
        details: {
          agentId,
          toolbox: toolbox.name,
          requested: requested.mode,
          maximum: toolbox.network.maxMode,
        },
      },
    );
  }
  if (requested.mode === 'allowlist' && requested.allow.length === 0) {
    throw new GhostError(
      'config',
      `Agent "${agentId}" asks for an allow-list with no entries, which reaches nothing.\n` +
        '  Use mode "none" if that is the intent.',
      { details: { agentId, toolbox: toolbox.name } },
    );
  }
  for (const entry of requested.allow) {
    if (parseCidr(entry) === null) {
      throw new GhostError(
        'config',
        `Agent "${agentId}" has an egress entry that is not a CIDR block: ${entry}\n` +
          '  Hostnames are refused here because DNS rebinding defeats them. Use 10.0.0.0/8.',
        { details: { agentId, entry } },
      );
    }
  }
}

/** What a toolbox and an agent's request resolve to together. */
export interface EffectiveNetwork {
  readonly mode: ToolboxNetworkMode;
  readonly allow: readonly string[];
  readonly dns: readonly string[];
  readonly proxyAllowHosts: readonly string[];
}

/**
 * The intersection of a toolbox's ceiling and an agent's request.
 *
 * Defensive even though `assertNetworkWithinCeiling` has usually already run:
 * this is the value the runner turns into flags, and a `min` here means no
 * ordering of calls can produce a container with more reach than its toolbox
 * allows. The property worth testing is that it never widens.
 */
export function effectiveNetwork(
  toolbox: Toolbox,
  requested: AgentToolboxNetwork,
): EffectiveNetwork {
  const mode =
    rank(requested.mode) < rank(toolbox.network.maxMode)
      ? requested.mode
      : toolbox.network.maxMode;
  return {
    mode,
    allow: mode === 'allowlist' ? [...requested.allow] : [],
    dns: [...toolbox.network.dns],
    proxyAllowHosts: [...toolbox.network.proxyAllowHosts],
  };
}

/**
 * Everything about a toolbox that grants more than the defaults do.
 *
 * The list used to be `seccomp` and `readOnlyRoot`, which left the two fields
 * that actually reach the host invisible: `security.devices` becomes
 * `--device=…`, so `/dev/sda:/dev/sda:rwm` is raw disk access, and `user: "0:0"`
 * runs as root inside. A manifest asking for both passed `assertToolboxPolicy`
 * and printed nothing but image, network and limits to the person approving it —
 * a total escape presented as a clean toolbox. Neither is *refused*, because a
 * device is legitimate for a rootless builder; both are named loudly.
 */
export function weakenedIn(toolbox: Toolbox): readonly string[] {
  const weakened: string[] = [];
  if (toolbox.security.devices.length > 0) {
    weakened.push(
      `devices    ${toolbox.security.devices.join(', ')}  (host device access)`,
    );
  }
  if (toolbox.user === '' || toolbox.user.startsWith('0:')) {
    weakened.push(
      `user       ${toolbox.user === '' ? 'image default' : toolbox.user}  (may be root)`,
    );
  }
  if (toolbox.security.seccomp !== 'default') {
    weakened.push(`seccomp    ${toolbox.security.seccomp}`);
  }
  if (!toolbox.security.readOnlyRoot) weakened.push('rootfs     writable');
  if (toolbox.runtime !== 'runc') {
    weakened.push(`runtime    ${toolbox.runtime}`);
  }
  if (toolbox.workdir === '/') {
    weakened.push('workdir    / (mounts the workspace over the root)');
  }
  return weakened;
}
