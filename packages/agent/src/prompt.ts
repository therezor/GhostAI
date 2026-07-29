/**
 * The system prompt, in two halves.
 *
 * A provider's prompt cache keys on an exact prefix: the longest run of leading
 * tokens identical to the previous request is free, and the first differing
 * token ends the discount for everything after it. A single prompt carrying the
 * current time therefore costs full price on every iteration of every turn —
 * and a tool-using turn is five or ten requests over the same history.
 *
 * So the prompt is assembled from a **static half** and a **runtime half**:
 *
 *  - The static half — the agent's identity template plus whatever the
 *    contributors add — is byte-identical for the life of a session. It is the
 *    cached prefix, and everything that goes in it must be stable: a timestamp,
 *    an iteration counter or a per-turn nonce placed here invalidates the cache
 *    for the whole session, which is the exact cost this split exists to avoid.
 *  - The runtime half — live state and the turn's tool-output policy — is
 *    rewritten before every request. It sits at the end, so what it invalidates
 *    is only itself.
 *
 * The loop rewrites `messages[0]` each iteration rather than appending a second
 * system message. Two system messages is a shape some providers reject and
 * others quietly reorder, and the ordering is what the cache depends on.
 *
 * **The identity text is not in this file.** It is a template in
 * `@ghostai/protocol`, because an agent owns its whole system prompt and the
 * browser edits it — so the wording and the substitution rules have to be one
 * definition. This module owns the *facts* it is rendered with, which are the
 * ones only the host knows: the platform, the architecture and the Node
 * version. Protocol owns the shape; agent owns the values.
 */

import { arch, platform as hostPlatform, versions } from 'node:process';

import {
  DEFAULT_SYSTEM_PROMPT_TEMPLATE,
  SECTION_SEPARATOR,
  renderPromptTemplate,
  type ParsedMentions,
} from '@ghostai/protocol';
import { toolOutputPolicy } from '@ghostai/security';

/**
 * The separator between top-level sections. Also joins the two halves.
 *
 * Re-exported rather than declared: it is defined beside the prompt template in
 * `@ghostai/protocol`, because the config migration there has to reproduce this
 * exact composition. Everything that imported it from this module still can.
 */
export { SECTION_SEPARATOR };

/** What a contributor is told about the session. Stable for its lifetime. */
export interface StaticPromptContext {
  /** Absolute, canonical. Every tool path resolves inside it. */
  readonly workspaceRoot: string;
  /**
   * Which workspace the session is bound to.
   *
   * Beside `workspaceRoot` rather than derived from it, because a contributor
   * that wants to scope memory or skills per workspace needs the id, not a
   * path — and adding the field to this interface once Phase 3's contributors
   * exist would break every one of them.
   */
  readonly workspaceId: string;
  readonly sessionKey: string;
  readonly agentId: string | undefined;
  /** The channel the turn arrived on — `cli`, `web`, `telegram`, a plugin id. */
  readonly channel: string;
}

export interface RuntimePromptContext extends StaticPromptContext {
  /** 1-based, and reset per turn. */
  readonly iteration: number;
  readonly maxIterations: number;
  /** Wall-clock epoch milliseconds, from the injected clock. */
  readonly nowMs: number;
  /**
   * The `@kb:` / `@mcp:` / `@skill:` mentions on the message that started this
   * turn, parsed once by the transport for every channel.
   *
   * Here rather than on `StaticPromptContext` because it changes per turn, and
   * a contributor that read a per-turn value from `staticSection` would be
   * claiming a section is stable when it is not. Nothing reads it yet — memory,
   * MCP scoping and skills arrive in Phase 3 — but a mention that never reaches
   * the prompt is a feature the UI advertises and the agent cannot see.
   */
  readonly mentions?: ParsedMentions;
}

