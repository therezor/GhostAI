# GhostAI

A self-hosted, security-first AI agent written in TypeScript. One process, one port, one SQLite file.

- **Local-first models** — Ollama, LM Studio, llama.cpp, vLLM, or any OpenAI-compatible endpoint. Cloud providers (Anthropic, OpenAI, OpenRouter, Gemini) are opt-in.
- **Web UI** — React + Vite + Tailwind, dark and dense, served by the same process as the agent.
- **Telegram bot** — the built-in chat channel; others arrive as plugins.
- **MCP client _and_ server** — connect to any MCP server, and expose GhostAI's own tools to other agents.
- **Security in the core** — encrypted credential vault, workspace jail, argv-only exec (never a shell), SSRF/DNS-rebinding guard, tool-output nonce wrapping, and per-tool approval prompts.
- **Extensible** — a versioned plugin SDK for tools, channels, providers, TTS/STT, and embedders.

> **Status: pre-alpha.** Phase 1 is complete — `ghost chat` runs a turn end to end from a terminal — and Phase 2 is nearly there: `ghost serve` puts the REST API, the WebSocket and every channel in front of the same agent, and the browser UI has chat, settings, files and notifications. What is left is the end-to-end and design-fidelity gate. See [Build plan](#build-plan) below.

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

## Commands

| Command                             | Does                                                                      |
| ----------------------------------- | ------------------------------------------------------------------------- |
| `pnpm check`                        | The full gate: `typecheck`, `lint`, `test`. Run this before every commit. |
| `pnpm typecheck`                    | `tsc -b` across all project references                                    |
| `pnpm lint` / `pnpm lint:fix`       | ESLint with type-aware rules                                              |
| `pnpm format` / `pnpm format:check` | Prettier                                                                  |
| `pnpm test` / `pnpm test:watch`     | Vitest                                                                    |
| `pnpm test:coverage`                | Vitest with the per-package coverage gates enforced                       |
| `pnpm build`                        | Turborepo build across the graph                                          |
| `node scripts/gen-packages.mjs`     | Regenerate package manifests after changing the package graph             |

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

Phase 1 — the agent working from a terminal — is done. Phase 2 puts a Fastify server and a React web UI in front of it.

---

## License

MIT
