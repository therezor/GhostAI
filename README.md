# GhostAI

A self-hosted, security-first AI agent written in TypeScript. One process, one port, one SQLite file.

- **Local-first models** — Ollama, LM Studio, llama.cpp, vLLM, or any OpenAI-compatible endpoint. Cloud providers (Anthropic, OpenAI, OpenRouter, Gemini) are opt-in.
- **Web UI** — React + Vite over a hand-written token layer, dark and dense, served by the same process as the agent.
- **Telegram bot** — the built-in chat channel; others arrive as plugins.
- **MCP client _and_ server** — connect to any MCP server, and expose GhostAI's own tools to other agents.
- **Security in the core** — encrypted credential vault, workspace jail, argv-only exec (never a shell), SSRF/DNS-rebinding guard, tool-output nonce wrapping, and per-tool approval prompts.
- **Extensible** — a versioned plugin SDK for tools, channels, providers, TTS/STT, and embedders.

> **Status: pre-alpha.** Phases 1 and 2 are complete. `ghost chat` runs a turn end to end from a terminal; `ghost serve` puts the REST API, the WebSocket and every channel in front of the same agent; and the browser UI has chat, settings, files and notifications, behind an end-to-end suite that drives a real server in a real browser in both colour schemes. Phase 3 is next. See [Build plan](#build-plan) below.

---

## Prerequisites

| Tool   | Version | Notes                                                                                 |
| ------ | ------- | ------------------------------------------------------------------------------------- |
| Node   | ≥ 22.11 | Uses the built-in `node:sqlite` module — no native SQLite dependency to compile       |
| pnpm   | ≥ 10    | `npm i -g pnpm`                                                                       |
| Ollama | any     | Optional, but needed to run the agent end to end. `ollama serve && ollama pull qwen3` |

## Getting started

```bash
pnpm install
pnpm check      # typecheck + lint + test
pnpm build
```

## Running it

`pnpm build` produces the `ghost` binary at `packages/cli/dist/index.js`. Link it (`pnpm --filter @ghostai/cli link --global`) or call it directly — the examples below use `ghost`.

### First run, from a browser

```bash
ghost serve
```

It starts even though nothing is configured, and prints a **one-time setup code**:

```
GhostAI is listening.

  URL        http://127.0.0.1:3000
  Auth       enabled
  Agent      not configured — add a provider in the UI, or run `ghost init`
  Workspace  /Users/you/.ghostai/workspace
  UI         /path/to/packages/web/dist

First run. Open the URL above and enter this one-time code:

      K7QF-2M9X-BW4T

  It works once, and stops working as soon as you set a password.
```

Open the URL, paste the code, and the wizard walks through a password, a provider and a model. The provider step fetches the model list from the endpoint itself, so on a machine running `ollama serve` the model question is a list rather than a text box.

Everything after the password is skippable. An install with no model still serves files, workspaces, settings and notifications — only chat is unavailable, and the composer says so and links to the panel that fixes it.

### First run, from a terminal

```bash
ghost init      # workspace, provider, model — same questions, no browser
ghost chat      # talk to it
```

`ghost init` needs a terminal; it refuses a pipe rather than reading EOF as an answer. Nothing is written until every question is answered.

### Where things live

Everything is under `~/.ghostai`, or `$GHOSTAI_HOME` if that is set:

| Path | What |
| ---- | ---- |
| `config.json` | The settings tree. Safe to commit — credentials are never in it. |
| `ghost.db` | Sessions, messages, auth and notifications. One SQLite file. |
| `vault.json` + `vault.key` | The encrypted credential vault. The key moves to the OS keychain when one is available. |
| `workspace/` | The only directory the agent's file tools can reach. |

### Useful flags

| Flag | Does |
| ---- | ---- |
| `--host` / `--port` | Override the bind. A non-loopback host with `server.auth.enabled: false` refuses to start. |
| `--password` | Set or rotate the login password without the wizard. Also read from `GHOSTAI_PASSWORD`. |
| `--home <dir>` | Use a different root, the same as `GHOSTAI_HOME`. Handy for a throwaway install. |
| `--ui <dir>` | Serve a UI built somewhere else. |

**Restart `ghost serve` after a UI build** — see [Working on the UI](#working-on-the-ui) for why.

### Providers

`config.providers` is keyed by an **instance id** you choose, with `type` naming one of the providers in the registry. The same type can appear more than once, which is how two Ollama servers are configured:

```json
{
  "agents": { "defaults": { "provider": "ollama-gpu", "model": "qwen3:8b" } },
  "providers": {
    "ollama": { "type": "ollama" },
    "ollama-gpu": {
      "type": "ollama",
      "label": "GPU box",
      "apiBase": "http://gpu.lan:11434/v1"
    }
  }
}
```

`agents.defaults.provider` names an instance, or `auto` to resolve one. API keys are not in this file — they go to the vault, keyed by the same instance id, so the two Ollama entries above can hold different tokens. A local endpoint may carry one too, for a model server behind an authenticating proxy.

A `config.json` written before instances existed is migrated on load and rewritten in place: each key keeps its name and gains the matching `type`, so credentials already in the vault keep resolving.

## Commands

| Command                               | Does                                                                               |
| ------------------------------------- | ---------------------------------------------------------------------------------- |
| `pnpm check`                          | The full gate: `typecheck`, `lint`, `test`. Run this before every commit.          |
| `pnpm typecheck`                      | `tsc -b` across all project references                                             |
| `pnpm lint` / `pnpm lint:fix`         | ESLint with type-aware rules                                                       |
| `pnpm format` / `pnpm format:check`   | Prettier                                                                           |
| `pnpm test` / `pnpm test:watch`       | Vitest                                                                             |
| `pnpm test:coverage`                  | Vitest with the per-package coverage gates enforced                                |
| `pnpm --filter @ghostai/e2e test:e2e` | Playwright against a real server, in both colour schemes. Needs `pnpm build` first |
| `pnpm build`                          | Turborepo build across the graph                                                   |
| `node scripts/gen-packages.mjs`       | Regenerate package manifests after changing the package graph                      |

---

## Repository layout

```
packages/
  protocol/      Zod schemas → types + JSON Schema. Zero runtime deps.
  core/          Canonical message types, MessageBus, SessionStore, Logger, Clock
  security/      CredentialVault, WorkspaceJail, guardedFetch, exec argv guard
  providers/     Provider registry table, wire adapters, withResilience()
  tools/         defineTool, ToolRegistry, built-in tools
  mcp/           McpHub (client) and McpServer (expose our tools)
  memory/        ContextBuilder, three-tier memory, skills, profiles
  rag/           Vector store, embedders, loaders, chunker, knowledge_search
  agent/         AgentLoop, SubagentManager, context contributors
  runtime/       Composition root: config → provider, jail, store, registry, loop
  scheduler/     Cron/interval automation service + heartbeat agent
  channels/      Channel contract, ChannelManager (Telegram in Phase 3)
  plugin-sdk/    Public plugin contract. Zero deps. Semver-frozen.
  plugin-host/   Discovery, manifest validation, lifecycle, capability gating
  server/        Fastify: REST, WebSocket hub, auth, static, OpenAPI
  web/           React SPA
  cli/           bin: `ghost`
plugins/         First-party plugins, published separately
examples/        Loopback channel, plugin template, MCP fixture server
scripts/         Repo tooling
```

### Layering

Packages may only depend downward:

```
protocol → core → { security, providers } → { tools, mcp, memory, rag } → agent → server → cli
```

This is enforced two ways, both mechanical:

1. **pnpm's isolated `node_modules`.** A package can only resolve `@ghostai/x` if it declares it in `dependencies`. The manifests _are_ the layer graph — an undeclared import fails to resolve, not merely to lint.
2. **`no-restricted-imports`** bans deep relative imports (`../../*`) that would sneak across a package boundary.

The agent must never reach back into the HTTP server. Keep it that way.

---

## Conventions

- **ESM only.** `"type": "module"` everywhere, `.js` extensions in relative imports (NodeNext resolution).
- **`isolatedDeclarations` is on** everywhere except `protocol`. Every exported function needs an explicit return type; this keeps declaration emit fast and makes the public API surface reviewable in diffs. `protocol` is the one exception, because a Zod schema export _is_ an inference result and cannot carry a hand-written annotation without recreating the drift the schemas exist to prevent.
- **`tsup` owns the JavaScript, `tsc -b` owns the types.** `emitDeclarationOnly` keeps `tsc` from overwriting the bundle, and `clean: false` keeps `tsup` from deleting the declarations. `pnpm build` runs both, in that order. Delete `dist` to force a full rebuild.
- **Zod is the single source of truth** for config, wire messages, and tool parameters. Types come from `z.infer`; JSON Schema comes from `z.toJSONSchema`. Never hand-write a type that a schema could produce.
- **Errors are values, not strings.** Never branch on substrings of an error message. Return a typed discriminated union with a `kind` field.
- **One cancellation mechanism.** A single `AbortSignal` threads from the request through the loop, the provider fetch, tool execution, and any child process. No parallel `_running` flags or bespoke timeouts.
- **No shell, ever.** The exec tool takes `argv: string[]` and calls `execFile` with `shell: false`. A lint rule fails the build on `shell: true`.
- **No `Math.random()`.** Inject a generator so tests are deterministic; use `node:crypto` for anything security-relevant. Also lint-enforced.
- **Injected `Clock` and `fetch`.** Tests use fake timers and a mock dispatcher; nothing sleeps and nothing touches the network.

### Coverage gates

Enforced by `pnpm test:coverage`, blocking in CI:

| Package                     | Lines | Branches |
| --------------------------- | ----- | -------- |
| `security`                  | 95    | 95       |
| `core`                      | 90    | 85       |
| `agent`                     | 85    | 80       |
| `channels`                  | 90    | 85       |
| `server`                    | 85    | 80       |
| `providers`, `mcp`, `tools` | 80    | 75       |
| everything else             | 70    | 65       |

`security` carries the strictest bar because an untested branch there is a vulnerability, not just a bug.

---

## Build plan

The phase-by-phase build order, with the done-criterion for each step and the notes each completed step left for the ones after it, lives in [`docs/BUILD_PLAN.md`](docs/BUILD_PLAN.md).

Phase 1 — the agent working from a terminal — is done, and so is Phase 2: the Fastify server and the React web UI in front of it. Phase 3 adds the full provider table, the MCP client, memory and skills, and Telegram.

---

## Working on the UI

**There is no CSS framework.** `packages/web/src/styles/` is hand-written CSS in five cascade layers — `reset`, `base`, `layout`, `components`, `screens` — declared in that order at the top of `app.css`. A component names what it _is_ (`.tool-card`, `.sidebar__link`) and the stylesheet says what that looks like; `cn()` joins class names and nothing resolves conflicts, because a screen rule already beats a component rule by layer rather than by specificity.

`styles/tokens.css` is the vocabulary all of it is written in, and the only file allowed to contain a raw colour or a `px` literal. Three gates enforce that (`pnpm --filter @ghostai/web lint`), and `tokens/contrast.test.ts` resolves the sheet for both themes and holds every text-on-surface pairing to WCAG AA — so a seed edit that darkens text past the line fails the suite rather than shipping. `/tokens` in the running app renders every token and every primitive on one page, which is the fastest way to see what a change did.

Three more things worth knowing before the first hour is spent on any of them.

**Restart `ghost serve` after a UI build.** It enumerates the UI directory once, at boot (`@fastify/static` with `wildcard: false`), so a rebuild underneath a running server serves the new `index.html` and 404s its hashed assets into the SPA fallback. The result is a blank page that looks like a crash and is not one. For an edit-reload loop, run `pnpm --filter @ghostai/web dev` instead — the Vite dev server proxies `/api` and `/ws` to `ghost serve` on the default port.

**The end-to-end suite drives the built bundle**, so `pnpm build` is a precondition rather than a convenience:

```bash
pnpm build
pnpm --filter @ghostai/e2e exec playwright install chromium   # once
pnpm --filter @ghostai/e2e test:e2e
```

Every spec boots its own server in-process against a scripted model, so nothing reaches the network and nothing shares state. The colour scheme is a Playwright project, which means every assertion runs twice — reviewing only in dark is how a light theme ships broken.

The design-fidelity gate compares the shell's geometry and colour ramps against a checkout of the product being replaced. It is not in this repository and is not required: point `GHOSTAI_FIDELITY_ORIGINAL` at it to run the gate, and `pnpm --filter @ghostai/e2e baseline` to write the side-by-side captures. Without it the gate skips.

---

## License

MIT
