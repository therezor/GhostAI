# GhostAI

**A self-hosted AI agent that reads your files and runs your commands — on your hardware, against your models, with nothing leaving the box.**

Claw-style: the same tight tool loop the terminal coding agents run — model calls a tool, reads the result, calls the next one — but built as a _service_ rather than a terminal session. One process serves the agent, a web UI, a REST API and a WebSocket on a single port, and stores everything in one SQLite file.

Point it at Ollama and it is fully offline. Point it at a container image you built yourself and it can run whatever is in it. It is built for long, tool-heavy work — recon and pen-test runs, codebase surgery, research sweeps, scheduled chores — on infrastructure you control.

```bash
pnpm install && pnpm build
ghost serve
```

---

## Why this one

**It stays on your machine, and that is tested rather than promised.**
Zero telemetry — a repo-wide grep for `telemetry|analytics|posthog|sentry|mixpanel` returns exactly one hit, and it is the comment in the test that forbids them. [`self-contained.test.ts`](packages/web/src/self-contained.test.ts) fails the build if a CDN link, a `preconnect` or a cross-origin stylesheet appears in the UI; fonts ship from npm. [`offline.spec.ts`](packages/e2e/src/tests/offline.spec.ts) blocks every foreign origin in a real browser and drives the whole app anyway. The server binds `127.0.0.1`, and a non-loopback bind with auth disabled **refuses to start**.

**Local models are the default, not the fallback.**
Ollama, LM Studio, llama.cpp and vLLM ship in the registry with loopback defaults and live model listing. Cloud providers — OpenAI, Anthropic, Gemini, OpenRouter, DeepSeek, Groq, xAI — are opt-in, and `custom` takes any OpenAI-compatible endpoint. Two boxes running Ollama are two entries in one config file.

**It is frugal with tokens on purpose.**
The system prompt is split in two around the provider's cache prefix: a static half that is byte-identical for the life of a session, and a small runtime half at the tail. Tool definitions and the per-turn nonce are computed once per _turn_, not per iteration. The session key, the channel label and the iteration counter were deliberately deleted from the uncached half — the counter now prints only in the last three iterations, when it is actionable. A toolbox advertises a whole container of programs in about forty tokens, where tool schemas would cost sixty to eighty **each, on every request**. See [Prompts](docs/prompts.md).

**Every prompt is yours.**
Three templates — the identity prompt, the live-state block and the wrap-up sentence — live in config and are edited in the UI. `systemPrompt` **replaces** the built-in text; it is not appended to a hidden preamble. Leave one empty and you inherit improvements on upgrade; set it to a single space and the section is gone. A typo renders verbatim instead of silently deleting a line.

**Permission is per tool, per agent.**
`allow | ask | deny`, and a tool absent from the map is not enabled at all — it never reaches the definitions the model is sent. Risk bands seed a new agent and then decide nothing. An `ask` tool shows the operator the arguments before it runs, with once / this-session / always as the answer.

**The security work is a package you can read.**
Every decision about whether an agent may touch a path, reach a host, spawn a process or read a credential is in [`packages/security`](packages/security/src) and nowhere else, behind a 95%-line-and-branch coverage gate. Each guard's source explains the attack it closes and why the obvious approach does not work.

---

## Install

| Tool   | Version | Why                                                             |
| ------ | ------- | --------------------------------------------------------------- |
| Node   | ≥ 22.11 | Uses the built-in `node:sqlite` — no native module to compile   |
| pnpm   | ≥ 10    | `npm i -g pnpm`                                                 |
| Ollama | any     | Optional. `ollama serve && ollama pull qwen3` for a local model |
| Docker | any     | Optional. Only needed for [toolboxes](docs/toolboxes.md)        |

```bash
pnpm install
pnpm build                                  # → packages/cli/dist/index.js
pnpm --filter @ghostai/cli link --global    # gives you `ghost`
```

### First run, from a browser

```bash
ghost serve
```

It starts even with nothing configured, and prints a one-time setup code:

```
GhostAI is listening.

  URL        http://127.0.0.1:3000
  Auth       enabled
  Agent      not configured — add a provider in the UI, or run `ghost init`
  Workspace  /Users/you/.ghostai/workspace

First run. Open the URL above and enter this one-time code:

      K7QF-2M9X-BW4T

  It works once, and stops working as soon as you set a password.
```

The wizard asks for a language, the code, a username and password, then a provider and a model. The provider step fetches the model list from the endpoint itself, so on a machine running `ollama serve` the model question is a list rather than a text box.

Everything after the password is skippable. An install with no model still serves files, workspaces, settings and notifications — only chat is unavailable, and the composer says so and links to the panel that fixes it.

