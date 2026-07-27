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
 *  - The static half — identity, workspace, platform policy, guidelines, and
 *    whatever the contributors add — is byte-identical for the life of a
 *    session. It is the cached prefix, and everything that goes in it must be
 *    stable: a timestamp, an iteration counter or a per-turn nonce placed here
 *    invalidates the cache for the whole session, which is the exact cost this
 *    split exists to avoid.
 *  - The runtime half — live state and the turn's tool-output policy — is
 *    rewritten before every request. It sits at the end, so what it invalidates
 *    is only itself.
 *
 * The loop rewrites `messages[0]` each iteration rather than appending a second
 * system message. Two system messages is a shape some providers reject and
 * others quietly reorder, and the ordering is what the cache depends on.
 */

import { arch, platform as hostPlatform, versions } from 'node:process';

import type { ParsedMentions } from '@ghostai/protocol';
import { toolOutputPolicy } from '@ghostai/security';

/** The separator between top-level sections. Also joins the two halves. */
export const SECTION_SEPARATOR = '\n\n---\n\n';

/** What a contributor is told about the session. Stable for its lifetime. */
export interface StaticPromptContext {
  /** Absolute, canonical. Every tool path is relative to it. */
  readonly workspaceRoot: string;
  readonly sessionKey: string;
  readonly profileId: string | undefined;
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
 * This is the seam memory, skills and profiles arrive through in Phase 3. The
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

export interface BuildStaticPromptOptions {
  readonly context: StaticPromptContext;
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

const GUIDELINES = `## Guidelines

- State what you are about to do before calling a tool, but never describe a result you have not received yet.
- Read a file before you modify it. Do not assume a file or directory exists.
- After writing or editing a file, read it back when accuracy matters.
- When a tool call fails, work out why from the error before trying a different approach.
- Ask when a request is ambiguous rather than guessing which reading was meant.
- Answer in the conversation. Tools are for acting on the world, not for talking.`;

function identity(workspaceRoot: string, platform: NodeJS.Platform, runtimeLabel: string): string {
  return `# GhostAI

You are GhostAI, a self-hosted agent running on your user's own machine, with
their files and their shell. You work on their behalf and answer to them alone.

## Runtime

${runtimeLabel}

## Workspace

Root: ${workspaceRoot}

Every path you pass to a tool is interpreted relative to that root. Absolute
paths, \`~\` and \`..\` are rejected — not silently corrected — so say
\`notes/todo.md\`, never \`${workspaceRoot}/notes/todo.md\`.

${platformPolicy(platform)}

${GUIDELINES}`;
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

  const sections: string[] = [identity(options.context.workspaceRoot, platform, runtimeLabel)];

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
