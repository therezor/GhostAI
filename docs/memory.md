# Memory

An agent's memory is a folder of markdown files in the workspace — one file per fact,
under `memory/` — indexed by a generated `MEMORY.md`. The index goes into every prompt on
that folder; the facts themselves stay on disk until the model opens one with `read_file`.
The agent writes them with the `memory` tool, a person edits them with an editor. There is
no database, no embedding and nothing to migrate: a memory you can read is one you can
correct.

> **On an existing install, nothing is remembered until you grant the tool.**
> `DEFAULT_AGENT_TOOLS` seeds a _newly created_ agent, so an install that predates this
> feature has no `memory` key in its permission map — and an absent tool is a denied one.
> Grant it in Settings → Agents, or run `/memory on`. This applies to `skill` too.

## What changed, and why

This replaces a single `memory/memory.md` that was inlined **whole** into every prompt,
with dated `## Session` headings the agent appended to. Two things were wrong with it,
and both are properties of the shape rather than of the code:

- **One file is one blob.** Everything ever learned was re-sent on every request of every
  turn, whether or not a word of it bore on the question, and the only lever was a token
  cap that decided what to forget by _age_.
- **Nothing could be corrected.** Appending never rewrites, so a fact that changed could
  only be recorded a second time — leaving two contradictory lines with nothing to say
  which was current. The failure mode of a wrong memory is every future turn on that
  folder.

`memory-contributor.ts` used to argue the opposite of what it now does, and the argument
deserves an answer rather than a quiet deletion:

> a workspace has many skills and needs at most one per turn, so an index earns its keep.
> It has exactly one memory, and memory the model has to decide to go and read is memory
> it will forget to consult.

That was not wrong; it was priced for a different object. A single summary is worth
inlining. A _store_ is not — and a workspace no longer has exactly one memory, so the
premise the argument rested on is gone.

**An existing `memory/memory.md` is left on disk and is no longer read.** It is not
migrated. `readMemories` skips it deliberately and silently, so it costs nothing and warns
about nothing. On a case-insensitive filesystem — macOS, Windows — that file _is_ the path
`MEMORY.md` resolves to, so the first save renames it to `memory.md.replaced` rather than
writing the generated index over it.

## The switch is the tool

There is no `memoryEnabled` config key, deliberately. A tool already carries `allow`,
`ask` or `deny` per agent, already appears in the settings UI, and already lives in
`config.json` — which is exactly "this capability is on, off, or gated". A boolean beside
it would be a second way to say the same thing, and two switches for one thing is how
they come to disagree.

**There is a switch on the screen, and it writes that permission.** The agent editor's
_Memory and skills_ section carries `Remember across sessions` and `Use the workspace's
skills`, and each one sets `tools.memory` / `tools.skill` to `allow` or `deny`. It is the
same value the Tools table below shows, and the row moves when the switch does. What the
switch buys is that the row does not read as a feature: `memory` sits in an alphabetical
list beside `read_file` and `exec`, where turning it off looks like denying one call
rather than switching off the whole capability.

Denying `memory` removes the prompt section as well as the tool — that gating is in
`runtime.ts`, and it is what makes one switch enough. An agent that cannot write its
memory should not still be paying to be told what it knows.

**`toolsEnabled: false` removes it too**, and that is the broader condition. Off, the
request advertises no tool list at all, so nothing can open a memory — the index is a list
of paths the model cannot pass to `read_file`, and the prose telling it to is false. The
agent editor says so on the Memory box, and names _that_ reason rather than the
permission, because an operator told the narrower one would go and flip the wrong switch.

| You want                            | Do this                                      |
| ----------------------------------- | -------------------------------------------- |
| This agent to stop remembering      | The switch, `/memory off`, or `memory: deny` |
| To approve each thing it records    | Set `memory` to `ask` — the section stays    |
| The section gone, but the tool kept | `memoryPrompt: " "` — a single space         |

**Off means off, in both directions.** There is no way to keep the index in the prompt
while denying the write, and no way to record while paying nothing — `memoryMaxPromptTokens: 0`
used to be the second of those and is gone. Both are coherent things to want; neither was
worth a second key that could disagree with the first.

`/memory off` changes the **agent**, not the session: every conversation on that agent is
affected, which is the same thing ticking the box in Settings does.

## The files

```
<workspace>/
└── memory/
    ├── MEMORY.md                  ← generated
    ├── run-full-ci-gate.md
    └── ui-stack-preferences.md
```

```markdown
---
name: ui-stack-preferences
description: no shadcn/ui; Tailwind in rem, not px
metadata:
  type: user
---

The user wants an explicit design token layer. See [[design-token-gates]].
```

**The slug is the identity.** It is the filename, the `name` in the frontmatter, and what
a `[[link]]` in another memory refers to. Saving under a name that already exists
_replaces_ that memory, which is the whole of how a wrong one gets corrected rather than
contradicted by a second one beside it.

