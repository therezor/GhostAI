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
  DEFAULT_LIVE_STATE_TEMPLATE,
  DEFAULT_PLATFORM_HOST_TEMPLATE,
  DEFAULT_PLATFORM_TOOLBOX_TEMPLATE,
  DEFAULT_SYSTEM_PROMPT_TEMPLATE,
  DEFAULT_TOOLBOX_TEMPLATE,
  DEFAULT_WRAP_UP_TEMPLATE,
  SECTION_SEPARATOR,
  renderPromptTemplate,
  renderWrapUp,
  type LivePromptValues,
  type ParsedMentions,
  type PromptMode,
} from '@ghostai/protocol';
import { toolOutputPolicy, toolOutputTag } from '@ghostai/security';

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
   * This agent's live-state template, and its wrap-up sentence.
   *
   * Beside `systemPrompt` because they are the same kind of thing — the wording
   * an install runs on, owned by the operator rather than compiled in — even
   * though they land in the other half of the prompt. Empty means the built-in.
   */
  readonly livePrompt?: string;
  readonly wrapUpPrompt?: string;
  /**
   * The three sections that used to be composed in code with no way to reach
   * them: the platform note, the toolbox advertisement and the tool-output
   * policy. Empty means the built-in; a single space removes the section.
   *
   * They sit here rather than being derived, so "what does this agent send"
   * has one answer held by one object — the same reason `systemPrompt` does.
   */
  readonly platformPrompt?: string;
  readonly toolboxPrompt?: string;
  readonly toolPolicyPrompt?: string;
  /**
   * Whether `systemPrompt` is the static half or the entire system message.
   *
   * Absent is `template`, so a caller that predates raw mode — the CLI's
   * default agent, a test constructing a `PromptAgent` by hand — keeps the
   * assembly it had.
   */
  readonly promptMode?: PromptMode;
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

/**
 * What the prompt needs to know about a toolbox.
 *
 * A narrow view of the manifest rather than the manifest itself: this package
 * has no business knowing about capability sets or image digests, and taking the
 * whole thing would make every caller construct one.
 */
export interface PromptToolbox {
  readonly name: string;
  /** Where the workspace is mounted inside the container. */
  readonly workdir: string;
  readonly tools: readonly { readonly name: string; readonly use: string }[];
  /** Caveats about the box as a whole. */
  readonly notes: string;
  /**
   * The toolbox's `TOOLS.md`, included verbatim when it has one.
   *
   * It used to live only inside the image, reachable by a `tools` command — and a
   * model that never ran it answered a research question from search snippets
   * while the reference explaining how to read pages sat one command away.
   * Discoverable is not the same as read. This is the same file, installed beside
   * the manifest so the prompt can carry it.
   *
   * It is in the *static* half, so a provider caches it once per session rather
   * than re-sending it per iteration; `TOOLBOX_DOCS_MAX_BYTES` bounds it.
   */
  readonly docs?: string;
}

export interface BuildStaticPromptOptions {
  readonly context: StaticPromptContext;
  /** Absent is the unnamed default agent: the built-in template, rendered as `GhostAI`. */
  readonly agent?: PromptAgent;
  readonly contributors?: readonly ContextContributor[];
  /**
   * The toolbox this agent works in, when it has one.
   *
   * The toolset advertisement, and it is *prose composed from a declared list*
   * rather than a set of tool schemas: a research or Kali image carries hundreds
   * of programs the model already knows from pretraining, and declaring them as
   * schemas would cost thousands of tokens every turn to say what forty say
   * here. It sits in the static half so a provider caches it once per session.
   */
  readonly toolbox?: PromptToolbox;
  /** Injected so the prompt is assertable without depending on the test host. */
  readonly platform?: NodeJS.Platform;
  /** Overrides the derived `<os> <arch>, Node <version>` line. */
  readonly runtimeLabel?: string;
}

