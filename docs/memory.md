# Memory

An agent's memory is one markdown file in the workspace — `memory/memory.md` — placed
whole into every prompt on that folder. The agent adds to it with the `memory` tool, a
person edits it with an editor, and `/memory compress` folds an over-long session into
it. There is no database, no embedding and nothing to migrate: a memory you can read is
one you can correct.

> **On an existing install, nothing is remembered until you grant the tool.**
> `DEFAULT_AGENT_TOOLS` seeds a _newly created_ agent, so an install that predates this
> feature has no `memory` key in its permission map — and an absent tool is a denied one.
> Grant it in Settings → Agents, or run `/memory on`. This applies to `skill` too.

## The switch is the tool

There is no `memoryEnabled` setting, deliberately. A tool already carries `allow`, `ask`
or `deny` per agent, already appears in the settings UI, and already lives in
`config.json` — which is exactly "this capability is on, off, or gated". A boolean beside
it would be a second way to say the same thing, and two switches for one thing is how
they come to disagree.

Denying `memory` removes the prompt section as well as the tool. An agent that cannot
write its memory should not still be paying for it in every request.

| You want                                  | Do this                                   |
| ----------------------------------------- | ----------------------------------------- |
| This agent to stop remembering            | Set `memory` to `deny`, or `/memory off`  |
| Memory kept on disk but out of the prompt | `memoryMaxPromptTokens: 0`                |
| To approve each thing it records          | Set `memory` to `ask` — the section stays |

`/memory off` changes the **agent**, not the session: every conversation on that agent is
affected, which is the same thing ticking the box in Settings does.

## The file

```
<workspace>/
└── memory/
    └── memory.md
```

```markdown
Always deploy with `make release`. The staging box is fed by the same pipeline.

## Session 2026-08-05

- The user prefers rem over px, and wants an explicit design token layer.

## Session 2026-08-07

- CI runs `format:check`, which `pnpm check` does not.
```

Everything above the first `## Session` heading is the **preamble** and belongs to
whoever typed it. Everything below is dated sections the agent appends to.

That boundary is the whole reason the file has a shape. Compaction rewrites sections with
a model, and without somewhere to stop, the first compaction would paraphrase away the
"always deploy with `make release`" line. **A file with no heading is entirely preamble**,
which is what makes an existing hand-written `memory.md` safe the first time an agent
touches it.

Three rules, each failing to memory alone rather than to the turn:

- **Appending never rewrites.** The tool adds to today's section or opens one. Only
  compaction replaces the file, and it never reaches above the first heading.
- **Reading never throws.** A malformed or unreadable `memory.md` costs memory, not every
  turn on the workspace — the same position `skills.ts` takes on a broken skill.
- **A missing file is the ordinary case**, not a misconfiguration, so it is not logged.

## What reaches the prompt

```
## Memory

What you have learned about this workspace, kept in `memory/memory.md`. To record
something durable, call the `memory` tool — it appends, so nothing here is lost. Keep
entries short: this file is in every prompt on this folder.

Always deploy with `make release`. The staging box is fed by the same pipeline.

## Session 2026-08-05

- The user prefers rem over px, and wants an explicit design token layer.
```

The whole file, inlined — no index, and no "open it when relevant" half. That is the
opposite of what [Skills](skills.md) does, and the difference is worth stating: a
workspace has many skills and needs at most one per turn, so an index earns its keep. It
has exactly one memory, and memory the model has to decide to go and read is memory it
will forget to consult.

It lands in the **static** half of the prompt — the provider's cached prefix — and is
placed _after_ skills. Sections are appended in order so the cached prefix grows at the
end, and memory is the section a turn can rewrite, so it sits where a change invalidates
the least. See [Prompts](prompts.md).

Over budget, the **newest** text is kept and the oldest is cut. A memory file is written
newest-last, so the tail is what a recent session learned and the head is what compaction
has already summarised once.

## How it gets written

The `memory` tool takes one argument — the note — and **no path**. Deriving the file from
the jail root is the whole reason it is not a worse `write_file`: there is no path for a
model to get wrong and nothing for the jail to adjudicate.

It appends. Two calls are two notes, and the first cannot be lost by the second. It needs
no `read` operation, because when the tool is granted the file is already inlined above —
the model holds the current bytes at the moment it decides to add to them.

A change lands in the **next** turn's prompt, not this one: the static half is built once
per turn.

Nothing stops a person — or the model, through `write_file` — editing `memory.md` by
hand. That is intended; see the placement section below.

## Compression

Long sessions outgrow their window. `/memory compress` folds the oldest messages into a
dated memory section and advances the session's consolidation marker, so those messages
stop being replayed.

**It is manual.** Nothing runs on a timer or at the end of a turn. A fold costs a provider
round trip, and putting one in front of a turn's first token buys nothing for the turn
that paid for it — and a summary is lossy in a way worth looking at before it becomes the
only copy. `/memory` prints a nudge once a session passes half the context window; that
threshold is the only thing that reads it, and it never acts.

Two things happen, independently:

|             | When                                              | Effect                                                                          |
| ----------- | ------------------------------------------------- | ------------------------------------------------------------------------------- |
| **Fold**    | history is over the target                        | the oldest messages become one dated section, and `last_consolidated_seq` moves |
| **Compact** | the notes are over `memoryCompactThresholdTokens` | every dated section is merged into one; the preamble is untouched               |

The cut always lands immediately before a `user` message. That is not cosmetic: it means
the window that remains opens on a complete turn and can never begin with a `tool` result
whose `assistant` was folded away — the 400 every provider returns for that, prevented by
construction rather than repaired afterwards.

**The file is written before the marker moves, and the order is not interchangeable.** A
crash between the two replays messages the memory already summarises: the prompt says the
same thing twice for a while, and a person can see it and fix it. The other order moves
the marker past messages nothing represents — gone from every future prompt, permanently,
with no code path able to notice. There is no cheap transaction spanning a SQLite row and
a file on disk, so this is a choice between two failure modes.

`consolidationModel` picks a cheaper model for the summarising call. It must be one the
agent's **own provider instance** hosts — a model from another endpoint gets a 400, which
surfaces as a failed `/memory compress` rather than a silently skipped one.

## The commands

`/memory` exists in the terminal REPL and in Telegram. It is **not** in the browser
composer yet: slash commands there are still on [the roadmap](ROADMAP.md), and this
command arrives with them.

| Command                     | Does                                                                                            |
| --------------------------- | ----------------------------------------------------------------------------------------------- |
| `/memory`                   | Whether the tool is granted, what the file costs, and whether this session is worth compressing |
| `/memory on`, `/memory off` | Grants or denies the `memory` tool on this agent                                                |
| `/memory compress`          | Folds the oldest messages into memory                                                           |

There is no `/memory edit`: `write_file` already opens the file, and a command whose whole
job is to hand a path to an editor is what [Tools](tools.md) argues against.

One wrinkle in Telegram: compression there goes through the console port rather than out
as a control frame, so a browser tab open on the same session will not learn the history
moved until its next turn. Nothing breaks — the marker is read at the top of a turn — the
tab is simply showing more than what is now sent.

## The budget

| Cap                            | Value                  | What it bounds                                  |
| ------------------------------ | ---------------------- | ----------------------------------------------- |
| `memoryMaxPromptTokens`        | config, default `2000` | What reaches the prompt. `0` places no section. |
| `memoryCompactThresholdTokens` | config, default `1600` | Where the notes get rewritten smaller.          |
| `MEMORY_MAX_BYTES`             | 256 KB                 | What is read from disk at all.                  |
| `KEEP_RECENT_TURNS`            | 4                      | User turns never folded.                        |

The two config keys are per-agent, and the editor refuses a threshold above the cap: notes
cut at the cap before ever reaching the threshold would be truncated instead of
compacted, which loses what was learned rather than shortening it.

The byte cap and the token cap do different jobs and are not interchangeable — 256 KB
stops a runaway file reaching a Buffer, and the token budget decides what a model sees.
Both are measured with `estimateTokens`, the character heuristic, on purpose: the two
config numbers only mean anything relative to each other, and two rulers is how "the
threshold is below the cap" silently inverts.

See [Configuration](configuration.md).

## Where this lives, and what it costs

In the workspace, which is inside the jail, which means `write_file` and `exec` can both
edit `memory.md`.

`packages/core/src/paths.ts` puts an agent's own directory _beside_ the workspace for
exactly this reason, and says why: the jail root _is_ the workspace, so memory kept inside
it is writable by the agent, and that turns prompt injection into a way of rewriting the
agent's own system prompt. **That argument is correct, and the file was put here anyway.**

What buys it: memory committed beside the project it describes, visible in a directory
listing, diffable in review, and correctable with an editor. A memory an operator cannot
see is one they cannot fix, and the failure mode of a wrong memory is every future turn on
that folder.

What follows from the placement, in code:

- **The `memory` tool is the intended path, not an enforced one.** It appends and takes no
  path; `write_file` can still replace the file wholesale.
- **The preamble is structural protection, not access control.** Compaction cannot reach
  above the first heading — but `write_file` can.
- **Every write is atomic.** A temp file beside the target, then a rename, so a crash
  cannot leave a half-written memory that the next turn inlines.
- **Reads are bounded** at 256 KB, so a file dropped into `memory/` costs a prompt section
  and not the process.

If you want the injection-proof arrangement, set `write_file` to `ask` or `deny`: the
agent then records what it learns through `memory`, which can only append, and cannot
rewrite what is already there.

## What is not built yet

- **No automatic compaction.** The advisory threshold is the hook one would use.
- **No proactive learning.** `learningEnabled` and `learningInterval` are still declared
  and unread; they belong to a periodic pass over `last_learned_seq` that does not exist.
- **`memory.shared` does nothing.** It was declared to choose between an agent's own layer
  and a shared one. A file in the workspace is a property of the _folder_, so it is
  already shared by every agent that opens it, and there is no per-agent layer for
  `shared: false` to fall back to.
- **No settings panel for the file itself**, and no REST route reading it. The budget is
  editable per agent; the content is a file.
- **No `/memory` in the browser**, pending slash commands in the composer.