/**
 * A source of prompt content the loop knows nothing about.
 *
 * This is the seam memory and skills arrive through in Phase 3. The
 * loop's job is to compose and cache; deciding that MEMORY.md belongs in the
 * prompt, and at what token budget, is a decision that would otherwise force the
 * agent package to depend on the memory package and every consumer of the loop
 * to construct one.
 *
 * The two halves carry different obligations, and they are not interchangeable:
 *
 *  - `staticSection` is called once per turn and may do I/O. Its result must be
 *    stable across the session — a section that changes wherever it likes hands
 *    back the cache benefit the split was built for.
 *  - `runtimeSection` is called on every iteration and is synchronous. Anything
 *    expensive there is paid five or ten times per turn, so a contributor that
 *    needs I/O should do it in `staticSection` and read the result here.
 */
export interface ContextContributor {
  readonly name: string;
  staticSection?(context: StaticPromptContext): Promise<string | undefined> | string | undefined;
  runtimeSection?(context: RuntimePromptContext): string | undefined;
}

/**
 * Who the turn is being run by.
 *
 * Both fields come from the resolved agent, and both are stable for the life of
 * a session — which is what lets them sit in the cached half of the prompt.
 */
export interface PromptAgent {
  /** Empty falls back to `GhostAI`. Fills `{{name}}`. */
  readonly label: string;
  /**
   * This agent's whole static prompt, as a template.
   *
   * Empty means the built-in `DEFAULT_SYSTEM_PROMPT_TEMPLATE` — which is what
   * keeps an install that never customised one receiving improvements to it.
   * It is not appended to anything: whatever is here *is* the identity half of
   * the prompt.
   */
  readonly systemPrompt: string;
}

export interface BuildStaticPromptOptions {
  readonly context: StaticPromptContext;
  /** Absent is the unnamed default agent: the built-in template, rendered as `GhostAI`. */
  readonly agent?: PromptAgent;
  readonly contributors?: readonly ContextContributor[];
  /** Injected so the prompt is assertable without depending on the test host. */
  readonly platform?: NodeJS.Platform;
  /** Overrides the derived `<os> <arch>, Node <version>` line. */
  readonly runtimeLabel?: string;
}

export interface BuildRuntimeBlockOptions {
  readonly context: RuntimePromptContext;
  /** This turn's tool-output nonce. See the module header for why it lives here. */
  readonly nonce: string;
  readonly contributors?: readonly ContextContributor[];
  /** IANA zone name. Defaults to the host's, and is injected in tests. */
  readonly timeZone?: string;
}

function osLabel(platform: NodeJS.Platform): string {
  if (platform === 'darwin') return 'macOS';
  if (platform === 'win32') return 'Windows';
  if (platform === 'linux') return 'Linux';
  return platform;
}

/**
 * Platform advice, because the agent's first instinct is a POSIX pipeline.
 *
 * Worth its tokens: without it a Windows install spends its opening turns
 * discovering that `grep` does not exist, one failed `exec` at a time.
 */
function platformPolicy(platform: NodeJS.Platform): string {
  if (platform === 'win32') {
    return `## Platform policy (Windows)

- Do not assume GNU tools such as \`grep\`, \`sed\` or \`awk\` are installed.
- Prefer the file tools over shelling out; prefer Windows-native commands when you must.
- If command output comes back garbled, re-run it with UTF-8 output enabled.`;
  }
  return `## Platform policy (POSIX)

- Standard shell tools and UTF-8 are available.
- Prefer the file tools where they are simpler or more reliable than a command.`;
}

/**
 * The identity section, rendered from whatever template this agent carries.
 *
 * The text itself lives in `@ghostai/protocol`, not here, and an agent that
 * stores its own replaces it wholesale — heading, workspace rules, platform
 * note, guidelines and all.
 *
 * **That is a reversal of an earlier decision, and worth stating plainly.**
 * This function used to splice an operator's paragraph into a fixed block on
 * the grounds that the chroot semantics and the guidelines were "not an
 * operator's to replace by writing a persona". The objection does not survive
 * contact with what those sentences actually are: prose telling the model what
 * is true. The jail and the exec guard live in `@ghostai/security`, are
 * enforced on every call, and have never read a word of this. An operator who
 * deletes the workspace paragraph gets an agent that is less well informed
 * about a sandbox that is exactly as tight as it was before — and in exchange,
 * the prompt an install actually runs on is one they can read and edit rather
 * than one compiled into the binary.
 *
 * What stays out of reach is in the runtime half: `toolOutputPolicy` carries
 * the turn's nonce and is a mechanism, not a message.
 */
