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
 *  - The runtime half — live state, the turn's delimiter, a correction — is
 *    rewritten before every request. It must be the last thing in the *request*,
 *    not merely the last thing in the system message.
 *
 * **That distinction is the whole point, and it was once got wrong here.** The
 * runtime half used to be appended to the system message, which is `messages[0]`
 * — the *front* of the request. Everything after it is the conversation, so a
 * changed iteration counter ended the discount for the entire history on every
 * request: a ten-iteration turn over a long conversation paid for that history
 * ten times. The halves are now composed into different messages, and the loop
 * sends the runtime half as a trailing turn after the history:
 *
 * ```
 * system( staticPrompt )      ← cached, session-stable
 * tools                       ← cached, stable per turn
 * ...history                  ← cached, append-only
 * user( <system-reminder> )   ← the only part re-read at full price
 * ```
 *
 * A trailing *user* message rather than a second system one: two system messages
 * is a shape some providers reject and others quietly reorder, and the ordering
 * is what the cache depends on. `AgentLoop` wraps it so the model reads it as
 * operator metadata rather than as something the user typed.
 *
 * The tool-output policy moved with that reasoning too. It is the largest block
 * in the prompt that never changes, and it sat in the runtime half only because
 * it named a per-turn delimiter; the delimiter is now one line of live state and
 * the prose is cached. See `DEFAULT_TOOL_POLICY_TEMPLATE`.
 *
 * **The identity text is not in this file.** It is a template in
 * `@ghostwire/protocol`, because an agent owns its whole system prompt and the
 * browser edits it — so the wording and the substitution rules have to be one
 * definition. This module owns the *facts* it is rendered with, which are the
 * ones only the host knows: the platform, the architecture and the Node
 * version. Protocol owns the shape; agent owns the values.
 *
 * ## Who decides what
 *
 * Three jobs, and they belong to three different places. Fusing any two of them
 * is what produced the mess this note now guards against.
 *
 *  1. **What a section says** — the operator, through the config. Their wording
 *     carries three states in one string: empty inherits the built-in, a single
 *     space deletes the section, anything else replaces it. That encoding is the
 *     config's, it is decoded here at `templateOr` and `renderToolPolicy`, and
 *     nothing above this module should be writing values into it.
 *  2. **Whether a section applies to this turn** — the caller, and only the
 *     caller. `AgentLoop` knows whether the model is being sent tools; this
 *     module never asks and is never told. It is expressed by handing over
 *     `PromptTools` or not handing it over, so the answer arrives as the
 *     presence of an input rather than as a flag to branch on.
 *  3. **What the prompt looks like** — this module. Render each section from its
 *     inputs, place it in the half that fits, join.
 *
 * The rule that falls out, and the one worth holding: **a section that does not
 * apply has no input, and a section with no input renders nothing.** No builder
 * below takes a boolean saying a feature is off, and none of them needs one —
 * which is what stops "tools are off" from having to be repeated in each of
 * them, and stops the next such switch from having to be repeated again.
 *
 * The tool-output policy is the case that proves it. Which half emits it is
 * decided by the operator's own template, so *two* builders place it — and any
 * gate written as a condition inside a builder would have had to be written
 * twice, correctly, forever. Withdrawn at the input, neither half has anything
 * to place and neither knows why.
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
  type PromptMode,
  toolPolicyUsesNonce,
} from '@ghostwire/protocol';
import { toolOutputPolicy, toolOutputTag } from '@ghostwire/security';

/**
 * The separator between top-level sections. Also joins the two halves.
 *
 * Re-exported rather than declared: it is defined beside the prompt template in
 * `@ghostwire/protocol`, because the config migration there has to reproduce this
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
  /** The channel the turn arrived on — `cli`, `web`, `telegram`, an extension id. */
  readonly channel: string;
}

export interface RuntimePromptContext extends StaticPromptContext {
  /** 1-based, and reset per turn. */
  readonly iteration: number;
  readonly maxIterations: number;
  /** Wall-clock epoch milliseconds, from the injected clock. */
  readonly nowMs: number;
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
  staticSection?(
    context: StaticPromptContext,
  ): Promise<string | undefined> | string | undefined;
  runtimeSection?(context: RuntimePromptContext): string | undefined;
}

