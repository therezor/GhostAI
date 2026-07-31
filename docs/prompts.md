# Prompts

An agent's whole system prompt is text you own. Not a persona appended below a hidden
preamble — the heading, the workspace rules, the platform note and the guidelines are all
editable, from the UI or from `config.json`.

That is a reversal of an earlier design, and worth stating plainly. The workspace and
guideline paragraphs used to be fixed on the grounds that they were not an operator's to
replace. The objection does not survive contact with what those sentences are: prose
telling the model what is true. The jail and the exec guard are enforced in code and have
never read a word of the prompt. **Deleting the workspace paragraph changes what the agent
_knows_, not what it _can do_.**

## Two halves, and why

A provider's prompt cache keys on an exact prefix: the longest run of leading tokens
identical to the previous request is discounted, and the first differing token ends the
discount for everything after it. A single prompt carrying the current time therefore
costs full price on every iteration of every turn — and a tool-using turn is five or ten
requests over the same history.

So the prompt is assembled from two pieces:

| Half        | Rebuilt                                            | Contains                                                                            |
| ----------- | -------------------------------------------------- | ----------------------------------------------------------------------------------- |
| **Static**  | Once per turn, identical for the life of a session | Identity, workspace rules, the platform note, guidelines, the toolbox advertisement |
| **Runtime** | Every iteration                                    | Live state, the tool-output policy with this turn's nonce, one-off corrections      |

They are joined by `\n\n---\n\n`, and the runtime half sits at the **end**, so what it
invalidates is only itself. The loop rewrites `messages[0]` each iteration rather than
appending a second system message — two system messages is a shape some providers reject
and others quietly reorder, and the ordering is what the cache depends on.

Anything that changes between requests must go in the runtime half. A timestamp, a
counter or a nonce placed in the static half invalidates the session's cached prefix on
every single turn, which is exactly the cost this split exists to avoid.

## The three templates

All three live on the agent, in `config.json`, and all three are edited in the agent
editor.

| Config key                      | Fills                      | Default constant                 |
| ------------------------------- | -------------------------- | -------------------------------- |
| `agents.list.<id>.systemPrompt` | The whole static half      | `DEFAULT_SYSTEM_PROMPT_TEMPLATE` |
| `agents.list.<id>.livePrompt`   | The live-state section     | `DEFAULT_LIVE_STATE_TEMPLATE`    |
| `agents.list.<id>.wrapUpPrompt` | The out-of-iterations line | `DEFAULT_WRAP_UP_TEMPLATE`       |

### Empty means "use the built-in"

A stored prompt of `''` renders the default, so an install that never customised one keeps
receiving improvements to it on upgrade. Materialising the default into every config at
write time would freeze every agent on the wording that happened to ship the day it was
created.

**Whitespace is where the two kinds differ**, and the asymmetry is deliberate:

- `systemPrompt` treats whitespace-only as empty. A template of three newlines is not a
  decision anyone made, and an identity-less agent is never what was meant.
- `livePrompt` and `wrapUpPrompt` do not. **Set either to a single space to delete the
  section entirely** — since empty already means "inherit", a space is the only way to say
  "I want this gone".

## Placeholders

`{{name}}`, exactly, with no inner whitespace. **`{{ name }}` — with spaces — is a
literal** and passes through untouched, which is the escape hatch: one sentence to
document, one character class to implement, where a doubling rule would be neither.

Two vocabularies, because the two halves are cached differently and a value in the wrong
one is either useless or expensive.

### Static half — `systemPrompt`

| Placeholder          | Is                                                                       |
| -------------------- | ------------------------------------------------------------------------ |
| `{{name}}`           | The agent's label, or `GhostAI`.                                         |
| `{{workspaceId}}`    | Which workspace the session is bound to.                                 |
| `{{platformPolicy}}` | A generated section saying where commands run — see below.               |
| `{{workspaceRoot}}`  | The absolute workspace path. Available, and **unused by the default**.   |
| `{{runtime}}`        | `<os> <arch>, Node <version>`. Available, and **unused by the default**. |

The last two are offered but not used, and it is worth knowing why before putting them
back:

- **The absolute root is the path the file tools hide.** Given it, a model writes
  `/Users/you/project/notes/todo.md`, which the jail resolves _inside_ the workspace — it
  lands at `<root>/Users/you/project/notes/todo.md`, a real tree of junk, with no error.
  It is also the one thing in the prompt that leaks your home directory layout to the
  provider.
- **`runtime` names the host OS**, which is where `exec` runs only when the agent has no
  toolbox. For a toolboxed agent it describes a machine none of its commands touch.

They remain in the vocabulary because a custom prompt may reasonably want them, and
removing a placeholder would silently change every stored template that uses it.

