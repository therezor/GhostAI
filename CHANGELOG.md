# Changelog

The format is [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
uses [semantic versioning](https://semver.org/spec/v2.0.0.html). Every package in the
repository carries the same version and they are released together; only `@ghostbot/cli`
is something you install by name.

## [Unreleased]

### Added

- **`ghost preset` — pick agents from the catalogue, and get the boxes they need.**
  `ghost preset install` with no arguments lists every agent on offer and installs the
  ones you tick; naming ids instead (`ghost preset install coder nano`) is the scriptable
  form. A container is built because an agent asked for it, never on its own, so picking
  only agents that need no container is how an install with no Docker finishes — that is
  what `ghost install --presets-only` used to mean, and it is a checkbox now. Approval is
  settled in the same run, because approving is what unblocks the agents: `--approve` and
  `--no-approve` answer it outright, and with neither it prints each toolbox's policy and
  asks. A run with nobody to ask approves nothing. `ghost preset list` shows what is on
  offer and what is installed; `ghost preset update` re-fetches.
- **A preset can give an agent part of a toolbox, not all of it.** `toolbox.tools` in a
  preset maps a program to `allow`, `ask` or `deny`, and `"*"` sets the default for every
  program the manifest declares and the map does not name — so `{"*": "deny", "nmap":
"allow"}` is "only nmap" in one line, and `{"npm": "deny"}` is "everything but npm". A
  denied program is never sent to the model and is left out of the prompt section too,
  which is the point: a two-dozen-program box costs 60–80 tokens per entry on every
  request. These are defaults an agent's own `tools` map still overrides, not a boundary
  — `exec` reaches the program either way, and the container is what contains it.

- **A web security-testing capability: the `websec` toolbox and two agents.** `websec`
  (Alpine, network `open`) carries nuclei with its templates baked in, ffuf, gobuster,
  dalfox, sqlmap, commix, nikto, wafw00f, arjun, hydra, john and jwt_tool, with a curated
  wordlist subset — content and parameter discovery, known-issue sweeps, and
  injection/credential/auth testing, for authorized engagements. Its `security-tester`
  agent runs those tools unattended (`exec` allowed). A second agent, `recon`, maps a
  target's attack surface and hands over a written inventory; it works in the
  `web-research` box (see _Changed_). `team-lead` delegates to both. Every program is a
  named, listable tool carrying its `use`, `args` and `example`, and both boxes
  `expose: "tools"`. They ship uninstalled like every other box; nothing runs until an
  operator approves each manifest's hash.

### Changed

- **The presets and toolboxes moved to a repository of their own**,
  [`GhostAI-presets`](https://github.com/therezor/GhostAI-presets), still published as
  `@ghostbot/catalogue` and now versioned on its own cadence. They are no longer bundled
  with the CLI: `ghost preset install` fetches the package into `~/.ghostai/catalogue` on
  demand, and `--from <dir>` reads a checkout instead for anyone writing one. The
  catalogue's presets moved from `presets/` to `agents/` with the 2.0 layout, so a 1.x
  package is refused by name rather than read as empty.
- **`ghost install` is gone, replaced by `ghost preset install`** (above). It built every
  shipped toolbox and installed every shipped agent because both shipped inside the CLI
  and there was nothing to choose between; with a catalogue of its own, which of them you
  want is a real question and the answer decides which images get built. `ghost init` no
  longer offers it as a last question — the wizard configures the install and
  `ghost preset install` populates it.
- **`web-research` also does network recon now.** It gains nmap, masscan, the
  ProjectDiscovery suite (subfinder, dnsx, httpx, katana, tlsx), amass, gau, waybackurls,
  sslscan and the DNS/whois tools, and with them `NET_RAW` for `nmap -sS` — a real
  capability widening for a box a research agent uses, recorded in the manifest and
  re-approved on any edit. It is one box and not two on purpose: research and recon are
  both network-`open` and start from the same handful of tools (curl, openssl, python3,
  jq, rg), so a standalone recon box only duplicated the middle. The `researcher` and
  `recon` agents both work in it.

- **The `coding` toolbox has a network.** Its ceiling moves from `none` to `open`,
  because a coding box that cannot reach a registry cannot run a test suite whose
  dependencies are not vendored, and the `coder` agent now requests it. This is a real
  widening and worth reading as one: node, python and git are already arbitrary code
  execution, and egress turns that into a way out. The preset gained a **The network**
  section saying to install what a project pins, to name a new dependency before adding
  it, and to treat anything fetched as untrusted input rather than instructions.
  Narrowing it back is a one-word manifest edit, which forces a re-approval.

  There is no scoped middle ground today: `allowlist` needs an egress gateway container
  to enforce it and the runner refuses to start a scoped sandbox without one, so
  `proxyAllowHosts` is inert until a gateway ships.

### Fixed

- **The sidebar's session list no longer lists subagent runs.** A delegated run gets a
  session of its own, and it was surfacing in the sidebar's shortlist of recent
  conversations — an agent that delegates several times a turn could fill the column with
  rows nobody opened and push a real conversation off the bottom. The list now asks the
  server to exclude the `subagent` origin (a new `excludeOrigin` query on `GET
/api/sessions`), so its thirty rows are thirty conversations; a run stays reachable on
  `/sessions`, which still lists every origin, and from the subagent card in the
  transcript that started it. The exclusion exposed a latent bug it now also fixes — the
  "New session" row highlighted itself over _any_ conversation missing from the shortlist,
  because "unsaved" was read as "no row matches"; it now tracks the session the sidebar
  actually started.

- The release workflow's version-lockstep check read `packages/`, so
  `@ghostbot/catalogue` — which lives at the repository root — published without the
  check ever looking at it. It now enumerates the workspace through pnpm, the same set
  `pnpm -r publish` walks, so the guard cannot disagree with what actually publishes.
  `docs/development.md` lists `catalogue/package.json` as the release's third hand edit.

## [1.0.1]

### Added

- Agent presets: a JSON file — prompts, tool permissions, a toolbox reference, a
  delegation roster — merged into `agents.list` by `ghost agent install`. Nothing is
  fetched; the shape is a strict subset of an agent entry, so a preset cannot name a
  model, a provider, or anything on the toolbox manifest's side of the boundary. One
  kind of preset and one lookup: a file is `<id>.json` whether or not the agent works in
  a container, found in `~/.ghostai/presets/` and then `catalogue/presets/`. Adding your
  own is adding a file.
- `ghost agent list`, and `--force` to overwrite an agent an install would otherwise
  refuse to touch.
- `ghost install`, which builds every shipped toolbox and installs every agent in one
  command, and is offered as the last question of `ghost init` (defaulting to the agents
  that need no container, so the wizard acquires no Docker dependency). Approval is
  settled in the same run, because approving is what unblocks the agents: `--approve` and
  `--no-approve` answer it outright, and with neither it prints each toolbox's policy and
  asks once — before the question, so a `y` is informed. With no terminal and no flag it
  approves nothing, since a default of "yes" would approve container policy nobody read.
  It holds back the agents waiting on an approval rather than half-installing them, and
  never overwrites an agent already in the config.
- Three toolboxes beside the existing `web-research`, all capped at `none` network:
  `data` (**anydoc** for Word/Excel/PowerPoint/PDF/EPUB, miller, sqlite3, jq, yq, 7z,
  strings, exiftool), `media` (a full-codec ffmpeg — x264, x265, VP9, AV1 via both libaom and
  SVT-AV1, Opus, MP3, Vorbis — plus ImageMagick 7, sox, exiftool, mediainfo and
  gifsicle) and `coding` (git, node, python, rg, jq). Documents and data share one box
  deliberately: a zip of spreadsheets with a PDF summary needs the agent that converts
  and the agent that queries to be the same agent in the same turn.
- Six agents in the catalogue: `researcher`, `data-analyst` (documents and data alike),
  `media-ops` (audio, video and images), `coder`, `team-lead` and `nano`. `team-lead`
  delegates to the four specialists installed at the time it is installed — deliberately **not** to
  `nano`, which is a fast lane for the user rather than something to delegate to: a
  coordinator handing "think about this" to a no-tools agent is doing the work itself
  with a round trip added. `nano` keeps the live-state and wrap-up sections removed, so
  a request is a short cacheable identity plus the conversation.
- `~/.ghostai/presets/`, for presets an operator writes. Outside the workspace jail: a
  preset authors an agent, so one writable by `write_file` would let prompt injection
  compose the agent that runs next.

### Changed

- `toolboxes/` moved to `catalogue/toolboxes/`, beside the new `catalogue/presets/`.
  `catalogue/` is a package rather than a loose folder because the CLI resolves it at
  runtime to find the shipped presets — the same way the server finds the built UI, which
  is the one lookup that works identically in a checkout and in a global install.
- `web-research`'s `agent.json` was an orphan nothing read; it is now the `researcher`
  preset, carrying the guidance that used to be injected from a file.

### Removed

- The `TOOLS.md` mechanism entirely — the prompt injection, the `{{reference}}` and
  `{{docs}}` placeholders, `ToolboxStore.docs()`, `TOOLBOX_DOCS_MAX_BYTES`, the file
  itself and the in-container `tools` command that printed it. With `expose: "tools"`,
  each manifest entry's `use`, `args` and `example` already reach the model as a real
  tool schema, so a prose copy of the same flags was a second thing to keep in step. A
  stored `toolboxPrompt` naming either placeholder still renders — as the literal
  string, the documented behaviour for an unrecognised one — so delete it if you
  customised that template.

### Fixed

- `ghost toolbox approve <unknown>` printed its refusal and exited `0`. A nested
  subcommand records its exit code on the leaf command and the sweep only read the top
  level; it now walks the tree. Every `toolbox`, `extension` and `agent` failure was
  affected.

## [1.0.0]

The first release. Everything below is what it shipped with rather than what changed.

**1.0.0 rather than 0.x is a statement about the surface, not about how long this has
existed.** The config schema, the REST and WebSocket protocol, the tool contract, the
extension contract and the eight prompt templates are what other people build against,
and they are settled enough that breaking one should cost a major version. The known
limits at the bottom of this entry are missing features, not unfinished interfaces —
adding the `anthropic-messages` wire or a second locale changes nothing anyone has
already written.

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
- A CLI: `ghost chat` as a one-shot, a pipe target or a prompt with slash commands.
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

[unreleased]: https://github.com/therezor/GhostAI/compare/v1.0.1...HEAD
[1.0.1]: https://github.com/therezor/GhostAI/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/therezor/GhostAI/releases/tag/v1.0.0