/**
 * Who the turn is being run by.
 *
 * Every field comes from the resolved agent and is stable for the life of a
 * session, which is what lets them sit in the cached half of the prompt.
 *
 * The tool-shaped templates are deliberately **not** here — they are
 * `PromptTools`, a separate argument. An agent always has an identity; it does
 * not always have tools, and the sections that describe tools have to be
 * absent, not merely empty, on a turn that has none. Splitting them is what
 * lets a builder answer "is this section placed?" from its own inputs instead
 * of from a flag someone remembered to thread through.
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
  readonly tools: ReadonlyArray<{
    readonly name: string;
    readonly use: string;
  }>;
  /** Caveats about the box as a whole. */
  readonly notes: string;
}

/**
 * Everything the prompt says about tools — or, when absent, that it says none of
 * it.
 *
 * **Absence is the meaning.** A turn whose model is sent no tools passes no
 * `tools` at all, and the three sections that describe tools then have no inputs
 * to render from: the toolbox advertisement, the tool-output policy, and the
 * command policy that says where `exec` lands. None of them needs to be told
 * why. That is the whole reason this is a group rather than three optional
 * fields beside `agent`, and it is why there is no boolean anywhere below —
 * a builder that branched on "are tools on" would be a builder that has to be
 * told twice, once per half of the prompt the policy can land in.
 *
 * Each field is the *operator's wording* for its section and keeps the config's
 * three states: absent or empty inherits the built-in, a single space removes
 * the section, anything else replaces it. Those are decisions a person made
 * about a section that exists. Whether it exists at all is this object.
 *
 * Written `?: T | undefined` rather than `?: T`, against the repo's
 * `exactOptionalPropertyTypes`, for the reason `ChatRequest` is: the caller
 * assembles this by copying fields straight off a resolved agent, and with a
 * bare `?:` every one of them would need a spread to express "not set".
 */
export interface PromptTools {
  /**
   * The toolbox this agent works in, when it has one.
   *
   * The toolset advertisement, and it is *prose composed from a declared list*
   * rather than a set of tool schemas: a research or Kali image carries hundreds
   * of programs the model already knows from pretraining, and declaring them as
   * schemas would cost thousands of tokens every turn to say what forty say
   * here. It sits in the static half so a provider caches it once per session.
   *
   * Absent means this agent runs its commands on the host — which is a different
   * statement from the whole object being absent, and the command policy below
   * reads both.
   */
  readonly toolbox?: PromptToolbox | undefined;
  /** Wording for the toolbox advertisement. Only placed when `toolbox` is set. */
  readonly toolboxPrompt?: string | undefined;
  /** Wording for the tool-output policy — what the delimiters around a result mean. */
  readonly policyPrompt?: string | undefined;
  /** Wording for the command policy — where `exec` lands, and what is available there. */
  readonly platformPrompt?: string | undefined;
}

