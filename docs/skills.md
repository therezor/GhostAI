# Skills

A skill is an instruction sheet the agent can reach when it needs it. It lives in the
workspace, so it is a folder you commit beside the project it describes rather than
something an install carries in its settings.

Every skill's name and description reach the prompt on every turn — about twenty tokens
each. The instructions themselves stay on disk until the agent decides the skill applies
and opens the file with `read_file`. Naming one on a message with `@skill:code-review`
skips that step: its body is in the prompt before the agent does anything, for that
message.

## The folder

```
<workspace>/skills/
  code-review/
    SKILL.md          ← required
    checklist.md      ← whatever else the skill needs
  release-notes/
    SKILL.md
```

`SKILL.md` is frontmatter and a body:

```markdown
---
name: code-review
description: Review a diff for correctness, then for style. Use before opening a PR.
---

Read the diff with `exec git diff`. Take correctness first: off-by-ones, error paths
that swallow, anything that changes behaviour the tests do not cover. Then style —
and only against `checklist.md`, not against your own taste.
```

**A skill is a directory, not a file**, and that is the reason: the directory is where
the skill's own material goes. `checklist.md` above is an ordinary workspace file, so the
agent reads it with the tool it already has, and it costs nothing until it is read.

Three rules, each of which fails to that skill alone rather than to the turn:

- **The directory name is the skill's id.** It is what appears in the path the model is
  given, so it is the one identifier that cannot disagree with anything. A frontmatter
  `name` saying something else is a warning in the log, and the directory wins.
- **`description` is required.** It is the entire basis on which the agent decides to
  open the file. A skill without one is not advertised at all — an index line reading
  `**deploy**:` teaches the model that the skill is about nothing.
- **A malformed skill is skipped, never fatal.** A missing `SKILL.md`, an unclosed
  frontmatter fence, a description that is only whitespace: each costs one skill and one
  `warn` line. A folder in a workspace is whatever a person or a previous turn left there,
  and a turn that refuses to start because of it is a worse outcome than one that runs
  with four skills instead of five.

### The frontmatter is not YAML

It is `key: value` lines between two `---` fences, with one optional pair of surrounding
quotes stripped. Blank lines and `#` comments are skipped, and so is anything that is not
`key: value` — a `tags:` list left in the block does not refuse the file, it is simply not
read.

That is a deliberate stopping point rather than a subset on the way to something. Nothing
else in this repository parses YAML, and what a skill's frontmatter holds is two strings.
See the header of `packages/core/src/frontmatter.ts`.

## What reaches the prompt

In the **static** half — the part a provider caches for the life of a session:

```
## Skills

Instruction sheets kept in this workspace under `skills/`. A line below is a
summary, not the skill — open the file with `read_file` before acting on what it names.

- `skills/code-review/SKILL.md` — **code-review**: Review a diff for correctness, then style.
- `skills/release-notes/SKILL.md` — **release-notes**: Draft release notes from a git range.
```

Every skill is here, and none of their bodies. Skills are sorted by name, because the
section sits in the provider's cached prefix and a `readdir` order that varied between
hosts would move that prefix for no visible reason.

In the **runtime** half — the trailing block rebuilt on every iteration and never cached —
whatever this message named:

```
### Skill: code-review

Read the diff with `exec git diff`. Take correctness first: …
```

A named skill therefore appears twice: as its index line above and as its body here. That
is deliberate and it costs about twenty tokens. Dropping the line would mean varying the
cached half with the message, which is the expense the two halves exist to avoid — and it
would cost the whole prefix rather than a line of it.

There **is** a `skill` tool, and it exists for a reason the argument against it never
addressed.

The argument against was good, and it was about reading: a tool whose whole job is to
return the bytes of a workspace file is a worse `read_file` — one more name in every
agent's permission map and one more schema in every request, to reach a file the agent can
already open. That is still true, and it is still what [Tools](tools.md) opens by saying.

What it did not cover is the **permission**. A tool carries `allow`, `ask` or `deny` per
agent, already in the config and already in the settings UI, and that is exactly "this
capability is on, off, or gated". Without a `skill` tool there is no way to turn skills off
for one agent short of adding a `skillsEnabled` boolean beside the permission map — a
second switch for one thing, and the way the two come to disagree.

So the cost the old argument names is real and is now paid deliberately. What it buys:
denying `skill` removes the catalogue from the prompt as well as the tool, and the whole
feature has one switch rather than two. The same reasoning put a `memory` tool beside it;
see [Memory](memory.md).

Two consequences worth knowing. **On an existing install nothing is indexed until the tool
is granted** — `DEFAULT_AGENT_TOOLS` seeds a newly created agent, so a config that predates
this has no `skill` key, and an absent tool is a denied one. And the model can still reach
a sheet with `read_file`: the tool is the intended path, not the only one.

### `@skill:` on a message

`@skill:code-review` sends that whole sheet with the message. It is the only way a body
reaches the prompt without the agent opening the file itself, and it lasts exactly one
message — the next turn is back to the index unless it says so again.

This replaced a config key. `pinnedSkills` named skills whose bodies were inlined into the
cached half for the life of a session: one decision, made by an operator, applied to every
turn. Which message needs the deploy sheet is not knowable when the config is written, and
it is obvious to the person typing — so the decision moved to them.

