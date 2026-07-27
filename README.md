# GhostAI

A self-hosted, security-first AI agent written in TypeScript. One process, one port, one SQLite file.

- **Local-first models** — Ollama, LM Studio, llama.cpp, vLLM, or any OpenAI-compatible endpoint. Cloud providers (Anthropic, OpenAI, OpenRouter, Gemini) are opt-in.
- **Web UI** — React + Vite + Tailwind, dark and dense, served by the same process as the agent.
- **Telegram bot** — the built-in chat channel; others arrive as plugins.
- **MCP client _and_ server** — connect to any MCP server, and expose GhostAI's own tools to other agents.
- **Security in the core** — encrypted credential vault, workspace jail, argv-only exec (never a shell), SSRF/DNS-rebinding guard, tool-output nonce wrapping, and per-tool approval prompts.
- **Extensible** — a versioned plugin SDK for tools, channels, providers, TTS/STT, and embedders.

> **Status: pre-alpha.** The toolchain, `@ghostai/protocol` and `@ghostai/core` are done; the remaining packages are empty. See [Build order](#build-order) below.

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
  scheduler/     Cron/interval automation service + heartbeat agent
  channels/      Channel interface, ChannelManager, Telegram
  plugin-sdk/    Public plugin contract. Zero deps. Semver-frozen.
  plugin-host/   Discovery, manifest validation, lifecycle, capability gating
  server/        Fastify: REST, WebSocket hub, auth, static, OpenAPI
  web/           React SPA
  cli/           bin: `ghost`
plugins/         First-party plugins, published separately
examples/        Plugin template, MCP fixture server
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
| `providers`, `mcp`, `tools` | 80    | 75       |
| everything else             | 70    | 65       |

`security` carries the strictest bar because an untested branch there is a vulnerability, not just a bug.

---

## Build order

Each step below is a self-contained work session. Start a session by reading the design document, then the step here. **Every step ends with `pnpm check` passing.**

> **Design document:** `~/.claude/plans/i-want-you-to-crystalline-wind.md`
> It carries the full architecture, the interface signatures, the reference implementation to port behaviour from, and the rationale for each decision. Read the sections relevant to your step before writing code.

### Phase 1 — Vertical slice: the agent works from a terminal

<details open>
<summary><b>Step 1 — Scaffold</b> ✅ done</summary>

pnpm workspace, Turborepo, TypeScript project references, Vitest with coverage gates, ESLint with type-aware rules and layering enforcement, Prettier, CI across Linux/macOS/Windows.

**Done when:** `pnpm check` and `pnpm build` both pass. ✅
</details>

<details>
<summary><b>Step 2 — <code>@ghostai/protocol</code></b> ✅ done</summary>

Zod schemas and the types derived from them. No logic, no I/O.

- Config schema (the full settings tree: agent defaults, providers, tools, channels, RAG, scheduler, server).
- WebSocket message unions — `ClientMessage` and `ServerMessage` as discriminated unions with a `seq` on every streaming delta.
- REST DTOs.
- Automation job schema (`at` | `every` | `cron` schedules; `scheduled` | `heartbeat` payloads).
- `parseMentions()` — extracts `@kb:`, `@mcp:`, `@skill:` from message text. Lives here so every channel gets identical behaviour, not just the web UI.

**Done when:** every schema round-trips through `z.toJSONSchema`, `parseMentions` is unit-tested against quoted/unquoted/adjacent forms, and the package has zero runtime dependencies beyond `zod`. ✅

Notes for later steps:

- `isolatedDeclarations` is off in `packages/protocol/tsconfig.json` only. Zod schema exports are inference results, so the declaration emitter cannot type them (TS9010); the alternative is hand-writing a type beside every schema, which is the drift this package exists to remove. Every other package keeps the flag on.
- `PROTOCOL_SCHEMAS` is the registry of every exported schema. The round-trip test iterates it, and a reflection test fails if a module exports a `*Schema` that isn't registered — so `@ghostai/server` can hand the whole object to `@fastify/swagger` as the `$defs` pool.
- `providers` in the config tree is `Record<string, ProviderConfig>`. `@ghostai/providers` narrows it to `Record<ProviderId, ProviderConfig>` from its own `PROVIDERS` table, since protocol cannot depend on a package downstream of it.
- Automation schedule and payload variants are `strictObject`, not `object`. Key-stripping would silently drop a stray `atMs` from a cron schedule and run the job on the wrong trigger.

</details>

<details>
<summary><b>Step 3 — <code>@ghostai/core</code></b> ✅ done</summary>

The shared spine. No network, no `child_process`.

- Canonical `ChatMessage` union (`system` | `user` | `assistant` | `tool`) with content parts for text and images.
- `SessionStore` on `node:sqlite` (`DatabaseSync`, WAL). Messages append-only — never mutate history, so provider prompt caching stays warm.
- `findLegalStart()` — guarantees every `tool` message has a matching preceding `assistant.tool_calls`. Orphaned tool results cause provider 400s; this is the highest-value pure function in the repo.
- `historyForLLM()` — slice, align to a legal boundary, truncate tool output.
- `MessageBus` — `AsyncIterable` inbound/outbound queues with per-sender rate limiting.
- pino `Logger` with redaction paths, injectable `Clock`, path helpers, typed error taxonomy.

**Done when:** `findLegalStart` is property-tested with `fast-check` (no generated message array ever yields an orphaned tool result), the store survives a reopen with tool-call pairing intact, and coverage is ≥ 90/85. ✅ (97/94)

Notes for later steps:

- **`append` takes the schema's _input_ type**, so `toolCalls`, `isError` and `truncated` may be omitted and the schema fills them. Validation happens on write, which is where a malformed message is still attributable to the caller that produced it.
- **`seq`, not `createdAtMs`, is the message ordering.** Parallel tool results routinely land in the same millisecond, so time alone leaves their order arbitrary. `seq` is also the pagination cursor and never rewinds — `clearMessages()` deliberately leaves `next_seq` alone so a reconnecting client's stale cursor cannot start addressing different messages.
- **`lastConsolidatedSeq` is applied in SQL by `SessionStore.history()`**, which then passes `fromIndex: 0` to `historyForLLM`. Passing both would skip a second block of the same size.
- **Order inside `historyForLLM` is not interchangeable.** Trimming to the first `user` message can itself strand a `tool` result, so `findLegalStart` has to run after the trim, not before.
- **`SessionStore` accepts an existing `DatabaseSync`.** The scheduler, auth and the knowledge base share this one file; hand them the same connection so writes share a WAL and cross-table transactions are possible. A store given a connection never closes it.
- `foreign_keys` is per-connection and off by default in SQLite — a store opened on a borrowed connection re-enables it, but anything else opening one must do the same or deletes stop cascading.
- **`Clock` separates `now()` from `monotonic()`.** Anything measuring a _duration_ — the wall-clock cap, the tool heartbeat, rate-limit refill — must use `monotonic()`, or an NTP correction mid-turn corrupts it.
- **`RateLimiter` eviction is fail-open.** Past `MAX_TRACKED_SENDERS` the least-recently-used buckets are dropped, so a flood of distinct sender ids cannot lock out real users or grow the map without bound.
- Redaction is by _path_, so log structured context (`log.info({ tool }, 'executing')`) rather than interpolating into the message string, where nothing can reach it.

</details>

<details>
<summary><b>Step 4 — <code>@ghostai/security</code></b></summary>

The package that has to be right. Budget more time here than its size suggests.

- `WorkspaceJail` — resolve-and-verify with `realpath`; reject `..`, absolute paths, `~`, symlink escapes, UNC paths, NUL bytes.
- Tool-output nonce wrapping — per-turn `randomBytes(8)` delimiters, closing-tag escaping. Injection _detection_ is non-destructive: emit a notice, never silently replace the content.
- `guardedFetch` — `undici.Agent({ connect: { lookup } })` so validation and connection share one DNS resolution and the rebinding TOCTOU window closes. Reject private CIDRs across decimal, octal, hex, and IPv4-mapped-IPv6 encodings. Re-validate on redirect.
- Exec argv guard — `argv[0]` allow/deny list, jail every path-like argument, env allowlist, output byte caps.
- `CredentialVault` — AES-256-GCM, key from OS keychain with a `0600` keyfile fallback.

**Done when:** each of the five items has property tests covering the encoding/escaping bypass classes listed above, and coverage is ≥ 95/95.
</details>

<details>
<summary><b>Step 5 — <code>@ghostai/providers</code></b></summary>

- `ProviderSpec` type and the `PROVIDERS` registry table declared `as const satisfies readonly ProviderSpec[]`, so `type ProviderId = (typeof PROVIDERS)[number]['id']` and the config type derives from the table. Adding a provider must be a one-line table entry.
- The `openai-chat` wire adapter — this alone covers Ollama, LM Studio, llama.cpp, vLLM, OpenAI, OpenRouter, DeepSeek, and Groq.
- Typed `ProviderError { kind, retryable, status, param }`. Never sniff substrings of a response.
- `withResilience()` — one decorator wrapping both streaming and non-streaming, with a declarative `DegradationStep[]`: drop `reasoning_effort` → drop `tool_choice` → strip images → truncate oldest turns. Plus retry with jitter and a stream→non-stream fallback on SSE parse failure.

**Done when:** the exported `providerConformance(makeProvider)` suite passes — parallel tool calls, streaming deltas, mid-stream abort, 429→retry→success, 400 `unsupported_param`→degrade→success, malformed SSE→non-streaming fallback, vision input, usage reporting — all driven by `undici.MockAgent` with no network access.
</details>

<details>
<summary><b>Step 6 — <code>@ghostai/tools</code></b></summary>

- `defineTool({ name, description, schema, annotations, execute })` — computes JSON Schema once via `z.toJSONSchema`, implements `parseArgs` with `safeParse`, and infers the `execute` argument type from the schema.
- `ToolRegistry` — source-tagged registration (`builtin` | `mcp` | `plugin`), `unregisterBySource()` for exact teardown, memoized `definitions()` invalidated on mutation, and an `execute()` that validates, enforces timeout and signal, truncates, and never throws.
- Built-ins: `read_file`, `write_file`, `edit_file`, `list_dir`, `exec`.

`exec` takes `argv: string[]` — not a command string — and runs `execFile` with `shell: false`.

**Done when:** `toolConformance(tool)` passes for every built-in (schema round-trip, rejects wrong-typed and extra args, coerces LLM string-numbers, honours `signal` within 100 ms, respects `maxResultChars`), and every filesystem tool is jailed.
</details>

<details>
<summary><b>Step 7 — <code>@ghostai/agent</code></b></summary>

The loop, as an async generator emitting a single `AgentEvent` discriminated union that serialises 1:1 onto the WebSocket later.

- Static/runtime system-prompt split: build the static half once, rewrite `messages[0]` each iteration with the runtime block appended. Keeps prompt caching warm.
- One nonce per turn; tool definitions computed once per turn, not per iteration.
- Iteration cap and wall-clock cap, checked at the top of each iteration.
- Tool execution with a heartbeat `tool_progress` event every 15 s while a tool runs.
- Head+tail truncation of tool results at 8k chars.
- Steering queue drained at the top of each iteration — and if an injection arrives _during_ a final answer, continue the loop rather than breaking.
- Error responses are not persisted to history; a poisoned turn must not poison the session.
- One `AbortSignal`, threaded all the way to `child.kill()`.

**Done when:** the loop is tested with fake timers (no real sleeping) for the iteration cap, wall-clock cap, heartbeat cadence, and mid-tool abort; and coverage is ≥ 85/80.
</details>

<details>
<summary><b>Step 8 — <code>@ghostai/cli</code></b></summary>

`commander` with lazy-imported subcommands, so `ghost --help` never loads the agent. Ship `ghost chat` first — a terminal renderer for the `AgentEvent` stream.

**Phase 1 done when:** `ghost chat` against local Ollama completes a turn involving multiple tool calls; the session persists and reloads with tool-call pairing intact; `Ctrl-C` mid-tool kills the child process and exits cleanly.
</details>

### Later phases

Detailed in the design document. Each is independently shippable:

| Phase | Scope                                                                                        |
| ----- | -------------------------------------------------------------------------------------------- |
| **2** | Fastify server, auth, WebSocket protocol, React web UI, Telegram bot                         |
| **3** | Full provider table, remaining wire adapters, MCP client, memory/skills/profiles/subagents   |
| **4** | Plugin SDK and host, install/uninstall from the UI, WhatsApp and Discord as external plugins |
| **5** | Automation scheduler, RAG knowledge base, MCP server mode                                    |
| **6** | Threat-model regression suite, sandboxed plugins, Docker, `ghost doctor`                     |

**Run the native-module and embedding spike during Phase 1, not Phase 5** — it is the highest-risk dependency work and must not surface late.

---

## License

MIT