`metadata.type` is one of four, and it does two jobs. Writing one makes the model decide
what kind of thing it has learned — a note that is none of the four usually belongs in the
conversation rather than on disk. Reading one back says how much weight the note carries.

| Type        | Is                                                             |
| ----------- | -------------------------------------------------------------- |
| `user`      | Who the person is: role, expertise, standing preferences.      |
| `feedback`  | How they have asked to be worked with, and why.                |
| `project`   | An ongoing goal or constraint the code does not state.         |
| `reference` | A pointer to something outside the workspace: a URL, a ticket. |

A memory with no `description` is skipped with a warning — an index line reading
`**ci-gate**: ` teaches the model the memory is about nothing. A missing or unrecognised
type is read as `project` rather than refused, because losing a fact over a label is the
worse trade.

**The frontmatter parser is not a YAML parser and must not become one.** It handles one
level of nesting, flattened to a dotted key: `metadata:` / `  type: user` arrives as
`fields['metadata.type']`. That is exactly what this format needs and nothing more. See
the header of `packages/core/src/frontmatter.ts` for the hazard that rule closes.

### `MEMORY.md` is generated, and nothing reads it back

It is regenerated from the folder on every save, and the prompt's index is built by
scanning the folder rather than by reading this file. That asymmetry is the point:

- A memory deleted by hand leaves the prompt on the **next turn**, whatever the index
  still says. There is nothing to resynchronise.
- A folder authored by hand with no `MEMORY.md` still reaches the prompt in full.
- It cannot make the prompt wrong, which is what lets it be a generated file whose
  hand-edits are lost without that being a data-loss bug.

It exists because a folder a person opens should describe itself, and because it renders
as a working set of links in an editor or on GitHub.

## What reaches the prompt

```
## Memory

What you have learned about this workspace, kept as one file per fact under
`memory`. Each line below is one memory — the file to open, its name, and
what it is about. The bodies are not here: open one with `read_file` when its
line bears on what you are doing.

To record something durable, call the `memory` tool with a short name, a
one-line description, a type and the fact itself. Writing a name that already
exists replaces it, so something you got wrong is corrected rather than left
standing beside its correction.

- `memory/run-full-ci-gate.md` (feedback) — pnpm check misses format:check
- `memory/ui-stack-preferences.md` (user) — no shadcn/ui; Tailwind in rem, not px
```

**Every word of that is editable** — it is `agents.list.<id>.memoryPrompt`, the seventh
prompt template, and it follows the contract the other six keep: empty inherits the
built-in, a single space deletes the section, anything else is this agent's own. See
[Prompts](prompts.md).

| Placeholder | Is                                                                  |
| ----------- | ------------------------------------------------------------------- |
| `{{index}}` | The generated lines. **The section's content.**                     |
| `{{path}}`  | `memory` — the folder, workspace-relative and POSIX.                |
| `{{count}}` | How many lines the index carries. Available, unused by the default. |

The index line leads with the **path**, because that string goes straight back to
`read_file` and a prefix the model has to reconstruct is one it can reconstruct wrongly.
`MEMORY.md` writes the same memories as _relative_ links instead, because it sits inside
`memory/` and is read by a person. One `Memory[]`, two renderers, each correct for its
reader.

It lands in the **static** half of the prompt — the provider's cached prefix — and is
placed _after_ skills. Sections are appended in order so the cached prefix grows at the
end, and memory is the section a turn can rewrite, so it sits where a change invalidates
the least. See [Prompts](prompts.md).

Over budget, whole lines are dropped from the tail and a note says how many. Whole lines,
because an index line missing its second half names a file the model cannot open — worse
than a memory it was never told about. The index is alphabetical, so there is no "newest"
to keep; that is the one rule the old head-cut had and this does not need.

## How it gets written

The `memory` tool takes four fields and **no path**: a `name`, a one-line `description`,
a `type` and the `body`. Deriving the folder from the jail root is the whole reason it is
not a worse `write_file`.

A name is not a path, but it does reach a filename — so the guarantee that used to be free
is restored in `memorySlug`. The result is `[a-z0-9-]` and nothing else, so it cannot
contain a separator or a `..` and cannot leave `memory/` by construction rather than by a
check somebody could forget to call. It **slugs rather than refuses**: `UI Stack
Preferences` becomes `ui-stack-preferences`, and the result says which name was used.

A change lands in the **next** turn's prompt, not this one: the static half is built once
per turn.

Nothing stops a person — or the model, through `write_file` — editing these by hand. That
is intended; see the placement section below.

## The commands

`/memory` exists in the terminal REPL and in Telegram. It is **not** in the browser
composer yet: slash commands there are still on [the roadmap](ROADMAP.md).

