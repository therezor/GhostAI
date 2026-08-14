# Changelog

The sections are [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)'s — Added,
Changed, Fixed, Removed — without its release dates, which the tags carry. This project
uses [semantic versioning](https://semver.org/spec/v2.0.0.html). Every package in the
repository carries the same version and they are released together; only `@ghostwire/ghostai`
is something you install by name.

## [0.7.2]

Two screens stopped lying about a turn that is still running: a reload during a
delegation lost the run, and the context bar billed text the model never saw.

### Added

- **A reload mid-turn comes back to the whole turn**, nested subagent steps
  included. The server keeps the running turn beside the replay ring, and a
  resume past the ring gets both the stored tail and that turn's frames.
- **`server.turnLogMaxBytes`** (default 16 MiB) bounds that retention. Only a
  session with an open turn holds one; `0` turns it off.
- **The context bar moves while a turn runs**, on a new `context.usage` frame
  emitted at the end of every tool iteration.
- **Time to first token** in the turn-info popover, beside elapsed.

### Changed

- **Tokens/s divides by generation time, not the turn's wall clock**, so a cold
  model load or a slow tool no longer reports the model as slow. Older turns
  keep the wall-clock figure.
- **The context inspector prices the request, not the stored records.** The
  model's reasoning and a tool's `risk`/`source` are no longer counted or shown;
  both halves of the prompt are priced inside the messages they are sent in.
  Expect the figure to move on the same conversation.
- The retry ladder sizes history the same way, so a context-length retry cuts
  what it means to.
- `GET /api/sessions/:key/context` no longer returns `reasoning`. The transcript
  endpoints still do.

### Fixed

- **`node:sqlite`'s experimental warning no longer prints** on every command
  that touches a session. Only that one message is dropped.
- A subagent whose delegating call was never seen — the usual outcome of
  reloading mid-delegation — renders as a card instead of being dropped.
- A _reconnect_ past the replay ring no longer deletes the answer on screen.

## [0.7.1]

Skill sheets learn who they are for. A sheet was in every agent's catalogue or in
none, which is the wrong granularity for a workspace a coder, a researcher and a
lead all work in: every sheet cost every agent prompt on every turn, and the only
way to narrow it was not to write the sheet.

### Added

- **`agents:` in a sheet's frontmatter**, narrowing it to the agents it names —
  `agents: coder, team-lead`. A sheet without one is in every agent's catalogue, so
  nothing written before this changes. Scope decides which sheets an agent is _told
  about_, not which it may open: `read_file` and the `skill` tool still reach a sheet
  that was never advertised, and that is not a hole — a skill is prose, and the jail
  and the exec guard have never read a word of the prompt.
- **It fails open.** A line that yields no usable id leaves the sheet visible to
  every agent and logs a warning. The two ways of being wrong are not symmetric: a
  sheet shown too widely costs prompt that `/skills` will show you, and a sheet
  hidden from everybody is one that silently stopped working with nothing anywhere
  to find.
- **`skills` on an agent preset** — sheet directories under the catalogue's
  `skills/`, copied into the workspace when the agent installs. A copy, byte for
  byte, rather than an install: no hash, no approval gate, and nothing recorded
  afterwards. A toolbox manifest earns one because it names a container's boundary;
  a sheet is prose, and the preset's own `systemPrompt` — same catalogue, same
  network — already set that bar.
- **`-W, --workspace-id <id>` on `agent install` and `preset install`**, saying which
  workspace those sheets land in. It defaults to `default`, and a named workspace has
  to exist already. Spelled `--workspace-id` because `--workspace` already means a
  _directory_ on `chat` and `serve`, and one flag meaning two things is how somebody
  ends up passing a path to it.
- **`/skills` marks sheets scoped to other agents** rather than dropping them.
  Somebody runs it precisely when a sheet is not working, and a listing that hid it
  would leave nowhere to find out why.

### Changed

- **Nothing about a sheet refuses.** One that is missing, symlinked or over the
  copier's bounds costs that sheet and a line in the report, and the agent installs
  regardless. A missing _toolbox_ still refuses, because an agent without one cannot
  run at all; an agent with one fewer index line can.
- **A sheet already in the workspace is left alone** unless `--force` is passed,
  which is the rule the `agents.list` entry already followed and for the same reason:
  it may carry your edits. `--force` overwrites file by file rather than emptying the
  directory, so anything you added inside a sheet folder survives.
- **`MAX_SKILLS` is applied before scope**, deliberately: the cap bounds the per-turn
  read, and applying it after would mean opening a thousand directories to find the
  twelve one agent sees. Past a hundred, which sheets an agent sees follows
  alphabetical order rather than who they are for.
- `ghostai agent install` copies a preset's sheets too when a catalogue is already on
  the machine. It never fetches one, so on a box that has never run
  `ghostai preset update` every sheet a preset names is reported missing, and the
  agent installs anyway.

### Removed

- **`~/.ghostai/agents/<id>/`, and `agentDirFor` from `@ghostwire/core`.** The
  directory was reserved so per-agent state could sit outside the jail, where prompt
  injection could not rewrite what an agent believes. Nothing ever wrote to it:
  memory declined it, skills declined it, and per-agent scope declined it too — each
  time because a sheet is meant to be read, reviewed and committed beside the project
  it describes, and it is none of those if it lives somewhere the agent cannot list.
  After a third pass the reservation was removed rather than kept for a fourth. An
  agent id is now a key in `agents.list`, a session column and a tool-name segment,
  and never a directory; it keeps a workspace id's character rules regardless, since
  two rule sets that agree today are two that drift apart in the case nobody tested.

### The catalogue moves on its own

Sheets a preset brings need a catalogue that carries them, and
`@ghostwire/presets@1.0.0` has no `skills/` and no preset naming one. Nothing waits
on the other: a preset that names no sheet copies none, and the half of this that
reads sheets already in a workspace works today with no catalogue at all.

The CLI asks npm for `@ghostwire/presets@^1.0.0` — any 1.x, with `--no-save` and
`--no-package-lock`, so nothing pins a resolved version. A catalogue that adds
`skills/` therefore reaches an existing install on the next `ghostai preset update`,
with no upgrade of GhostAI itself. The two release on their own cadences by design;
this entry describes what the app can do, not what today's catalogue asks it to.

## [0.7.0]

The first release. Everything below is what it ships with rather than what changed.

**0.7.0 rather than 1.0.0, deliberately.** An earlier build went out as 1.0.0 on the
argument that the surface was what mattered — the config schema, the REST and WebSocket
protocol, the tool contract, the extension contract and the eight prompt templates are
what other people build against, and breaking one should cost a major version. That
argument still holds and those interfaces have not moved. What was wrong was the
confidence: within two days the agent presets and toolboxes had been extracted into a
repository of their own, the command that installs them was rewritten around a question
the old one never asked, and the packages moved scope. A surface that reshapes itself
that often is a 0.x whatever its interfaces promise.

**The scope is `@ghostwire` and the command is `ghostai`.** Both were `@ghostbot` and
`ghost` in the withdrawn builds. `ghost` is a common enough binary name to collide on a
shared machine, and `@ghostbot/cli` named the layer rather than the product — what you
install is the thing you type.

The known limits at the bottom of this entry are missing features, not unfinished
interfaces.

### The agent

- A tool loop as an async generator, with one `AbortSignal` threading from the HTTP
  request through the provider fetch, the tool and any child process.
- Mid-turn steering: what you type while a turn runs reaches that turn.
- Subagents — an agent delegates to another as an `ask_<id>` tool, each run a real turn on
  a real loop in its own linked session.
- Eight built-in tools: `read_file`, `write_file`, `edit_file`, `list_dir`, `exec`,
  `memory`, `skill`, `automation`.
- Per-tool, per-agent permission — `allow | ask | deny`, and a tool absent from the map is
  not enabled at all.
- Memory and skills as plain markdown in the workspace, one file per fact and one folder
  per sheet.

### Four ways in

- A web UI: streaming answers, tool cards, approval prompts, a file browser and editor,
  multiple workspaces, an agent editor, and a context inspector.
- A CLI: `ghostai chat` as a one-shot, a pipe target or a prompt with slash commands.
- REST and WebSocket on the same port, with an OpenAPI 3.1 document generated from the
  same Zod schemas the server validates against.
- A Telegram bot over long polling, answering only the ids you list.

### Models

- Local first: Ollama, LM Studio, llama.cpp and vLLM, with loopback defaults and live
  model listing.
- Cloud, opt-in: OpenAI, Gemini, OpenRouter, DeepSeek, Groq, xAI, and `custom` for any
  OpenAI-compatible endpoint.
- A prompt split around the provider's cache prefix, with tool definitions and the
  per-turn nonce computed once per turn.
- All eight prompt templates editable, replacing the built-in text rather than being
  appended to a hidden preamble.

### Security

- A workspace jail that rebuilds paths rather than inspecting them, then `realpath`s and
  checks containment.
- Argv-only `exec` — `execFile` with `shell: false`, and a lint rule that fails the build
  on `shell: true`.
- Toolboxes: `exec` inside a digest-pinned container, authorised by manifest hash, caps
  dropped, root read-only, network mode capped by the manifest.
- `guardedFetch`, which pins resolved addresses into the dispatcher so there is no second
  DNS lookup to differ from the first.
- Per-turn nonce fencing on every tool result, with non-destructive injection detection.
- An AES-256-GCM credential vault with its key in the OS keychain.
- argon2id passwords with two asymmetric throttle scopes, and a refusal to start on a
  non-loopback bind with authentication off.

### Agents you install

- **Agent presets.** A JSON file — prompts, tool permissions, a toolbox reference, a
  delegation roster — merged into `agents.list`. The shape is a strict subset of an agent
  entry, so a preset can express nothing a settings save could not: no model, no
  provider, and nothing from the toolbox manifest's side of the security boundary. One
  kind of preset and one lookup, whether or not the agent works in a container.
- **`ghostai preset install`** lists what the catalogue offers and installs the ones you
  tick, building only the containers those particular agents named. Choosing agents that
  need no container is how an install with no Docker finishes. Approval is settled in the
  same run, because approving is what unblocks the agents: `--approve` and `--no-approve`
  answer it outright, and with neither it prints each toolbox's policy and asks — before
  the question, so a `y` is informed. A run with nobody to ask approves nothing.
- **`ghostai agent install <id>`** is the scriptable single-shot beside it, with `--force`
  to overwrite an entry that may carry your own edits, and `ghostai agent list` /
  `ghostai preset list` to see what exists.
- **The catalogue is a separate repository**,
  [`GhostAI-presets`](https://github.com/therezor/GhostAI-presets), published as
  `@ghostwire/presets` and versioned on its own cadence. It is fetched on demand into
  `~/.ghostai/catalogue`; `--from` reads a checkout instead, for anyone writing a preset,
  and is never fetched over.
- **A preset can take part of a box rather than all of it.** `toolbox.tools` maps a
  program to `allow`, `ask` or `deny`, and `"*"` sets the default for every program the
  manifest declares and the map does not name — so `{"*": "deny", "nmap": "allow"}` is
  "only nmap" in one line. A denied program is never sent to the model and is left out of
  the prompt section too, which is the point: a two-dozen-program box costs 60–80 tokens
  per entry on every request. These are defaults an agent's own `tools` map still
  overrides, not a boundary — `exec` reaches the program either way, and the container is
  what contains it.

### Extending it

- MCP servers over stdio, Streamable HTTP or SSE, with OAuth where a server wants it.
- Extensions: a directory that adds tools, channels, providers, prompt sections and slash
  commands, approved by a digest over every byte it holds.
- Scheduled jobs, cron and one-shot, where a heartbeat is a job rather than a second
  system.

### Known limits

Stated here for the same reason they are stated in the README: a feature list that omits
them reads as more finished than it is.

- **`openai-chat` is the only wire adapter that ships.** The `anthropic` registry entry
  names `anthropic-messages` and is refused at construction rather than falling back;
  reaching it means an endpoint that speaks `openai-chat` or an extension contributing the
  wire.
- **English is the only shipped locale.** The translation layer is complete — typed
  bundles, negotiation, errors carrying keys across packages, two CI gates — and adding a
  language is a folder plus a line.
- **A heartbeat's `targets` do not reach a channel yet.** The decide/run/evaluate triad
  ships as a scheduled job's payload; delivery does not.
- **Session search is by title and filter, not by message content.**

[0.7.2]: https://github.com/therezor/GhostAI/releases/tag/v0.7.2
[0.7.1]: https://github.com/therezor/GhostAI/releases/tag/v0.7.1
[0.7.0]: https://github.com/therezor/GhostAI/releases/tag/v0.7.0
