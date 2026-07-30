/**
 * The system prompt an agent carries, as a template.
 *
 * An agent's `systemPrompt` used to be a paragraph appended below a hardcoded
 * identity block as an `## Instructions` section. It is now the **whole** static
 * prompt: the heading, the workspace rules, the platform note and the
 * guidelines are all text the operator can read and rewrite. An agent that says
 * nothing about itself is not much of an agent, and neither is one whose actual
 * instructions are invisible in the UI that claims to configure it.
 *
 * It is stored as a *template* rather than as finished prose because the same
 * agent runs in different workspaces and on different machines. The workspace
 * id and root, the host platform and the Node version are known when a turn
 * starts, not when the operator presses Save, so the five values that vary are
 * holes the renderer fills.
 *
 * This lives in `@ghostai/protocol` because three packages that share nothing
 * else need the identical text: `@ghostai/agent` renders it, `@ghostai/core`
 * prepends it when migrating an old config, and `@ghostai/web` shows it in the
 * editor. Core cannot import agent — the dependency runs the other way — and
 * the browser depends on this package and no other. A second copy of the text
 * in any of them is a copy that goes stale.
 *
 * **Empty means the built-in.** A stored prompt of `''` renders
 * `DEFAULT_SYSTEM_PROMPT_TEMPLATE`, so an install that never customised one
 * keeps receiving improvements to it on upgrade. Materialising the default into
 * every config at write time would freeze every agent on the wording that
 * happened to ship the day it was created.
 *
 * What is *not* here, and is not the operator's to edit: the tool-output policy
 * in the runtime half of the prompt. It carries a per-turn nonce and is the
 * prompt-injection defence rather than prose — see `toolOutputPolicy` in
 * `@ghostai/security`. Nor does removing the workspace paragraph widen the
 * sandbox: the jail and the exec guard are enforced in code and never read the
 * prompt. Deleting that text changes what the agent *knows*, not what it *can
 * do*.
 */

/** The separator between top-level sections of the assembled prompt. */
export const SECTION_SEPARATOR = '\n\n---\n\n';

/**
 * The five values a prompt template may ask for.
 *
 * Deliberately short, and deliberately without a `{{date}}` or an
 * `{{iteration}}`. The static half of the prompt is the provider's cached
 * prefix: a value in it that changes between requests ends the discount for
 * everything after it, and a per-turn placeholder here would quietly cost a
 * tool-using session ten times the tokens it should. Live state belongs in the
 * runtime block, which is rewritten every iteration and sits at the end.
 *
 * **`workspaceRoot` and `runtime` are available and the default template no
 * longer uses either.** Both are host facts, and a model that is handed one tends
 * to use it:
 *
 *  - The absolute root is the path the file tools *hide*. Given it, a model will
 *    write `/Users/you/project/notes/todo.md`, which the jail resolves *inside*
 *    the workspace — it lands on `<root>/Users/you/project/notes/todo.md`, a real
 *    directory tree of junk, with no error. The path is also the one thing in the
 *    prompt that leaks the operator's home directory layout to the provider.
 *  - `runtime` names the host OS, which is where `exec` runs only when the agent
 *    has no toolbox. For a toolboxed agent it describes a machine none of its
 *    commands touch, and `{{platformPolicy}}` now states the correct one.
 *
 * They stay in this list because a custom prompt may reasonably want them — an
 * agent whose job is to talk about the host, say — and removing a placeholder
 * silently changes every stored template that uses it.
 */
export const PROMPT_PLACEHOLDERS = [
  'name',
  'workspaceId',
  'workspaceRoot',
  'runtime',
  'platformPolicy',
] as const;

export type PromptPlaceholder = (typeof PROMPT_PLACEHOLDERS)[number];

export type PromptValues = Readonly<Record<PromptPlaceholder, string>>;

/**
 * `{{name}}`, with no inner whitespace.
 *
 * The strictness is the escape hatch: **`{{ name }}` — with spaces — is a
 * literal** and passes through untouched. That is one sentence to document and
 * one character class to implement, where a doubling rule (`{{{{`) is neither.
 */
const PLACEHOLDER = /\{\{([A-Za-z][A-Za-z0-9]*)\}\}/g;

const KNOWN: ReadonlySet<string> = new Set(PROMPT_PLACEHOLDERS);

/**
 * The template with its holes filled.
 *
 * Two guarantees, both chosen for what they do to a prompt that is subtly
 * wrong rather than to one that is right:
 *
 *  - **It never throws.** A prompt that fails to build fails every turn on that
 *    agent, and an operator's typo is not a reason to take the agent offline.
 *  - **An unknown placeholder is left verbatim.** `{{workspacRoot}}` renders as
 *    itself rather than as an empty string, so a typo is visible in the prompt
 *    instead of silently deleting the line that was supposed to say where the
 *    workspace is. The editor calls `unknownPlaceholders` and warns before the
 *    save; this is the backstop for everything that gets in another way.
 *
 * Substitution is a single pass and inserted values are never rescanned, so a
 * workspace named `{{workspaceRoot}}` cannot expand into anything.
 */
export function renderPromptTemplate(
  template: string,
  values: Readonly<Record<string, string>>,
): string {
  return template.replace(PLACEHOLDER, (match, name: string) =>
    Object.hasOwn(values, name) ? (values[name] ?? match) : match,
  );
}