It reaches the prompt the same way from anywhere, because the parse happens in the hub that
every channel bridges through rather than in any one client. Typed in the browser, in
`ghost chat`, or to the Telegram bot, `@skill:` means the same thing. Where to find the
names differs:

| Surface  | How to find a name                                                |
| -------- | ----------------------------------------------------------------- |
| Web      | Type `@skill:` and the composer completes from `GET /api/skills`. |
| CLI      | Tab after `@skill:`, or `/skills` for the list.                   |
| Telegram | `/skills`.                                                        |

The name is not checked against the folder. A mention that matches nothing — a typo, or a
skill deleted since the message was written — falls back to the line it would have got
anyway: read this path. That costs one `read_file` answering "no such file", which the
model recovers from, where checking would cost either a disk read on every iteration or a
cache that would hand one workspace's skills to a concurrent turn in another.

**One message starting with `/` is the exception**, on every channel that has commands: it
routes to the command handler and never reaches the hub, so a mention in a command's tail
is dropped. `/edit` and `/regenerate` are themselves exceptions to that, because both
re-parse the text they rewrite.

## The budget

| Cap                    | Value          | What it bounds                                                |
| ---------------------- | -------------- | ------------------------------------------------------------- |
| `MAX_MENTIONED_SKILLS` | 5              | Bodies inlined by one message. Past it, a name gets its path. |
| `SKILL_MAX_BYTES`      | 12 KB          | One body. Past it, the body is cut and says that it was.      |
| `MAX_SKILLS`           | 100            | Index lines. Past it, the rest are not advertised at all.     |
| description            | 200 characters | One index line stays one line.                                |

The mention cap is a constant rather than a setting. It exists to stop one message costing
five figures of uncached prompt on every iteration of its turn, and that hazard does not
vary by install the way a taste for long prompts does. Names past it are not dropped — they
fall back to a path line, so the sheet stays reachable and it is only the inlining that is
capped. They are read in **the message's** order, so someone who names three skills under a
cap of two gets the first two.

## Where these live, and what it costs

They are in the workspace, which is inside the jail, which means `write_file` and `exec`
can both edit them. That is worth stating plainly rather than leaving to be discovered,
because `packages/core/src/paths.ts` argues the opposite case — it reserves
`~/.ghostai/agents/<id>/`, outside the jail, precisely so that prompt injection cannot
rewrite what an agent believes.

That argument was overruled twice, on the same grounds. Skills are here, and so is
[memory](memory.md); both are meant to be read, reviewed and committed beside the project
they describe, and neither is that if it lives somewhere the agent cannot list.

The same attack exists here: a turn that is talked into writing `skills/deploy/SKILL.md`
changes what a later turn on that workspace is told. What buys the risk is the thing that
makes skills useful at all — a skill folder is meant to be read, reviewed and committed
beside the project it describes, and a directory the agent cannot see in a listing is not
that. A skill is also not a capability: it is prose, and the jail and the exec guard have
never read a word of the prompt. Deleting or forging one changes what the agent _knows_,
not what it _can do_ — the argument [Prompts](prompts.md) makes about the system prompt,
which skills are now part of.

What follows from the placement, in code:

- **A symlinked skill directory is skipped.** `isDirectory()` is already false for a
  symlink, so a link pointing out of the workspace is never followed. There is a test
  asserting it, because it is a property of `Dirent` rather than a line anyone would
  notice deleting.
- **Every body is bounded** before it reaches the prompt, so a 400 MB file dropped into
  `skills/` is 12 KB of prompt and a log line.
- **Nothing is written.** The loader only reads.

If you want the injection-proof arrangement instead, keep the workspace's `skills/` out of
the agent's write permissions: an agent whose `write_file` is `deny` or `ask` reads its
skills and cannot author them.

## The section is a template you own

`agents.list.<id>.skillsPrompt` holds the heading and the prose, on the contract the
other seven keep: empty inherits `DEFAULT_SKILLS_TEMPLATE`, a single space deletes the
section, anything else is this agent's own. It is edited under **Advanced prompt
settings** in the agent editor. See [Prompts](prompts.md).

What stays in code is the _shape_ of the index line, because that is what the catalogue and
`read_file` agree on, not prose. `{{index}}` carries its own leading blank line, so a
template that places it straight after its prose leaves no gap when there is nothing to
list.

The template has no placeholder for a body. A `@skill:` mention writes into the runtime
half, which no template owns — it is rebuilt every iteration, so there is no operator
wording to keep stable there.

Whether the section is placed at all is the `skill` tool's permission, not this template.
Denying it removes both.

So does `toolsEnabled: false`, which is broader: with no tool list advertised there is
nothing to open a sheet _with_, and a catalogue of paths plus prose naming `read_file` is
cost the model cannot act on. **This takes a `@skill:` mention with it**, whose body would
still have been readable — deliberately. Half a section whose own wording points at a tool
that is not there is worse than no section, and an agent with no tools and a fixed
instruction sheet is what `systemPrompt` is for.

## What is not built yet

- **No settings panel for the skills themselves.** They are authored by writing files, and
  no screen is planned: a skill is named on a message rather than configured, so Settings →
  Extensions no longer lists one as coming.