### First run, from a terminal

```bash
ghost init      # workspace, provider, model — same questions, no browser
ghost chat      # talk to it
```

`ghost init` needs a real terminal; it refuses a pipe rather than reading EOF as an answer, and writes nothing until every question is answered. Both surfaces share one `ghost.db`, so a REPL session is the same row the browser sidebar lists.

### Where things live

Everything under `~/.ghostai`, or `$GHOSTAI_HOME`:

| Path                       | What                                                                                 |
| -------------------------- | ------------------------------------------------------------------------------------ |
| `config.json`              | The settings tree. **Safe to commit** — credentials are never in it.                 |
| `ghost.db`                 | Sessions, messages, turn stats, auth, login throttling, notifications, approvals.    |
| `vault.json` + `vault.key` | The encrypted credential vault. The key moves to the OS keychain when there is one.  |
| `workspace/`               | The only tree the agent's file tools can reach. Named workspaces are subdirectories. |
| `toolboxes/`               | Installed toolbox manifests — beside the workspace, never inside it.                 |
| `agents/`, `shared/`       | Per-agent and per-workspace state. Also outside the jail, on purpose.                |

---

## What you get

**A web UI** — chat with streaming answers, a collapsible reasoning block, a card per tool call with live progress, approval prompts showing the arguments before the call runs, and subagent runs nested inside the card that started them. Plus a file browser and editor, multiple workspaces, an agent editor, provider setup with live connection testing, and a context inspector that shows exactly what would be sent to the model and where the window went. Dark, light and system themes, all held to WCAG AA by a test that parses the real stylesheet. See [Web UI](docs/web-ui.md).

**A CLI** — `ghost chat` as a one-shot, a pipe target or a REPL with slash commands for sessions, branching, editing, regeneration, workspaces and context. `ghost serve`, `ghost init`, `ghost toolbox`.

**An API** — REST and WebSocket on the same port, with an OpenAPI 3.1 document generated from the same Zod schemas the server validates against, served at `/api/openapi.json`. See [API](docs/api.md).

---

## How it works

```
protocol → core → { security, providers } → tools → agent → runtime → server → cli
```

Packages may only depend downward, and that is enforced mechanically rather than by review: pnpm's isolated `node_modules` means a package can only resolve `@ghostai/x` if it declares it, so an undeclared import fails to _resolve_, not merely to lint.

A turn is an async generator. The caller drives it with `for await`; abandoning the iterator unwinds the turn through the same `finally` as an abort. Each iteration drains any steering the operator typed, rebuilds the small runtime half of the prompt, streams from the provider, and either finishes or runs the tool calls it got back. One `AbortSignal` threads from the HTTP request through the loop, the provider fetch, the tool and any child process — there is no second cancellation mechanism.

Two invariants are worth knowing because they explain the rest: **history is append-only**, because a provider's prompt cache keys on an exact prefix, so only a suffix is ever dropped; and **a denied or cancelled tool call still gets a `tool` message**, because providers reject an assistant turn whose `tool_calls` went unanswered.

[Architecture](docs/architecture.md) has the whole picture.

---

## Security posture

| Guard                   | What it stops                                                                                                                                                                                                     |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Workspace jail**      | Path traversal. The workspace is a root: `/etc/passwd` addresses `<workspace>/etc/passwd`. Paths are rebuilt, then `realpath`'d, so an inside symlink pointing out is caught.                                     |
| **Argv-only exec**      | Command injection. `execFile` with `shell: false`; a lint rule fails the build on `shell: true`. No metacharacter deny-list — with no shell, there is no string to interpret.                                     |
| **Toolboxes**           | Blast radius. A digest-pinned container plus its whole policy, authorised by manifest hash. Caps dropped, root read-only, network mode capped by the manifest.                                                    |
| **Per-tool permission** | An agent doing something you did not enable. Absent means not enabled; `ask` means the operator sees the arguments first.                                                                                         |
| **`guardedFetch`**      | SSRF and DNS rebinding. Resolved addresses are pinned into the dispatcher, so there is no second lookup to differ from the first. Every redirect re-validated; credentials dropped on origin change.              |
| **Nonce fencing**       | Prompt injection. Every tool result is wrapped in a delimiter carrying a fresh per-turn nonce, and the prompt says everything inside is inert. Detection raises a badge and passes content through byte-for-byte. |
| **Credential vault**    | Key theft at rest. AES-256-GCM, `0600`, key in the OS keychain. Write-only over HTTP — nothing reads a credential back out.                                                                                       |
| **Auth**                | Guessing. argon2id, and two asymmetric throttle scopes so a botnet cannot spread its attempts out. Wrong username and wrong password give the same answer in the same time.                                       |