export interface BuildRuntimeBlockOptions {
  readonly context: RuntimePromptContext;
  /**
   * This agent's live-state template, and the sentence for a turn running out of
   * iterations. Empty means the built-in; a single space removes the section.
   *
   * Carried the way `PromptAgent.systemPrompt` is, because the same principle
   * applies: the wording an install runs on should be one an operator can read
   * and edit rather than one compiled into the binary.
   */
  readonly livePrompt?: string;
  readonly wrapUpPrompt?: string;
  /**
   * The tool-output policy, as a template. Empty means the built-in; a single
   * space removes the section, leaving the envelopes unexplained but still in
   * place — `wrapToolOutput` does not read this.
   */
  readonly toolPolicyPrompt?: string;
  /** This turn's tool-output nonce. See the module header for why it lives here. */
  readonly nonce: string;
  readonly contributors?: readonly ContextContributor[];
  /** IANA zone name. Defaults to the host's, and is injected in tests. */
  readonly timeZone?: string;
  /**
   * A correction for one iteration, about what the previous one did wrong.
   *
   * Here rather than as a message in the conversation because the runtime half is
   * rebuilt every iteration regardless, so it costs no cached prefix and leaves
   * nothing behind in history — a correction appended as a `user` message would
   * read in the transcript as something the operator said. See
   * `textToolCallCorrection` for the case that needs it.
   */
  readonly correction?: string;
}

/**
 * The toolbox section, composed rather than pasted.
 *
 * The rules that are true of *every* toolbox — that `exec` lands in a container,
 * that a shell is available, that only the workspace is mounted, where truncated
 * output goes — are written here, in code, where they cannot drift. A manifest
 * declares only what is specific to it: which programs, and what to know about
 * them. That split is the whole reason `tools` is a list and not a paragraph.
 *
 * **It no longer states where commands run.** It used to open with that, and
 * emphatically, because `exec`'s own description has to cover the host case and a
 * model resolving the apparent contradiction resolves it by refusing. That
 * sentence now lives in `commandPolicy`, which is earlier in the prompt and says
 * it for both placements — so repeating it here would be the same claim twice,
 * and this section is left to say only what is true of *this* box.
 */
function renderToolbox(toolbox: PromptToolbox | undefined, template: string | undefined): string {
  if (toolbox === undefined || toolbox.name === '') return '';

  const stored = templateOr(template, DEFAULT_TOOLBOX_TEMPLATE);
  if (stored.trim() === '') return '';

  const toolList = toolbox.tools
    .map((tool) => (tool.use === '' ? `- \`${tool.name}\`` : `- \`${tool.name}\` — ${tool.use}`))
    .join('\n');
  const notes = toolbox.notes.trim();
  // Last, and under its own heading, so the reference reads as a document rather
  // than as more of this section's prose. It is the longest thing here by an order
  // of magnitude and the part most likely to answer a question the model would
  // otherwise guess at.
  const docs = (toolbox.docs ?? '').trim();

  return renderPromptTemplate(stored, {
    name: toolbox.name,
    workdir: toolbox.workdir,
    // Each of these carries its own leading blank line, so a toolbox with no
    // notes leaves no gap where the paragraph would have been. See the
    // convention noted beside the templates in `@ghostai/protocol`.
    tools: toolList === '' ? '' : `\n\nInstalled:\n${toolList}`,
    toolList,
    notes: notes === '' ? '' : `\n\n${notes}`,
    reference: docs === '' ? '' : `\n\n### ${toolbox.name} reference\n\n${docs}`,
    docs,
  }).trim();
}

function osLabel(platform: NodeJS.Platform): string {
  if (platform === 'darwin') return 'macOS';
  if (platform === 'win32') return 'Windows';
  if (platform === 'linux') return 'Linux';
  return platform;
}

/**
 * Where commands run, and what that place is like.
 *
 * This fills `{{platformPolicy}}`, and it is generated rather than written into
 * the template because it is the one part of the identity half that depends on
 * *placement*. The same agent text has to be true whether `exec` lands on the
 * host or in a container, and those two are opposite on every point that matters:
 * whether the workspace confines the command, whether a shell is available, and
 * which OS's tools exist.
 *
 * Getting that wrong is not cosmetic. The host wording used to be emitted for
 * every agent, so a toolboxed one was told its commands ran on macOS (they run in
 * Alpine), that they were *not* confined to the workspace (only the workspace is
 * mounted, so they are), and on a Windows host that GNU tools might be missing
 * (the container has them). A model resolving a contradiction between its prompt
 * and its tools tends to resolve it by refusing.
 *
 * The **file tools are placement-independent** and that sentence is the one most
 * worth its tokens: they always act on the workspace on this machine, through the
 * jail, whatever `exec` does. Without it a model has no way to know that the file
 * it wrote and the file a command sees are the same file under two names.
 */