export interface BuildStaticPromptOptions {
  readonly context: StaticPromptContext;
  /** Absent is the unnamed default agent: the built-in template, rendered as `GhostAI`. */
  readonly agent?: PromptAgent;
  readonly contributors?: readonly ContextContributor[];
  /** Absent means this model is sent no tools, so no tool-shaped section is placed. */
  readonly tools?: PromptTools | undefined;
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
   * Absent means this model is sent no tools, so no tool-shaped section is
   * placed. Only `policyPrompt` is read here — and only when it names the
   * delimiter, which is what moves it out of the cached half and into this one.
   *
   * The same object the static half receives, rather than the one field this
   * half happens to use, because which half emits the policy is the operator's
   * decision and not this signature's. Passing them the same thing is what
   * makes "the two conditions are exact complements" checkable.
   */
  readonly tools?: PromptTools | undefined;
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
function renderToolbox(
  toolbox: PromptToolbox | undefined,
  template: string | undefined,
): string {
  if (toolbox === undefined || toolbox.name === '') return '';

  const stored = templateOr(template, DEFAULT_TOOLBOX_TEMPLATE);
  if (stored.trim() === '') return '';

  const toolList = toolbox.tools
    .map((tool) =>
      tool.use === ''
        ? `- \`${tool.name}\``
        : `- \`${tool.name}\` — ${tool.use}`,
    )
    .join('\n');
  const notes = toolbox.notes.trim();

  return renderPromptTemplate(stored, {
    name: toolbox.name,
    workdir: toolbox.workdir,
    // Each of these carries its own leading blank line, so a toolbox with no
    // notes leaves no gap where the paragraph would have been. See the
    // convention noted beside the templates in `@ghostwire/protocol`.
    tools: toolList === '' ? '' : `\n\nInstalled:\n${toolList}`,
    toolList,
    notes: notes === '' ? '' : `\n\n${notes}`,
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
 * Its own section in template mode, and `{{platformPolicy}}` in raw mode. It is
 * generated rather than written into the identity because it is the one part of
 * the static half that depends on *placement*. The same agent text has to be
 * true whether `exec` lands on the
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
  tools: PromptTools | undefined,
): string {
  // No tools, no commands, nothing to say about where they land. First, because
  // every line below describes running one — including the sentence about the
  // file tools, which are tools too.
  if (tools === undefined) return '';

  const { toolbox, platformPrompt: template } = tools;
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

  // Bare text, no leading break. It is a section now, and the separator between
  // sections is `buildStaticPrompt`'s to write — which is the whole reason it
  // stopped being a `{{platformPolicy}}` placeholder in the identity template.
  // A placeholder renders to a string and an empty one leaves the blank lines
  // the template wrote around it; a section that does not apply is simply not
  // in the list.
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
    if (section !== undefined && section.trim() !== '') {
      sections.push(section.trim());
    }
  }
  return sections;
}

/**
 * The identity section, rendered from whatever template this agent carries.
 *
 * The text itself lives in `@ghostwire/protocol`, not here, and an agent that
 * stores its own replaces it wholesale — heading, workspace rules, platform
 * note, guidelines and all.
 *
 * **That is a reversal of an earlier decision, and worth stating plainly.**
 * This function used to splice an operator's paragraph into a fixed block on
 * the grounds that the chroot semantics and the guidelines were "not an
 * operator's to replace by writing a persona". The objection does not survive
 * contact with what those sentences actually are: prose telling the model what
 * is true. The jail and the exec guard live in `@ghostwire/security`, are
 * enforced on every call, and have never read a word of this. An operator who
 * deletes the workspace paragraph gets an agent that is less well informed
 * about a sandbox that is exactly as tight as it was before — and in exchange,
 * the prompt an install actually runs on is one they can read and edit rather
 * than one compiled into the binary.
 *
 * The tool-output policy is a separate section for the same reason, and is
 * separately overridable — it explains a mechanism rather than being one, so
 * replacing the identity does not silently delete it.
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
  const template =
    stored.trim() === '' ? DEFAULT_SYSTEM_PROMPT_TEMPLATE : stored;

  return renderPromptTemplate(template, {
    name: label === '' ? 'GhostAI' : label,
    workspaceId,
    // Still supplied, and no longer used by the default template — see
    // `PROMPT_PLACEHOLDERS` for why handing a model the absolute root is worse
    // than withholding it. A custom prompt that asks for it still gets it.
    workspaceRoot,
    runtime: runtimeLabel,
  });
}

/**
 * The cache-stable half. Built once per turn; identical across the session.
 *
 * Contributor sections are appended in the order given, after the built-in
 * ones, so the prefix a provider caches grows at the end rather than shifting
 * when a contributor is added or removed mid-session.
 */
export async function buildStaticPrompt(
  options: BuildStaticPromptOptions,
): Promise<string> {
  const { platform, runtimeLabel } = resolveHost(options);

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

  // Ahead of the toolbox advertisement, which says "the container described
  // below" and means this one: the policy states where commands land, the
  // advertisement says what is in the box. Reversing them makes the second
  // sentence point backwards.
  const commands = commandPolicy(
    platform,
    runtimeLabel,
    options.context.workspaceId,
    options.tools,
  );
  if (commands !== '') sections.push(commands);

  // Before contributors, after the identity: it describes the environment every
  // later section is talking about, and a model told what it can run before it
  // is told what to do needs fewer turns to discover the difference.
  const toolbox = renderToolbox(
    options.tools?.toolbox,
    options.tools?.toolboxPrompt,
  );
  if (toolbox !== '') sections.push(toolbox);

  // The tool-output policy, when it names no delimiter — which the default does
  // not. It is the largest block in the prompt that never changes, so leaving it
  // in the per-iteration half meant re-sending two hundred tokens on every
  // request of every turn to say something the model had already been told.
  // `buildRuntimeBlock` places it instead when a custom template asks for the
  // tag, and the two conditions are exact complements, so it appears once.
  const policy = staticToolPolicy(options.tools);
  if (policy !== '') sections.push(policy);

  sections.push(
    ...(await contributorSections(options.contributors, options.context)),
  );

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
 *
 * Exported for `memory-contributor.ts`, which owns the seventh template and is
 * not one of the sections this file places. A seventh spelling of the rule is
 * how the seven come to disagree about what a space means.
 */
export function templateOr(
  stored: string | undefined,
  fallback: string,
): string {
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
function renderToolPolicy(
  template: string | undefined,
  nonce?: string,
): string {
  const stored = template ?? '';
  if (stored !== '' && stored.trim() === '') return '';
  return toolOutputPolicy(nonce, stored);
}

/**
 * The policy for `raw` mode's `{{toolPolicy}}`, delimiter included.
 *
 * Template mode splits the prose from the tag it refers to so the prose can be
 * cached; raw mode has one blob and nothing to gain from that, so the two are
 * rejoined here. A policy that names the tag itself already says it, and gets no
 * second line.
 */
function rawToolPolicy(template: string | undefined, nonce: string): string {
  const policy = renderToolPolicy(template, nonce);
  if (policy === '' || toolPolicyUsesNonce(template ?? '')) return policy;
  return `${policy}\n\nTool output delimiter: ${toolOutputTag(nonce)}`;
}

/**
 * Which half of the prompt this agent's tool-output policy belongs in.
 *
 * The default policy names no delimiter, so it is identical for the life of a
 * session and goes in the cached prefix. An operator who put `{{tag}}` back gets
 * the old placement — correct output, and the caching cost the editor warns
 * about — rather than a broken prompt or a config migration.
 */
function toolPolicyIsStatic(template: string | undefined): boolean {
  const stored = template ?? '';
  if (stored !== '' && stored.trim() === '') return false;
  return !toolPolicyUsesNonce(stored);
}

/**
 * The policy as the cached half should carry it — nothing, when it belongs to
 * the other half or when there are no tools to have output.
 *
 * A pair with `runtimeToolPolicy` below, and they are exact complements on the
 * `toolPolicyIsStatic` test, so between them the section appears once or not at
 * all. Written as two named functions rather than as a condition at each call
 * site because "not placed here" has three causes — no tools, a deleted
 * template, the other half owns it — and a reader should have to hold one name
 * rather than three.
 */
function staticToolPolicy(tools: PromptTools | undefined): string {
  if (tools === undefined || !toolPolicyIsStatic(tools.policyPrompt)) return '';
  return renderToolPolicy(tools.policyPrompt);
}

/** The policy as the per-iteration half should carry it. See `staticToolPolicy`. */
function runtimeToolPolicy(
  tools: PromptTools | undefined,
  nonce: string,
): string {
  if (tools === undefined || toolPolicyIsStatic(tools.policyPrompt)) return '';
  return renderToolPolicy(tools.policyPrompt, nonce);
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
 * The host as both builders describe it.
 *
 * Three lines, and they were written out in `buildStaticPrompt` and again in
 * `buildRawPrompt`. The default matters: a raw agent and a template agent on
 * the same machine must be told the same thing about it, and two copies of a
 * default is how that stops being true.
 */
function resolveHost(options: {
  readonly platform?: NodeJS.Platform;
  readonly runtimeLabel?: string;
}): { readonly platform: NodeJS.Platform; readonly runtimeLabel: string } {
  const platform = options.platform ?? hostPlatform;
  return {
    platform,
    runtimeLabel:
      options.runtimeLabel ??
      `${osLabel(platform)} ${arch}, Node ${versions.node}`,
  };
}

/**
 * The live-state values, which both halves of the prompt describe identically.
 *
 * `buildRuntimeBlock` renders them into the live-state template; `buildRawPrompt`
 * spreads them into the operator's one blob. Same values either way — the
 * iteration counter counted the same way, the wrap-up gated at the same point,
 * the clock read in the same zone — because a raw agent reading a different
 * "iterations left" than a template agent would be a difference nobody chose.
 */
function liveValues(
  context: RuntimePromptContext,
  options: {
    readonly timeZone?: string;
    readonly wrapUpPrompt?: string;
    readonly nonce: string;
  },
): LivePromptValues {
  const timeZone =
    options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  // Counted inclusively — on the last legal iteration one is left, not none —
  // because "1 left" is what a person and a model both read as "this is it".
  const left = context.maxIterations - context.iteration + 1;
  return {
    time: liveTime(context.nowMs, timeZone),
    // Only when it is about to matter. See `ITERATION_WARNING_AT`.
    wrapUp:
      context.maxIterations > 0 && left <= ITERATION_WARNING_AT
        ? renderWrapUp(
            templateOr(options.wrapUpPrompt, DEFAULT_WRAP_UP_TEMPLATE),
            left,
          )
        : '',
    iteration: String(context.iteration),
    maxIterations: String(context.maxIterations),
    iterationsLeft: String(Math.max(left, 0)),
    channel: context.channel,
    sessionKey: context.sessionKey,
    // The one part of the tool-output policy that changes. The prose that
    // explains what it means is in the cached half; this names the value it
    // refers to. See `DEFAULT_TOOL_POLICY_TEMPLATE`.
    tag: toolOutputTag(options.nonce),
  };
}

/** The contributors' per-iteration sections, trimmed and emptied out. */
function runtimeSectionsOf(
  contributors: readonly ContextContributor[] | undefined,
  context: RuntimePromptContext,
): string[] {
  const sections: string[] = [];
  for (const contributor of contributors ?? []) {
    const section = contributor.runtimeSection?.(context);
    if (section !== undefined && section.trim() !== '') {
      sections.push(section.trim());
    }
  }
  return sections;
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
  const values = liveValues(context, {
    ...(options.timeZone === undefined ? {} : { timeZone: options.timeZone }),
    ...(options.wrapUpPrompt === undefined
      ? {}
      : { wrapUpPrompt: options.wrapUpPrompt }),
    nonce: options.nonce,
  });

  const live = renderPromptTemplate(
    templateOr(options.livePrompt, DEFAULT_LIVE_STATE_TEMPLATE),
    values,
  ).trim();
  const sections = live === '' ? [] : [live];

  sections.push(...runtimeSectionsOf(options.contributors, context));

  // Only a policy that names the delimiter — the complement of the condition in
  // `buildStaticPrompt`, so exactly one of the two places emits it. A default
  // policy is prose about a mechanism and belongs in the cached half; one that
  // spells the tag out has to be rebuilt with the turn.
  const policy = runtimeToolPolicy(options.tools, options.nonce);
  if (policy !== '') sections.push(policy);

  // Last, so it is the final thing read before the model answers. A correction
  // buried above a few hundred tokens of policy is a correction competing with
  // them for attention, and it only exists for one iteration.
  if (options.correction !== undefined && options.correction.trim() !== '') {
    sections.push(options.correction.trim());
  }

  return sections.join('\n\n');
}

/** Marks the trailing turn as operator metadata rather than something a person typed. */
const REMINDER_TAG = 'system-reminder';

/** Matches an opening or closing reminder delimiter, either case. */
const REMINDER_DELIMITER = new RegExp(`<(/?)(${REMINDER_TAG})`, 'gi');

/**
 * The runtime half, wrapped so a *user* turn can carry it.
 *
 * The block has to travel after the conversation to keep the history inside the
 * cached prefix, and a trailing user message is the only shape every provider on
 * the OpenAI-compatible wire accepts — a second system message is rejected by
 * some and silently hoisted by others, and hoisting it would put the volatile
 * text back in front of the history, which is the exact cost this avoids.
 *
 * The envelope is what stops that being a lie about who is speaking. Without it
 * the model reads live state and a correction as the user's own words; with it
 * they are labelled, in the same shape `wrapToolOutput` uses two sections above.
 * A forged delimiter is escaped for the same reason it is there — a correction
 * or a contributor section is text this module did not write.
 */
export function runtimeReminder(block: string): string {
  const escaped = block.replace(
    REMINDER_DELIMITER,
    (match, slash: string, tag: string) => {
      return `<\\${slash}${tag}`;
    },
  );
  return `<${REMINDER_TAG}>\n${escaped}\n</${REMINDER_TAG}>`;
}

// ---------------------------------------------------------------------------
// Raw mode
// ---------------------------------------------------------------------------

export interface BuildRawPromptOptions {
  readonly context: RuntimePromptContext;
  readonly agent?: PromptAgent;
  /**
   * Absent means this model is sent no tools, so `{{toolbox}}`, `{{toolPolicy}}`
   * and `{{platformPolicy}}` render to nothing.
   *
   * Rendering to nothing rather than being dropped is the only answer raw mode
   * can give: the operator placed those placeholders, so the layout around them
   * is theirs and this is not free to remove a line they wrote.
   */
  readonly tools?: PromptTools | undefined;
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
  const { platform, runtimeLabel } = resolveHost(options);
  const live = liveValues(context, {
    ...(options.timeZone === undefined ? {} : { timeZone: options.timeZone }),
    ...(options.agent?.wrapUpPrompt === undefined
      ? {}
      : { wrapUpPrompt: options.agent.wrapUpPrompt }),
    nonce: options.nonce,
  });

  const label = options.agent?.label ?? '';
  const stored = options.agent?.systemPrompt ?? '';
  // Whitespace-only is empty here too, and it matters more than it does in
  // template mode: a raw agent whose template renders to nothing would be sent
  // no system message at all.
  const template =
    stored.trim() === '' ? DEFAULT_SYSTEM_PROMPT_TEMPLATE : stored;

  const toolbox = renderToolbox(
    options.tools?.toolbox,
    options.tools?.toolboxPrompt,
  );
  const runtimeSections = runtimeSectionsOf(options.contributors, context);
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
      options.tools,
    ),
    // The same values the live-state section carries in template mode, so a raw
    // agent and a template agent on one machine read the same clock and the
    // same iteration counter.
    ...live,
    // The section placeholders carry their own leading blank line, so one that
    // does not apply to this agent vanishes instead of leaving a gap. The policy
    // is the exception: it is usually placed on its own, where a leading break
    // would be the template's to write.
    toolbox: toolbox === '' ? '' : `${SECTION_SEPARATOR}${toolbox}`,
    // Self-contained, and with the nonce: raw mode is one blob placed by the
    // operator, so there is no cached half to keep a delimiter out of. In
    // template mode the policy's prose and the delimiter it refers to are split
    // across the two halves on purpose; here they would land in the same blob
    // anyway, and a `{{toolPolicy}}` that named no delimiter would quietly stop
    // saying what it used to — the placeholder means "the tool-output policy",
    // not "most of it".
    toolPolicy:
      options.tools === undefined
        ? ''
        : rawToolPolicy(options.tools.policyPrompt, options.nonce),
    nonce: options.nonce,
    contributors: statics === '' ? '' : `${SECTION_SEPARATOR}${statics}`,
    runtimeSections:
      runtimeSections.length === 0 ? '' : `\n\n${runtimeSections.join('\n\n')}`,
    correction: correction === '' ? '' : `\n\n${correction}`,
  });
}