[Security](docs/security.md) explains each one and states its limits — including the one that matters: a workspace is an organisational boundary, not a security boundary, wherever host `exec` is enabled. That is what toolboxes are for.

---

## Configuration

One JSON file, `~/.ghostai/config.json`. A missing file is normal — the schema produces a complete tree from `{}`. Every key has a documented default; [Configuration](docs/configuration.md) is the full reference.

```json
{
  "agents": {
    "defaults": { "provider": "ollama-gpu", "model": "qwen3:8b" },
    "list": {
      "researcher": {
        "label": "Researcher",
        "tools": { "read_file": "allow", "write_file": "allow", "exec": "allow" },
        "toolbox": { "name": "web-research", "network": { "mode": "open" } }
      }
    }
  },
  "providers": {
    "ollama": { "type": "ollama" },
    "ollama-gpu": { "type": "ollama", "label": "GPU box", "apiBase": "http://gpu.lan:11434/v1" }
  },
  "server": { "host": "127.0.0.1", "port": 3000 }
}
```

`providers` is keyed by an **instance id you choose**, with `type` naming a registry entry — which is how two Ollama servers become two entries. API keys are not in this file; they go to the vault under the same instance id, so the two entries above can hold different tokens.

Every key under `agents.defaults` is overridable per agent, and `agents.list.<id>` also carries the prompts, the tool permission map, the toolbox and the subagent list.

---

## Roadmap

The wire schemas, config blocks and seams for these already ship — which is why they appear in the settings tree and the UI. The implementations do not. [`docs/ROADMAP.md`](docs/ROADMAP.md) tracks them, one line each.

| Feature                    | Ships today                                                         | Missing                                      |
| -------------------------- | ------------------------------------------------------------------- | -------------------------------------------- |
| **MCP client**             | Config for all three transports, OAuth, `ToolSource: 'mcp'`         | The client, lifecycle and tool bridge        |
| **Memory**                 | The tuning keys, `lastConsolidatedSeq`, the prompt contributor seam | The store, retrieval and consolidation pass  |
| **Skills**                 | `pinnedSkills`, `maxPinnedSkills`                                   | The on-disk format, loader and prompt budget |
| **RAG**                    | Embedder and chunking config, hybrid search constants               | The index, embedder client and retrieval     |
| **Heartbeat delivery**     | The decide/run/evaluate triad, as a scheduled job's payload         | `targets` reaching a channel. Needs Telegram |
| **Telegram**               | The `Channel` contract, `ChannelManager`, `TurnProjection`          | One adapter over the Bot API                 |
| **Plugins**                | Load specs, `allowUnverified`, `unregisterBySource`                 | Discovery, loader and manifest format        |
| **Browser slash commands** | The terminal's command table                                        | A shared table and the composer UI           |
| **Session search**         | Keyset pagination and filters                                       | Text search over message content             |

Two smaller ones, so nothing here reads as more finished than it is: only the `openai-chat` wire adapter exists, so `anthropic` is in the provider registry but reaches Anthropic through an OpenAI-compatible path rather than its native API; and the translation layer is complete while **English is the only shipped locale** — adding one is a folder plus a line.

---

## Contributing

`pnpm check` is **not** the CI gate — it misses `format:check`, the design token gates, `i18n:check`, `build`, coverage and e2e. The real gate is [`.github/workflows/ci.yml`](.github/workflows/ci.yml), and [Development](docs/development.md) walks through running all of it, plus the conventions, the coverage bars and the UI workflow.

## Documentation

| Page                                   | What                                                     |
| -------------------------------------- | -------------------------------------------------------- |
| [Architecture](docs/architecture.md)   | Packages, the turn, events, subagents, persistence       |
| [Configuration](docs/configuration.md) | Every config key, its type and its default               |
| [Prompts](docs/prompts.md)             | The three templates, placeholders, and the caching split |
| [Providers](docs/providers.md)         | The registry, instances, resolution, resilience          |
| [Tools & permissions](docs/tools.md)   | The built-ins, and who is allowed to call them           |
| [Toolboxes](docs/toolboxes.md)         | Container sandboxes, manifests and approval              |
| [Security](docs/security.md)           | Each guard, the attack it closes, and its limits         |
| [API](docs/api.md)                     | REST and WebSocket                                       |
| [Web UI](docs/web-ui.md)               | The screens and what they do                             |
| [Development](docs/development.md)     | The CI gate, conventions, coverage, the UI loop          |

## License

MIT