| Command                     | Does                                                                 |
| --------------------------- | -------------------------------------------------------------------- |
| `/memory`                   | Whether the tool is granted, how many memories, what the index costs |
| `/memory on`, `/memory off` | Grants or denies the `memory` tool on this agent                     |

There is no `/memory edit`: `read_file` and `write_file` already open these, and a command
whose whole job is to hand a path to an editor is what [Tools](tools.md) argues against.

**`/memory compress` is gone**, and with it `consolidation.ts`, `consolidator.ts`,
`memoryCompactThresholdTokens` and `consolidationModel`. It folded the oldest messages of
a long session into a dated heading in the one accumulating file. There is no such file,
and a summary of a conversation is not a fact about a workspace — the two were only ever
in the same place because the same file held both.

`AgentDefaultsSchema` is a plain `z.object`, so it strips what it does not know: a
`config.json` carrying either dead key parses without error and loses it on the next
write. There is no migration.

**`last_consolidated_seq` remains** in the sessions table and is still honoured by history
windowing, fork and truncate — but nothing advances it any more. It is a floor at zero
until something else needs one.

## The bounds

**None of these is configurable, and there is no token budget.**

| Cap                            | Value | What it bounds                  |
| ------------------------------ | ----- | ------------------------------- |
| `MAX_MEMORIES`                 | 200   | How many are advertised at all. |
| `MAX_MEMORY_DESCRIPTION_CHARS` | 200   | How long one index line runs.   |
| `MEMORY_MAX_BYTES`             | 12 KB | How much of one file is read.   |
| `MAX_MEMORY_NAME_CHARS`        | 64    | How long a slug may be.         |

`memoryMaxPromptTokens` used to sit above these and was removed. It never bound: an index
line is roughly fifteen tokens, so its default of 2000 afforded well over a hundred lines
while `MAX_MEMORIES` stopped at 200 — a knob whose value never decides anything reads as a
lever and is not one. Its second job, `0` meaning "on disk, out of the prompt", belonged
to the permission and is now the switch.

The ceiling that remains is the product of the first two: 200 lines of at most ~200
characters is roughly 12k tokens in the static half if a workspace really fills the
folder. That is the cost of a very large memory store, and it is paid once per turn in
the cached prefix rather than per request.

`MEMORY_MAX_BYTES` is the same figure as `SKILL_MAX_BYTES` and the argument transfers: it
is what a `read_file` on one of these costs when the model opens it. It was 256 KB when
the file was inlined and compaction needed something oversized to compact.

See [Configuration](configuration.md).

## Where this lives, and what it costs

In the workspace, which is inside the jail, which means `write_file` and `exec` can both
edit these files.

`packages/core/src/paths.ts` puts an agent's own directory _beside_ the workspace for
exactly this reason, and says why: the jail root _is_ the workspace, so memory kept inside
it is writable by the agent, and that turns prompt injection into a way of rewriting the
agent's own system prompt. **That argument is correct, and the files were put here
anyway.**

What buys it: memory committed beside the project it describes, visible in a directory
listing, diffable in review, and correctable with an editor. A memory an operator cannot
see is one they cannot fix, and the failure mode of a wrong memory is every future turn on
that folder.

What follows from the placement, in code:

- **The `memory` tool is the intended path, not an enforced one.** `write_file` can still
  replace any of these files wholesale.
- **Every write is atomic.** A temp file beside the target, then a rename, so a crash
  cannot leave half a memory for the next turn to index.
- **Saves are serialised per workspace.** A save is a read-modify-write of the _folder_ —
  the file, then the index regenerated from everything in it — so two landing together
  would each write an index that did not know about the other's file.
- **Reads are bounded** at 12 KB per file and 200 files, so a folder someone filled costs
  a prompt section and not the process.

If you want the injection-proof arrangement, set `write_file` to `ask` or `deny`.

## What is not built yet

- **No delete operation.** A superseded memory is corrected by writing the same name; one
  that should not exist at all is a file, and `exec` reaches it. Because the prompt index
  is scanned from the folder rather than read from `MEMORY.md`, removing a file by hand
  takes effect on the very next turn with nothing to resynchronise.
- **No ranking.** The index is alphabetical, which is what keeps the cached prefix stable.
  `metadata.type` is shown on each line but does not reorder them.
- **No automatic learning.** A periodic pass over `last_learned_seq` folding what a
  session established into memory is a real idea and is not built. `learningEnabled` and
  `learningInterval` used to be declared for it and were never read; they are gone, on the
  grounds that a config key nothing consumes reads as a setting that does nothing. The
  column is still there for whatever builds it.
- **No settings panel for the files themselves**, and no REST route reading them. The
  budget and the prompt are editable per agent; the content is a folder.
- **No `/memory` in the browser**, pending slash commands in the composer.