function identity(
  workspaceRoot: string,
  workspaceId: string,
  platform: NodeJS.Platform,
  runtimeLabel: string,
  agent: PromptAgent | undefined,
): string {
  const label = agent?.label ?? '';
  const stored = agent?.systemPrompt ?? '';

  // Whitespace-only is empty. A template of three newlines is not a decision an
  // operator made, and rendering it would give the agent no identity at all.
  const template = stored.trim() === '' ? DEFAULT_SYSTEM_PROMPT_TEMPLATE : stored;

  return renderPromptTemplate(template, {
    name: label === '' ? 'GhostAI' : label,
    workspaceId,
    workspaceRoot,
    runtime: runtimeLabel,
    platformPolicy: platformPolicy(platform),
  });
}

/**
 * The cache-stable half. Built once per turn; identical across the session.
 *
 * Contributor sections are appended in the order given, after the built-in
 * ones, so the prefix a provider caches grows at the end rather than shifting
 * when a contributor is added or removed mid-session.
 */
export async function buildStaticPrompt(options: BuildStaticPromptOptions): Promise<string> {
  const platform = options.platform ?? hostPlatform;
  const runtimeLabel =
    options.runtimeLabel ?? `${osLabel(platform)} ${arch}, Node ${versions.node}`;

  // One section, not two. The operator's text used to arrive here as a separate
  // `## Instructions` block appended below a fixed identity; it is now the
  // identity itself, so there is nothing left to append it *to*. A template
  // that renders to nothing contributes no section rather than an empty one.
  const rendered = identity(
    options.context.workspaceRoot,
    options.context.workspaceId,
    platform,
    runtimeLabel,
    options.agent,
  ).trim();

  const sections: string[] = rendered === '' ? [] : [rendered];

  for (const contributor of options.contributors ?? []) {
    const section = await contributor.staticSection?.(options.context);
    if (section !== undefined && section.trim() !== '') sections.push(section.trim());
  }

  return sections.join(SECTION_SEPARATOR);
}

/**
 * The per-iteration half.
 *
 * The tool-output policy lives here, with the turn's nonce named in it, and that
 * placement is deliberate. The nonce is regenerated every turn; in the static
 * half it would invalidate the session's cached prefix on every single turn,
 * which is precisely the cost this file is organised to avoid. The policy text
 * is a few hundred tokens at the tail — the cheapest place in the prompt for
 * something that changes.
 */
export function buildRuntimeBlock(options: BuildRuntimeBlockOptions): string {
  const { context } = options;
  const timeZone = options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

  const lines = [
    `Current time: ${new Date(context.nowMs).toISOString()} (host time zone: ${timeZone})`,
    `Channel: ${context.channel}`,
    `Session: ${context.sessionKey}`,
    `Agent iteration: ${String(context.iteration)} / ${String(context.maxIterations)}`,
  ];

  const sections = [`## Live state\n\n${lines.join('\n')}`];

  for (const contributor of options.contributors ?? []) {
    const section = contributor.runtimeSection?.(context);
    if (section !== undefined && section.trim() !== '') sections.push(section.trim());
  }

  sections.push(toolOutputPolicy(options.nonce));

  return sections.join('\n\n');
}

/** Joins the halves the way the loop does, for tests and for reuse. */
export function composeSystemPrompt(staticPrompt: string, runtimeBlock: string): string {
  return staticPrompt + SECTION_SEPARATOR + runtimeBlock;
}
