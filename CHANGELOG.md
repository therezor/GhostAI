# Changelog

The format is [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
uses [semantic versioning](https://semver.org/spec/v2.0.0.html). Every package in the
repository carries the same version and they are released together; only `@ghostwire/ghostai`
is something you install by name.

## [0.7.0] - 2026-08-09

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

[0.7.0]: https://github.com/therezor/GhostAI/releases/tag/v0.7.0
