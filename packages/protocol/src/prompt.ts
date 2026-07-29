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
export function renderPromptTemplate(template: string, values: PromptValues): string {
  return template.replace(PLACEHOLDER, (match, name: string) =>
    KNOWN.has(name) ? values[name as PromptPlaceholder] : match,
  );
}

/**
 * The placeholder-shaped things in a template that nothing will fill.
 *
 * For the editor, which can warn about a typo at the moment it is made. Order
 * is first-appearance and each name is reported once, because a warning listing
 * `{{workspacRoot}}` four times is a worse version of the same sentence.
 */
export function unknownPlaceholders(template: string): readonly string[] {
  const seen = new Set<string>();
  for (const match of template.matchAll(PLACEHOLDER)) {
    const name = match[1] ?? '';
    if (!KNOWN.has(name)) seen.add(name);
  }
  return [...seen];
}

/** Whether a stored value names any placeholder — i.e. has been through the migration. */
export function hasPlaceholder(template: string): boolean {
  for (const match of template.matchAll(PLACEHOLDER)) {
    if (KNOWN.has(match[1] ?? '')) return true;
  }
  return false;
}

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

## Runtime

{{runtime}}

## Workspace

You are working in the \`{{workspaceId}}\` workspace, at {{workspaceRoot}}.

That directory is your root. \`/notes/todo.md\`, \`notes/todo.md\` and
\`../notes/todo.md\` all name the same file inside it, and no path you can write
reaches outside it — paths are resolved into the workspace, not rejected. Prefer
the plain relative form: say \`notes/todo.md\`.

\`exec\` is the exception, and the difference matters. The program you run is a
real process on the real filesystem, so it is *not* confined to the workspace —
which is why an argument pointing outside it (\`/etc/passwd\`, \`../secrets\`)
is refused there rather than resolved inside. Pass workspace-relative arguments
to \`exec\`; its working directory is already the root.

{{platformPolicy}}

${GUIDELINES}`;

/**
 * An old `systemPrompt` — which meant "append this as `## Instructions`" — as a
 * template that means the same thing.
 *
 * The result is byte-identical to what the old composer produced for that
 * install, which is the whole requirement: a migration that changes what an
 * agent says is a migration that changes how it behaves, discovered later and
 * blamed on something else.
 */
export function legacyInstructionsToTemplate(instructions: string): string {
  return `${DEFAULT_SYSTEM_PROMPT_TEMPLATE}${SECTION_SEPARATOR}## Instructions\n\n${instructions.trim()}`;
}
