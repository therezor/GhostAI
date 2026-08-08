# Changelog

The format is [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
uses [semantic versioning](https://semver.org/spec/v2.0.0.html). Every package in the
repository carries the same version and they are released together; only `@ghostbot/cli`
is something you install by name.

## [Unreleased] — 1.0.0

**Not published yet.** The manifests say `1.0.0`, the docs describe
`npm install -g @ghostbot/cli`, and [`release.yml`](.github/workflows/release.yml) is armed
— but the tag has not been pushed. Until it is, this heading stays `Unreleased` rather
than claiming a version npm does not have.

At release: `git tag v1.0.0 && git push --follow-tags`, then change this heading to
`## [1.0.0] — YYYY-MM-DD`. That is the only edit this file needs.

Everything below is what the first release will ship with rather than what changed.

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

[unreleased]: https://github.com/therezor/GhostAI/commits/main