### Runtime half — `livePrompt`

| Placeholder                                                | Is                                                                       |
| ---------------------------------------------------------- | ------------------------------------------------------------------------ |
| `{{time}}`                                                 | Local reading with weekday and zone, plus the ISO instant.               |
| `{{wrapUp}}`                                               | The rendered wrap-up sentence — empty except in the last few iterations. |
| `{{iteration}}`, `{{maxIterations}}`, `{{iterationsLeft}}` | Counters.                                                                |
| `{{channel}}`, `{{sessionKey}}`                            | Available, and **unused by the default**.                                |

`{{iterationsLeft}}` is also the one placeholder `wrapUpPrompt` may use.

### The default live-state block is one line

```
## Live state

Current time: {{time}}{{wrapUp}}
```

It used to be four, and the other three were removed on cost grounds. This half is never
cached, so every line is re-sent on every request of every turn:

- **The session key** is a UUID — twenty tokens of random string per request, for an
  identifier the model cannot use and might echo at the user.
- **The channel** named a difference no instruction drew a consequence from.
- **The iteration counter** is only actionable near the cap. It now prints only in the
  last three iterations, which is what `{{wrapUp}}` is for.

The time is the one line that earns its place: a model has no clock, and without it
"today" and "latest" are answered from a training cutoff.

## Typos are visible, not silent

`renderPromptTemplate` never throws — a prompt that fails to build fails every turn on
that agent, and an operator's typo is not a reason to take the agent offline.

An **unknown placeholder is left verbatim**. `{{workspacRoot}}` renders as itself rather
than as an empty string, so the mistake is visible in the prompt instead of quietly
deleting the line that was supposed to say where the workspace is. The editor also warns
before the save; this is the backstop for everything that gets in another way.

Substitution is a single pass and inserted values are never rescanned, so a workspace
named `{{workspaceRoot}}` cannot expand into anything.

## `{{platformPolicy}}` is generated

This is the one part of the static half that depends on _placement_, so it is composed in
code rather than written into the template. The same agent text has to be true whether
`exec` lands on the host or in a container, and those two are opposite on every point that
matters: whether the workspace confines the command, whether a shell is available, and
which OS's tools exist.

Getting it wrong is not cosmetic. The host wording used to be emitted for every agent, so
a toolboxed one was told its commands ran on macOS when they run in Alpine, that they were
_not_ confined to the workspace when only the workspace is mounted, and on Windows that
GNU tools might be missing when the container has them. A model resolving a contradiction
between its prompt and its tools tends to resolve it by refusing.

The sentence that earns its tokens either way: **the file tools are
placement-independent.** They always act on the workspace on this machine, through the
jail, whatever `exec` does. Without that, a model has no way to know that the file it
wrote and the file a command sees are the same file under two names.

## What you cannot edit

**The tool-output policy.** It carries the turn's nonce and is the prompt-injection
defence rather than prose — see [Security](security.md). It lives in the runtime half
precisely because the nonce is regenerated every turn; in the static half it would
invalidate the session's cached prefix on every turn.

## Toolbox advertisement

When an agent has a toolbox, the static half gains a section describing it — and this is
**prose composed from a declared list**, not a set of tool schemas.

A research or Kali image carries hundreds of programs a model already knows from
pretraining. Declaring them as schemas would cost thousands of tokens on every request to
say what forty say once. The rules true of _every_ toolbox — that `exec` lands in a
container, that a shell is available there, that only the workspace is mounted, where
oversized output goes — are written in code where they cannot drift; the manifest declares
only what is specific to it.

A toolbox's `TOOLS.md`, when it has one, is included verbatim under its own heading, in
the static half, bounded at 12 KB. It used to live only inside the image, reachable by a
`tools` command — and a model that never ran it answered research questions from search
snippets while the reference explaining how to read pages sat one command away.
Discoverable is not the same as read.

## Extending the prompt in code

`ContextContributor` is the seam for content the loop knows nothing about:

```ts
interface ContextContributor {
  readonly name: string;
  staticSection?(ctx: StaticPromptContext): Promise<string | undefined> | string | undefined;
  runtimeSection?(ctx: RuntimePromptContext): string | undefined;
}
```

The two halves carry different obligations and are not interchangeable. `staticSection` is
called once per turn, may do I/O, and **must be stable across the session** — a section
that changes wherever it likes hands back the cache benefit the split was built for.
`runtimeSection` is called on every iteration and is synchronous, so anything expensive
there is paid five or ten times per turn.

Contributor sections are appended after the built-in ones, in the order given, so the
cached prefix grows at the end rather than shifting when a contributor is added.

This is how memory, skills and RAG will inject content when they land.