function commandPolicy(
  platform: NodeJS.Platform,
  runtimeLabel: string,
  workspaceId: string,
  toolbox: PromptToolbox | undefined,
  template: string | undefined,
): string {
  const boxed = toolbox !== undefined && toolbox.name !== '';

  // The branch survives only to pick which default applies. An *override* needs
  // no branch: placement is `toolbox.name`, a config fact, so an operator writing
  // this for one agent is writing the one sentence that is true of it.
  const stored = templateOr(
    template,
    boxed ? DEFAULT_PLATFORM_TOOLBOX_TEMPLATE : DEFAULT_PLATFORM_HOST_TEMPLATE,
  );
  if (stored.trim() === '') return '';

  // A toolboxed agent gets none: its shell is the container's, and the toolbox
  // section describes that one. Emitting the host's would name tools that may
  // not exist in the image and omit ones that do.
  const shell = boxed
    ? ''
    : platform === 'win32'
      ? `\n\n- Do not assume GNU tools such as \`grep\`, \`sed\` or \`awk\` are installed.
- Prefer the file tools over shelling out; prefer Windows-native commands when you must.
- If command output comes back garbled, re-run it with UTF-8 output enabled.`
      : `\n\n- Standard shell tools and UTF-8 are available.
- Prefer the file tools where they are simpler or more reliable than a command.`;

  return renderPromptTemplate(stored, {
    runtime: runtimeLabel,
    platform,
    workspaceId,
    // `boxed` already proved `toolbox` is there and named — the empty strings
    // are the host case, where there is no container to describe.
    toolbox: boxed ? toolbox.name : '',
    workdir: boxed ? toolbox.workdir : '',
    shellPolicy: shell,
  }).trim();
}

/**
 * Every contributor's static section, joined and trimmed.
 *
 * Extracted from `buildStaticPrompt` because raw mode needs the same value in a
 * different place — as `{{contributors}}` rather than as trailing sections — and
 * both modes have to keep the one obligation that matters: `staticSection` may
 * do I/O and is therefore called **once per turn**, never per iteration.
 */
