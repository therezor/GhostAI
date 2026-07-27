# GhostAI

A self-hosted, security-first AI agent written in TypeScript. One process, one port, one SQLite file.

- **Local-first models** — Ollama, LM Studio, llama.cpp, vLLM, or any OpenAI-compatible endpoint. Cloud providers (Anthropic, OpenAI, OpenRouter, Gemini) are opt-in.
- **Web UI** — React + Vite + Tailwind, dark and dense, served by the same process as the agent.
- **Telegram bot** — the built-in chat channel; others arrive as plugins.
- **MCP client _and_ server** — connect to any MCP server, and expose GhostAI's own tools to other agents.
- **Security in the core** — encrypted credential vault, workspace jail, argv-only exec (never a shell), SSRF/DNS-rebinding guard, tool-output nonce wrapping, and per-tool approval prompts.
- **Extensible** — a versioned plugin SDK for tools, channels, providers, TTS/STT, and embedders.

> **Status: pre-alpha.** Phase 1 is complete — `ghost chat` runs a turn end to end from a terminal, through `protocol`, `core`, `security`, `providers`, `tools`, `agent` and `cli`. Everything from the server and the web UI onward is still empty. See [Build order](#build-order) below.

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
<summary><b>Step 4 — <code>@ghostai/security</code></b> ✅ done</summary>

The package that has to be right. Budget more time here than its size suggests.

- `WorkspaceJail` — resolve-and-verify with `realpath`; reject `..`, absolute paths, `~`, symlink escapes, UNC paths, NUL bytes.
- Tool-output nonce wrapping — per-turn `randomBytes(8)` delimiters, closing-tag escaping. Injection _detection_ is non-destructive: emit a notice, never silently replace the content.
- `guardedFetch` — `undici.Agent({ connect: { lookup } })` so validation and connection share one DNS resolution and the rebinding TOCTOU window closes. Reject private CIDRs across decimal, octal, hex, and IPv4-mapped-IPv6 encodings. Re-validate on redirect.
- Exec argv guard — `argv[0]` allow/deny list, jail every path-like argument, env allowlist, output byte caps.
- `CredentialVault` — AES-256-GCM, key from OS keychain with a `0600` keyfile fallback.

**Done when:** each of the five items has property tests covering the encoding/escaping bypass classes listed above, and coverage is ≥ 95/95. ✅ (99.8/98)

Notes for later steps:

- **`toolOutputPolicy(nonce)` belongs in the _runtime_ half of the system prompt**, not the static half. The nonce changes every turn, so putting it in the cached block would invalidate the prefix on every iteration — the exact thing the static/runtime split in Step 7 exists to avoid.
- **`wrapToolOutput` returns findings; it never edits the content.** The agent loop maps them onto the `notice` event (`kind: 'prompt_injection'`) via `describeInjectionFindings`. Nothing else may act on a finding — the delimiters are the defence, the finding is only a badge.
- **The jail rejects absolute paths as _inputs_.** Tool schemas must therefore document paths as workspace-relative, and error text should say so. `contains()` skips canonicalisation and is for paths GhostAI produced itself (the media route in Phase 2); agent input goes through `check`/`resolve`.
- **`guardExec` validates every argument, not just the path-shaped ones** — `cat notes.txt` where `notes.txt` symlinks to `/etc/shadow` is the case a separator heuristic misses. It returns a plan and never spawns: `@ghostai/tools` owns the `execFile` call, and `plan.paths` is what the approval prompt should display.
- **`guardedFetch` is for model-directed egress.** Provider base URLs are operator config, not model input, and a local model server is loopback — so `@ghostai/providers` either uses its own dispatcher or passes `allowLoopback`/`allowedHosts`. Blocking a provider call as SSRF would be the guard misfiring on the one host it is meant to trust.
- **`parseIpLiteral` returning `null` is what earns a host a DNS lookup.** Anything that resolves numerically — decimal, octal, hex, short form, IPv4-mapped — is classified as an address first. Any new egress path must go through `validateTarget` rather than re-deriving this.
- The vault is synchronous and single-file, and refuses to start on a failed authentication tag rather than reporting an empty vault — a "recovered" empty vault would be overwritten by the next `set`.

</details>

<details>
<summary><b>Step 5 — <code>@ghostai/providers</code></b> ✅ done</summary>

- `ProviderSpec` type and the `PROVIDERS` registry table declared `as const`, so `type ProviderId = (typeof PROVIDERS)[number]['id']` and the config type derives from the table. Adding a provider is a table entry.
- The `openai-chat` wire adapter — this alone covers Ollama, LM Studio, llama.cpp, vLLM, OpenAI, OpenRouter, DeepSeek, Groq, xAI and Gemini's compatibility endpoint.
- Typed `ProviderError { kind, retryable, status, param }`. Never sniff substrings of a response.
- `withResilience()` — one decorator wrapping both streaming and non-streaming, with a declarative `DegradationStep[]`: drop `reasoning_effort` → drop `tool_choice` → strip images → truncate oldest turns. Plus retry with jitter and a stream→non-stream fallback on SSE parse failure.

**Done when:** the exported `providerConformance({ create })` suite passes — parallel tool calls, streaming deltas, mid-stream abort, 429→retry→success, 400 `unsupported_param`→degrade→success, context length→truncate→success, malformed SSE→non-streaming fallback, vision input, tool-result round-trip, usage reporting — with no network access. ✅ (98/93, suite run against `ollama`, `openai` and `openrouter`)

Notes for later steps:

- **`as const satisfies readonly ProviderSpec[]` is unavailable here**: `isolatedDeclarations` cannot emit a declaration for it (TS9010). The table is therefore `as const` under a private name for the literal types `ProviderId` needs, and `PROVIDERS` is the same array exported as `readonly ProviderSpec[]` — which is also the assignment that type-checks every entry, and the view to read, since on the literal type an entry that omits `isGateway` has no such property.
- **`ChatRequest`'s optional fields are `?: T | undefined`**, deliberately against `exactOptionalPropertyTypes`. The degradation ladder exists to _remove_ parameters, and `{ ...request, reasoningEffort: undefined }` has to be expressible; the alternative is a destructure-and-rebuild that silently drops any field added later.
- **A stream that has already emitted a delta is never retried or degraded.** Restarting it would replay text the user is reading. The SSE→non-streaming fallback is subject to the same rule — it only fires when the stream failed before saying anything.
- **A degradation does not spend the retry budget and does not sleep.** It is a repair, not a transient failure; the ladder is finite because each step removes something the request carried and so cannot fire twice.
- **The ladder fires on a bare `400` as well as on `unsupported_param`.** Local inference servers return no `code` and no `param`, and dropping a parameter the request actually carried is safe either way — against a genuinely malformed request the ladder runs out and the original error surfaces.
- **Provider base URLs deliberately bypass `guardedFetch`.** That guard stops the _model_ choosing a destination; a base URL is operator config and the common case is loopback. What `assertUsableApiBase` enforces instead is narrower and real: an API key never goes over plain HTTP to a public address, classified through `parseIpLiteral`/`classifyAddress` so `http://134744072/` is caught too.
- **`ProviderError extends GhostError`**, so a failure reaching the agent loop keeps a `kind` from the core taxonomy and `toGhostError` cannot downgrade it to `internal`. The finer `reason` is what the ladder switches on. This required widening `GhostError.name` to `string` so a subclass can name itself.
- **The conformance suite lives in `src/testkit/` and is not exported from `index.ts`** — it imports `vitest`, and shipping that in the package entry would put a test framework in the runtime graph. Adapters import it relatively. Its fixtures are `openai-chat` shaped; when a second wire lands, the scenarios stay and the response builders move behind a per-wire fixture interface.
- **Adapters take an injected `fetchImpl`, and optionally a `dispatcher`.** Injection is what makes a truncated event stream or an abort mid-delta a one-line fixture; the `dispatcher` hook covers `ProxyAgent` and lets two tests drive the real `undici.fetch` through a `MockAgent`, so the default transport is covered too.
- **`estimateTokens` is a character heuristic and `loadTokenCounter()` is async.** `gpt-tokenizer` costs ~40 ms and ~50 MB at import; paying that at module load would charge every consumer of this package for a table used on the failure path.
- The `anthropic` entry declares `wire: 'anthropic-messages'`, and `createProvider` refuses it with a `config` error naming the wire. Pointing it at `/chat/completions` would surface as a 404 mid-turn, which reads as "the model is gone".
- `scripts/gen-packages.mjs` now carries per-package `compilerOptions` and `tsconfigNotes`, so re-running it no longer deletes `protocol`'s `isolatedDeclarations: false` override or the comment explaining it.

</details>

<details>
<summary><b>Step 6 — <code>@ghostai/tools</code></b> ✅ done</summary>

- `defineTool({ name, description, schema, annotations, execute })` — computes JSON Schema once via `z.toJSONSchema`, implements `parseArgs` with `safeParse`, and infers the `execute` argument type from the schema.
- `ToolRegistry` — source-tagged registration (`builtin` | `mcp` | `plugin`), `unregisterBySource()` for exact teardown, memoized `definitions()` invalidated on mutation, and an `execute()` that validates, enforces timeout and signal, truncates, and never throws.
- Built-ins: `read_file`, `write_file`, `edit_file`, `list_dir`, `exec`.

`exec` takes `argv: string[]` — not a command string — and runs `execFile` with `shell: false`.

**Done when:** `toolConformance(tool)` passes for every built-in (schema round-trip, rejects wrong-typed and extra args, coerces LLM string-numbers, honours `signal` within 100 ms, respects `maxResultChars`), and every filesystem tool is jailed. ✅ (99/97)

Notes for later steps:

- **`z.toJSONSchema` is called with `io: 'input'`.** The default output view lists any field carrying `.default()` as `required` — it is always present once parsing has run — so advertising it tells the model to supply every optional argument, and it obliges by inventing values. Any future schema-to-tool path (MCP proxying, plugin tools) has to pass the same flag.
- **A tool schema must be a `z.strictObject`, checked at definition time.** `z.object` strips unknown keys, so a model that adds `recursive: true` to `read_file` would have its mistake silently discarded and get an answer to a question it did not ask. `defineTool` refuses a schema whose emitted `additionalProperties` is not `false`.
- **Numbers coerce, booleans deliberately do not.** `z.coerce.number()` is what makes the `"10"` models routinely emit work. `z.coerce.boolean()` is `Boolean(value)` and turns `"false"` into `true` — on `edit_file.replaceAll` that inverts the model's stated intent, so booleans stay strict.
- **Built-ins are exported as `AnyTool`, not their inferred type.** `isolatedDeclarations` cannot emit a declaration for an inference result, and hand-writing an interface beside every schema is the drift `defineTool` exists to remove. Inference still applies inside `execute`, which is where it matters. The same rule made `no-inferrable-types` conflict with an exported `RegExp`; the rule is now off repo-wide, since `isolatedDeclarations` is a build requirement and it is a preference.
- **`definitions()` is sorted by name, in code-unit order.** Tool definitions live in the prompt prefix providers cache; an MCP server reconnecting and re-registering in a different order would rewrite that prefix for no semantic change. `localeCompare` would make the same prefix differ between a developer's machine and the container.
- **`ToolRegistry.execute` races the handler against the timeout rather than only signalling it.** A handler that ignores its signal would otherwise hang the turn forever. Racing cannot unwind work already in flight, which is why every built-in also checks the signal and why `exec` hands it to the child. The late rejection of the losing promise is swallowed deliberately — without that, a timed-out tool takes the process down.
- **`AbortSignal.aborted` is read through a function (`isAborted`).** TypeScript narrows the property after an early `if (signal.aborted) return`, and then reports every later check in the same function as dead code — on the one value whose purpose is to change while the function runs.
- **`exec` uses `spawn`, not `execFile`.** Both are `shell: false`; what differs is overflow. `execFile`'s `maxBuffer` kills the child and discards everything it wrote, so a build logging 2 MB returns nothing. Streaming into `createOutputCap` — which `@ghostai/security` exports for exactly this — keeps the head and lets the command finish.
- **A non-zero exit is a result, not a thrown failure.** `grep` finding nothing exits 1 and a failing compiler is the answer that was asked for; both come back with `isError` set and the output intact. The model's `timeoutMs` may lower the operator's cap but never raise it.
- **Filesystem errors are re-described against the workspace-relative path** (`fsFailure`). A raw `ENOENT … '/Users/x/.ghostai/workspace/notes.md'` teaches the model to send absolute paths back, which the jail then rejects. A `GhostError` passes through untouched so `jail_escape` is never downgraded.
- `toolConformance` lives in `src/testkit/` and is not exported from `index.ts`, for the same reason as the provider suite: it imports `vitest`. Its cases are derived from the tool's own JSON Schema, so a tool that gains a numeric argument gains its coercion test automatically.
- `registerBuiltins` omits `exec` when config disables it. A disabled tool the model can still see costs it a turn to discover.

</details>

<details>
<summary><b>Step 7 — <code>@ghostai/agent</code></b> ✅ done</summary>

The loop, as an async generator emitting a single `AgentEvent` discriminated union that serialises 1:1 onto the WebSocket later.

- Static/runtime system-prompt split: build the static half once, rewrite `messages[0]` each iteration with the runtime block appended. Keeps prompt caching warm.
- One nonce per turn; tool definitions computed once per turn, not per iteration.
- Iteration cap and wall-clock cap, checked at the top of each iteration.
- Tool execution with a heartbeat `tool_progress` event every 15 s while a tool runs.
- Head+tail truncation of tool results at 8k chars.
- Steering queue drained at the top of each iteration — and if an injection arrives _during_ a final answer, continue the loop rather than breaking.
- Error responses are not persisted to history; a poisoned turn must not poison the session.
- One `AbortSignal`, threaded all the way to `child.kill()`.

**Done when:** the loop is tested with fake timers (no real sleeping) for the iteration cap, wall-clock cap, heartbeat cadence, and mid-tool abort; and coverage is ≥ 85/80. ✅ (100/95.9)

Notes for later steps:

- **`AgentEvent` _is_ `ServerMessage` minus the fields the transport owns** — `seq`, and `sessionKey` on the events that carry one. The names are the protocol's dotted names, and `events.test.ts` parses every event through `ServerMessageSchema` with a `seq` stamped on, so the WS hub in Phase 2 is a `seq` counter and a forward, not a mapping table. A field renamed on either side fails that test.
- **Truncate first, wrap second — never the reverse.** Truncating a wrapped envelope cuts off the closing delimiter, and the model then reads the rest of the conversation as tool output. For the same reason the loop passes `maxToolResultChars: 0` to `SessionStore.history()`: stored results were already truncated at write time, and re-truncating them would cut the delimiter off history.
- **A `tool.result` event carries the tool's own output; history carries the envelope.** The delimiters exist to tell a language model which region of its context is inert; rendering them in a tool card would be displaying a defence mechanism as part of the answer.
- **Every tool call gets a `tool` message, including one that never ran.** Providers reject an `assistant` turn whose `tool_calls` were not all answered, so a Ctrl-C mid-tool that wrote no result would fail the _next_ turn, on history the user cannot see. The assistant message and all of its results are appended in one `appendMany` transaction, since a partial write is exactly the orphaned-tool-result state `findLegalStart` then has to repair on every later request.
- **`max_iterations` and `wall_timeout` persist an explanation; an error persists nothing.** The next turn has to know the task stopped half-done, or the model reads its own truncated work as complete — but a provider 400 written into the transcript is replayed on every subsequent request, so one bad turn would poison the session permanently.
- **`turn.start` is yielded inside the `try`.** A caller that abandons the iterator before the first iteration still runs the cleanup that clears the session's steering queue.
- **The loop owns the heartbeat cadence; `ToolRegistry` owns the tool timeout.** Enforcing a deadline in both places is how one call ends up with two of them. The heartbeat is a race against the injected clock, so a test advances time instead of waiting 15 s.
- **`ContextContributor` is the seam Phase 3 arrives through.** `staticSection` is called once per turn, may do I/O, and must return the same text for the life of the session — anything that varies hands back the cache benefit the split was built for. `runtimeSection` is synchronous and runs every iteration, so it is the wrong place for I/O. The loop never imports `@ghostai/memory`.
- The steering queue is bounded (16 per session) and drops the **oldest** on overflow: the newest correction is the one the user is waiting on.
- `zod` is a `devDependency` here only — the tests define tools with `defineTool`. Nothing in the runtime graph of this package imports it.

</details>

<details>
<summary><b>Step 8 — <code>@ghostai/cli</code></b> ✅ done</summary>

`commander` with lazy-imported subcommands, so `ghost --help` never loads the agent. Ship `ghost chat` first — a terminal renderer for the `AgentEvent` stream.

- `runTurn` — the whole of what the CLI does with the event stream, over one `AbortSignal` per turn.
- Three drivers over it: a message argument, a piped stdin, and a `readline` prompt with `/help`, `/clear`, `/session`, `/exit`.
- `createChatRuntime` — the composition root: config → provider, jail, store, registry, loop.
- `loadConfig` landed in `@ghostai/core`, where `protocol/config.ts` always said load-time normalisation belongs.

**Phase 1 done when:** `ghost chat` against local Ollama completes a turn involving multiple tool calls; the session persists and reloads with tool-call pairing intact; `Ctrl-C` mid-tool kills the child process and exits cleanly. ✅ (96/88, all three verified against the built binary and a scripted OpenAI-compatible server on loopback rather than Ollama itself)

Notes for later steps:

- **`ghost --help` imports nothing from `@ghostai/*` at module scope** — only `commander` and types, which erase. `@ghostai/core` alone pulls pino, zod and `node:sqlite`; even `isGhostError` is imported inside the `catch` that needs it, on a path that has already failed. `tsup` ESM code splitting makes the subcommand a real second chunk, so this is checkable in `dist/` rather than a matter of intent.
- **`runCli` returns an exit code and never calls `process.exit`.** `exit` tears the process down with whatever is still buffered on stdout unwritten, and on a piped `ghost chat` that is the answer. `process.exitCode` and a natural drain is the whole of the bin.
- **The outcome of a turn is read off `turn.end`, not re-derived from the signal.** A provider that aborts for its own reasons is still an interrupted turn, and inferring it from `signal.aborted` reports that one as a clean success. `stopReason` is the loop's word for it and every other transport will have the same field.
- **`agents.defaults.workspace` now defaults to `''`, meaning `<root>/workspace`.** It previously defaulted to the literal `~/.ghostai/workspace`, which restates the _default_ root — so an install relocated with `GHOSTAI_HOME` kept its workspace under the home directory and pointed the agent's filesystem tools at a tree the operator thought they had moved. Anything else reading a path out of config must resolve it against the root, never against the process working directory.
- **`removeNodeProtocol: false` in every `tsup.config.ts`.** tsup rewrites `node:sqlite` to `sqlite` by default — a compatibility shim for node older than 14.18 — and `node:sqlite` has no unprefixed form, so the published bundle was unloadable. Nothing caught it until the CLI became the first package that _runs_ its own `dist/`. The default flips in tsup 9.
- **Ctrl-C during a turn belongs to the turn; at an idle prompt it means leave.** One `AbortController` per turn, replaced each time — an aborted one cannot be reset, and reusing it would stop every later turn before its first iteration. `rl.question` is cancelled with an `AbortSignal` rather than `rl.close()`, which leaves a pending question unsettled forever and hangs the process on the very Ctrl-C meant to end it.
- **The renderer never prints the nonce envelope.** `tool.result` carries the tool's own output for exactly that reason. Any future channel renderer inherits the same rule.
- **`GhostPaths` gained `vaultFile`.** The vault had a key-file path and nowhere to put the ciphertext.
- The credential order is vault → environment, and the vault is not opened at all for a local provider with no `envKey` — `resolveVaultKey` writes a key to the OS keychain the first time it runs, and `ghost chat` against Ollama must not create one.
- Provider resolution is `resolveProvider`'s order plus exactly one CLI step after its `null`: a provider whose `envKey` is exported. Beyond that it refuses to guess and prints what to set.

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