/**
 * The placeholder-shaped things in a template that nothing will fill.
 *
 * For the editor, which can warn about a typo at the moment it is made. Order
 * is first-appearance and each name is reported once, because a warning listing
 * `{{workspacRoot}}` four times is a worse version of the same sentence.
 */
export function unknownPlaceholders(
  template: string,
  known: readonly string[] = PROMPT_PLACEHOLDERS,
): readonly string[] {
  // Defaulted rather than always the static set, because there are two templates
  // now and each has its own vocabulary — `{{time}}` is a typo in the identity
  // half and correct in the live one. An editor that warned from one list would
  // be wrong about whichever template it was not looking at.
  const vocabulary = known === PROMPT_PLACEHOLDERS ? KNOWN : new Set<string>(known);
  const seen = new Set<string>();
  for (const match of template.matchAll(PLACEHOLDER)) {
    const name = match[1] ?? '';
    if (!vocabulary.has(name)) seen.add(name);
  }
  return [...seen];
}

/**
 * What a *live state* template may ask for.
 *
 * A second vocabulary rather than an extension of the first, because the two
 * halves of the prompt are cached differently and that is the whole reason they
 * are separate files' worth of thought. Anything here changes between requests,
 * so it may only appear in the half that is rebuilt every iteration; anything in
 * `PROMPT_PLACEHOLDERS` is stable for the session and belongs in the cached half.
 *
 * `channel` and `sessionKey` are here and the default template deliberately does
 * not use them — see `DEFAULT_LIVE_STATE_TEMPLATE`. They are offered because an
 * operator who disagrees with that judgement should be able to put them back
 * without patching the source.
 */
export const LIVE_PROMPT_PLACEHOLDERS = [
  'time',
  'wrapUp',
  'iteration',
  'maxIterations',
  'iterationsLeft',
  'channel',
  'sessionKey',
] as const;

export type LivePromptPlaceholder = (typeof LIVE_PROMPT_PLACEHOLDERS)[number];

export type LivePromptValues = Readonly<Record<LivePromptPlaceholder, string>>;

/**
 * The per-iteration half's opening section, as a template.
 *
 * Editable for the same reason the identity half is: an operator owns what their
 * agent is told. This one is smaller and its economics are the opposite — it is
 * **never cached**, so every line is re-sent on every request of every turn, and
 * a tool-using turn is ten requests.
 *
 * That is why the default is one line. It used to be four:
 *
 * ```
 * Current time: 2026-07-30T13:05:40.935Z (host time zone: Europe/London)
 * Channel: web
 * Session: web-a4968997-5d6a-4e0b-9cd1-e5ea3f39340d
 * Agent iteration: 1 / 40
 * ```
 *
 * Nothing in the prompt said what the last three meant, and nothing read them.
 * The session key is a UUID the model cannot use and may echo at the user; the
 * channel named a difference no instruction drew a consequence from; the counter
 * is only actionable near the cap, which is what `{{wrapUp}}` is for. The time is
 * the one line that earns its place — a model has no clock, and without it
 * "today" and "latest" are answered from a training cutoff.
 *
 * `{{wrapUp}}` renders empty except in the last few iterations of a turn.
 */
export const DEFAULT_LIVE_STATE_TEMPLATE = `## Live state

Current time: {{time}}{{wrapUp}}`;

/**
 * What fills `{{wrapUp}}` when a turn is nearly out of iterations.
 *
 * Separate from the section above because it is *conditional*, and a placeholder
 * template cannot express a condition. The loop supplies it only when it applies,
 * so an operator editing this is editing a sentence that appears three times per
 * turn at most rather than one that appears on every request.
 *
 * Phrased to be plural-safe — "iterations left: 1" rather than "1 iterations
 * left" — because the alternative is a plural rule in a string an operator is
 * meant to be able to rewrite in their own words.
 */
export const DEFAULT_WRAP_UP_TEMPLATE = `

Tool iterations left in this turn: {{iterationsLeft}}. Wrap up — answer with what you have, or say plainly what is still missing.`;

const GUIDELINES = `## Guidelines

- State what you are about to do before calling a tool, but never describe a result you have not received yet.
- Read a file before you modify it. Do not assume a file or directory exists.
- After writing or editing a file, read it back when accuracy matters.
- When a tool call fails, work out why from the error before trying a different approach.
- Ask when a request is ambiguous rather than guessing which reading was meant.
- Answer in the conversation. Tools are for acting on the world, not for talking.`;

/**
 * What an agent says about itself when nobody has told it to say anything else.
 *
 * This is the text that used to be built by `identity()` in `@ghostai/agent`,
 * with the five varying values turned into placeholders. It is the seed every
 * customised prompt starts from, so the wording matters more than it did when
 * it was unreachable: an operator's first edit is a diff against this.
 */
export const DEFAULT_SYSTEM_PROMPT_TEMPLATE = `# {{name}}

You are {{name}}, a self-hosted agent running on your user's own machine, with
their files and their shell. You work on their behalf and answer to them alone.

## Workspace

You are working in the \`{{workspaceId}}\` workspace. To the file tools it is the
whole filesystem: \`/notes/todo.md\`, \`notes/todo.md\` and \`../notes/todo.md\`
all name the same file in it, and no path you can write reaches outside it.
Prefer the plain relative form — say \`notes/todo.md\`.

{{platformPolicy}}

${GUIDELINES}`;