export async function contributorSections(
  contributors: readonly ContextContributor[] | undefined,
  context: StaticPromptContext,
): Promise<readonly string[]> {
  const sections: string[] = [];
  for (const contributor of contributors ?? []) {
    const section = await contributor.staticSection?.(context);
    if (section !== undefined && section.trim() !== '') sections.push(section.trim());
  }
  return sections;
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
  toolbox: PromptToolbox | undefined,
): string {
  const label = agent?.label ?? '';
  const stored = agent?.systemPrompt ?? '';

  // Whitespace-only is empty. A template of three newlines is not a decision an
  // operator made, and rendering it would give the agent no identity at all.
  const template = stored.trim() === '' ? DEFAULT_SYSTEM_PROMPT_TEMPLATE : stored;

  return renderPromptTemplate(template, {
    name: label === '' ? 'GhostAI' : label,
    workspaceId,
    // Still supplied, and no longer used by the default template — see
    // `PROMPT_PLACEHOLDERS` for why handing a model the absolute root is worse
    // than withholding it. A custom prompt that asks for it still gets it.
    workspaceRoot,
    runtime: runtimeLabel,
    platformPolicy: commandPolicy(
      platform,
      runtimeLabel,
      workspaceId,
      toolbox,
      agent?.platformPrompt,
    ),
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
    options.toolbox,
  ).trim();

  const sections: string[] = rendered === '' ? [] : [rendered];

  // Before contributors, after the identity: it describes the environment every
  // later section is talking about, and a model told what it can run before it
  // is told what to do needs fewer turns to discover the difference.
  const toolbox = renderToolbox(options.toolbox, options.agent?.toolboxPrompt);
  if (toolbox !== '') sections.push(toolbox);

  sections.push(...(await contributorSections(options.contributors, options.context)));

  return sections.join(SECTION_SEPARATOR);
}

/**
 * How few iterations must remain before the model is told about it.
 *
 * The counter used to be printed on every iteration as `Agent iteration: 1 / 40`,
 * which at iteration 1 is a fact with no consequence — and this block is in the
 * *uncached* half, so it was re-sent on every request of every turn to say
 * nothing. Near the cap it is the opposite: a model that knows it has two calls
 * left can report what it has instead of being cut off mid-search.
 */
const ITERATION_WARNING_AT = 3;

/**
 * The time, in the two forms a model actually needs.
 *
 * The instant has to be unambiguous, which is what the ISO stamp is for; the
 * local reading is what a person's question means by "this afternoon", and the
 * weekday is what "this weekend" needs. Milliseconds are dropped — the previous
 * form carried them, and no question has ever turned on them.
 */
/**
 * An operator's template, or the built-in.
 *
 * Whitespace-only is *not* empty here, and that asymmetry is deliberate: empty
 * means "I have not chosen", which must keep inheriting improvements to the
 * default, while a single space is the only way to say "I want this section
 * gone". `systemPrompt` treats whitespace as empty because an identity-less agent
 * is never what anyone meant; an install with no live-state section is coherent.
 */
function templateOr(stored: string | undefined, fallback: string): string {
  return stored === undefined || stored === '' ? fallback : stored;
}

/**
 * The tool-output policy, or nothing when the operator deleted it.
 *
 * The same "empty inherits, whitespace deletes" rule as the live-state block,
 * kept in one function because raw mode fills `{{toolPolicy}}` from it too. What
 * a deletion costs is the *explanation*: `wrapToolOutput` still wraps every
 * result and still escapes a forged delimiter, so the envelopes remain and the
 * model is simply never told what they mean.
 */
function renderToolPolicy(nonce: string, template: string | undefined): string {
  const stored = template ?? '';
  if (stored !== '' && stored.trim() === '') return '';
  return toolOutputPolicy(nonce, stored);
}

function liveTime(nowMs: number, timeZone: string): string {
  const when = new Date(nowMs);
  let local: string;
  try {
    local = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(when);
  } catch {
    // An unknown zone name throws rather than falling back, and a prompt that
    // fails to build fails every turn on that agent. UTC is a worse answer than
    // the operator's zone and a far better one than no time at all.
    local = when.toISOString().replace('T', ' ').slice(0, 16);
  }
  // No `Current time:` label — that belongs to the template, which an operator
  // may reword. This returns the value the template names.
  return `${local} (${timeZone}) — ${when.toISOString().replace(/\.\d{3}Z$/, 'Z')}`;
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
 *
 * **What is no longer here is the point.** It used to print the channel, the
 * session key and an iteration counter on every request. Nothing in the prompt
 * said what any of them meant, and nothing else in the codebase read them:
 *
 *  - **The session key** is a UUID. Twenty tokens of random string per request,
 *    for an identifier the model cannot use and might echo at the user.
 *  - **The channel** — `web`, `cli` — described a difference the prompt never
 *    drew a consequence from. If one is wanted later it belongs in the static
 *    half as advice ("keep code blocks short here"), not as a bare label.
 *  - **The iteration counter** is only actionable near the cap, so it is now
 *    printed only there.
 *
 * `RuntimePromptContext` still carries all three: contributors receive it, and
 * a memory or skills section may well want to scope by session or channel. This
 * is about what reaches the *model*.
 */
export function buildRuntimeBlock(options: BuildRuntimeBlockOptions): string {
  const { context } = options;
  const timeZone = options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

  // Counted inclusively — on the last legal iteration one is left, not none —
  // because "1 left" is what a person and a model both read as "this is it".
  const left = context.maxIterations - context.iteration + 1;
  const values: LivePromptValues = {
    time: liveTime(context.nowMs, timeZone),
    // Only when it is about to matter. See `ITERATION_WARNING_AT`.
    wrapUp:
      context.maxIterations > 0 && left <= ITERATION_WARNING_AT
        ? renderWrapUp(templateOr(options.wrapUpPrompt, DEFAULT_WRAP_UP_TEMPLATE), left)
        : '',
    iteration: String(context.iteration),
    maxIterations: String(context.maxIterations),
    iterationsLeft: String(Math.max(left, 0)),
    channel: context.channel,
    sessionKey: context.sessionKey,
  };

  const live = renderPromptTemplate(
    templateOr(options.livePrompt, DEFAULT_LIVE_STATE_TEMPLATE),
    values,
  ).trim();
  const sections = live === '' ? [] : [live];

  for (const contributor of options.contributors ?? []) {
    const section = contributor.runtimeSection?.(context);
    if (section !== undefined && section.trim() !== '') sections.push(section.trim());
  }

  const policy = renderToolPolicy(options.nonce, options.toolPolicyPrompt);
  if (policy !== '') sections.push(policy);

  // Last, so it is the final thing read before the model answers. A correction
  // buried above a few hundred tokens of policy is a correction competing with
  // them for attention, and it only exists for one iteration.
  if (options.correction !== undefined && options.correction.trim() !== '') {
    sections.push(options.correction.trim());
  }

  return sections.join('\n\n');
}

/** Joins the halves the way the loop does, for tests and for reuse. */
export function composeSystemPrompt(staticPrompt: string, runtimeBlock: string): string {
  return staticPrompt + SECTION_SEPARATOR + runtimeBlock;
}

// ---------------------------------------------------------------------------
// Raw mode
// ---------------------------------------------------------------------------

export interface BuildRawPromptOptions {
  readonly context: RuntimePromptContext;
  readonly agent?: PromptAgent;
  readonly toolbox?: PromptToolbox;
  readonly platform?: NodeJS.Platform;
  readonly runtimeLabel?: string;
  readonly nonce: string;
  /**
   * The static contributor sections, already collected.
   *
   * Passed in rather than gathered here because this function runs on every
   * iteration and `staticSection` may do I/O. The caller holds the once-per-turn
   * result; see `contributorSections`.
   */
  readonly staticSections?: readonly string[];
  readonly contributors?: readonly ContextContributor[];
  readonly timeZone?: string;
  readonly correction?: string;
}

/**
 * The whole system message, from one template.
 *
 * Nothing is placed for the operator here — no separator, no live-state block,
 * no toolbox section, no tool-output policy. A template that wants one names its
 * placeholder, and a template that names none gets exactly what it says.
 *
 * The section *templates* still apply: `{{platformPolicy}}`, `{{toolbox}}` and
 * `{{toolPolicy}}` render from the agent's own overrides, so raw mode decides
 * the layout rather than throwing the wording away. `livePrompt` is the one
 * field it ignores, because its entire content is `{{time}}{{wrapUp}}` and both
 * are named here directly.
 *
 * **The cache cost is real and worth stating.** In template mode the identity
 * half is a byte-identical prefix a provider discounts for the life of the
 * session. One blob rebuilt per iteration has no such prefix if anything in it
 * moves — a `{{time}}` at the top ends the discount for everything after it, on
 * every request of every turn. A raw template that names no volatile placeholder
 * renders identically each iteration and caches exactly as well as before, which
 * is the case an operator writing a fixed instruction sheet lands in anyway.
 */
export function buildRawPrompt(options: BuildRawPromptOptions): string {
  const { context } = options;
  const platform = options.platform ?? hostPlatform;
  const runtimeLabel =
    options.runtimeLabel ?? `${osLabel(platform)} ${arch}, Node ${versions.node}`;
  const timeZone = options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

  const label = options.agent?.label ?? '';
  const stored = options.agent?.systemPrompt ?? '';
  // Whitespace-only is empty here too, and it matters more than it does in
  // template mode: a raw agent whose template renders to nothing would be sent
  // no system message at all.
  const template = stored.trim() === '' ? DEFAULT_SYSTEM_PROMPT_TEMPLATE : stored;

  const left = context.maxIterations - context.iteration + 1;
  const toolbox = renderToolbox(options.toolbox, options.agent?.toolboxPrompt);

  const runtimeSections: string[] = [];
  for (const contributor of options.contributors ?? []) {
    const section = contributor.runtimeSection?.(context);
    if (section !== undefined && section.trim() !== '') runtimeSections.push(section.trim());
  }
  const statics = (options.staticSections ?? []).join(SECTION_SEPARATOR);
  const correction = (options.correction ?? '').trim();

  return renderPromptTemplate(template, {
    name: label === '' ? 'GhostAI' : label,
    workspaceId: context.workspaceId,
    workspaceRoot: context.workspaceRoot,
    runtime: runtimeLabel,
    platformPolicy: commandPolicy(
      platform,
      runtimeLabel,
      context.workspaceId,
      options.toolbox,
      options.agent?.platformPrompt,
    ),
    time: liveTime(context.nowMs, timeZone),
    wrapUp:
      context.maxIterations > 0 && left <= ITERATION_WARNING_AT
        ? renderWrapUp(templateOr(options.agent?.wrapUpPrompt, DEFAULT_WRAP_UP_TEMPLATE), left)
        : '',
    iteration: String(context.iteration),
    maxIterations: String(context.maxIterations),
    iterationsLeft: String(Math.max(left, 0)),
    channel: context.channel,
    sessionKey: context.sessionKey,
    // The section placeholders carry their own leading blank line, so one that
    // does not apply to this agent vanishes instead of leaving a gap. The policy
    // is the exception: it is usually placed on its own, where a leading break
    // would be the template's to write.
    toolbox: toolbox === '' ? '' : `${SECTION_SEPARATOR}${toolbox}`,
    toolPolicy: renderToolPolicy(options.nonce, options.agent?.toolPolicyPrompt),
    nonce: options.nonce,
    tag: toolOutputTag(options.nonce),
    contributors: statics === '' ? '' : `${SECTION_SEPARATOR}${statics}`,
    runtimeSections: runtimeSections.length === 0 ? '' : `\n\n${runtimeSections.join('\n\n')}`,
    correction: correction === '' ? '' : `\n\n${correction}`,
  });
}
