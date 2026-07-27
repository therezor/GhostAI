# Build plan

Each step below is a self-contained work session. Start a session by reading the design document, then the step here. **Every step ends with `pnpm check` passing.**

> **Design document:** `~/.claude/plans/i-want-you-to-crystalline-wind.md`
> It carries the full architecture, the interface signatures, the reference implementation to port behaviour from, and the rationale for each decision. Read the sections relevant to your step before writing code.

## Phase 1 — Vertical slice: the agent works from a terminal

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

## Phase 2 — The agent works from a browser

Phase 1 left the agent reachable only from a terminal. Phase 2 puts an HTTP server and a web UI in front of it, and it starts from an unusual position: **the wire protocol already exists and is tested.** `@ghostai/protocol` carries the full `ClientMessage`/`ServerMessage` unions, ~30 REST DTOs, `ServerConfigSchema`, `AuthConfigSchema` and `isLoopbackHost()`, and `AgentEvent` is deliberately `ServerMessage` minus the fields the transport owns. This phase is implementation against a contract, not design.

The UI keeps the visual identity of the product it replaces — dark, dense, gold accent, Inter + JetBrains Mono, 17rem sidebar / 3.5rem header / 53.75rem chat column — rebuilt on a rem-based OKLCH token layer that ships light and dark from day one.

> **Phase 2 plan:** `~/.claude/plans/create-plan-for-phase-staged-beaver.md`
> It carries the full design-system specification (token tables, the component vocabulary, the interaction behaviours worth porting) and the reasoning behind each step below.

<details>
<summary><b>Step 9 — <code>@ghostai/runtime</code></b> ✅ done</summary>

`createChatRuntime` in `packages/cli/src/runtime.ts` is the only place a config file becomes a running agent, and it is CLI-shaped: one fixed model and provider, and a `close()` that closes the `SessionStore` it owns. The server needs the same wiring with a shared connection and the ability to reconfigure. Extract it rather than copy it.

- `createRuntime(options): GhostRuntime` — the existing body, plus an injectable `DatabaseSync` so the auth store, notifications and `SessionStore` share one WAL; a `ChatProvider` cache keyed by `(providerId, model, apiBase)`; and `reconfigure(patch)` that rebuilds the provider and re-registers builtins without dropping the store.
- No HTTP, no Fastify. Depends on `core`, `security`, `providers`, `tools`, `agent` and nothing above them.
- `packages/cli/src/runtime.ts` becomes a thin adapter over it.

**Done when:** the CLI's own tests still pass unchanged, and a second consumer can build a runtime over a borrowed connection without the first one closing it. ✅ (98/93, the CLI's 14 runtime tests unchanged)

Notes for later steps:

- **`reconfigure` replaces what a config produces and keeps what a runtime owns.** The store, the tool registry and the steering queue survive; the provider, the jail and the loop are rebuilt. It computes everything able to fail before it mutates anything, so an unknown provider or an unusable workspace throws while the runtime is still serving turns on the settings that worked a moment ago. It returns the merged `Config` and deliberately does **not** write `config.json` — previewing a patch and saving one are different operations, and Step 13 owns the second.
- **A turn already running keeps the loop it started on.** Its provider request is in flight and its tool definitions are already in the model's context; the hub in Step 12 does not need to serialise a settings save against a turn.
- **The credential is re-read on every build**, which is what makes "a key saved in the UI is usable on the next turn" (Step 18) true without a restart. It is folded into the provider cache key as a digest rather than in the clear — a map key ends up in a heap dump — so a new key is a new adapter, and the same key is the same pool.
- **The provider cache is bounded (8) and closes what it evicts.** `ChatProvider.close()` is undici's graceful close, so an eviction cannot cut off a turn still streaming through the adapter it evicted. A cache passed in by the caller is never cleared by `close()`; the caller owns its lifetime, exactly as with `database`.
- **A construction-time `provider`/`model` override outlives a reconfigure.** `ghost chat --model x` is a statement about that process, and a settings save from a browser must not move a terminal session onto another model. The server passes neither, so config drives everything there.
- **`ToolRegistry.timeoutMs` is now settable**, and it is the only mutable setting on a registry. Rebuilding the registry when `agents.defaults.toolTimeoutMs` changes would throw away every MCP and plugin registration on it — far more than the operator asked to change. A call already in flight keeps the timeout it started under.
- **`mergeConfigPatch` deep-merges the patch and re-parses through `ConfigSchema`.** Arrays replace (there is no patch syntax for a removal), and so do the records the UI edits as a unit — `REPLACE_WHOLESALE` names them, `providers.*.extraHeaders` being the one that exists today. An explicit `undefined` is "not mentioned", never a deletion.
- `scripts/gen-packages.mjs` now carries `devDeps`, so re-running it no longer deletes `agent`'s test-only `zod`.

</details>

<details>
<summary><b>Step 10 — Tool approval gate</b> ✅ done</summary>

The protocol declares this end to end — `ToolRisk`, `ToolApprovalPolicy` (`allow|ask|deny`), `ApprovalScope` (`once|session|always`), `ToolApprovalsConfig`, and the `tool.approvalRequest` / `tool.approve` pair — and nothing reads any of it. `AgentLoop` executes unconditionally after yielding `tool.call`. A browser-exposed agent with unattended `exec` is exactly what that config exists to prevent, so this lands before the WebSocket hub, not after.

- `approvals?: ApprovalGate` on `AgentLoopOptions`. An absent gate is today's behaviour, so the CLI is unaffected.
- The seam is between the `tool.call` yield and tool execution. On `ask`, yield `tool.approvalRequest` and await the gate.
- A denial still writes a `tool` message — every tool call gets one, including one that never ran, or the _next_ turn 400s on an unanswered `tool_calls` — plus a `notice` with `kind: 'approval_denied'`.
- Timeout and abort both resolve as denial. Scope memory belongs to the gate implementation, not the loop.

**Done when:** fake-timer tests cover allow / ask-approve / ask-deny / ask-timeout / abort-during-approval, history carries a `tool` message in every case, and coverage stays ≥ 85/80. ✅ (100/98.4)

Notes for later steps:

- **The loop decides whether to ask; the gate decides the answer.** Policy resolution is a pure function of the tool's risk band and `tools.approvals`, so no transport can forget to check and none can decide differently. Scope — `once | session | always` — is memory, and memory needs a session-shaped store and somewhere to persist `always`; both belong to the thing holding a connection to a human. The loop reads `decision.approved` and nothing else.
- **An absent gate means nobody is there to ask, so an `ask` policy runs the tool.** That is what keeps `ghost chat` unchanged — the operator who typed the message _is_ the approval. A `deny` policy is enforced with or without a gate, since refusing needs no one to answer. **Step 11's server must install a gate**, or the default `exec: ask` runs unattended behind a browser.
- **The loop owns the approval deadline**, for the same reason it owns the heartbeat and not the tool timeout: the case `expiresAtMs` exists for is a gate that never answers — a tab closed on an open prompt — and only the turn knows it is still waiting. The timer is on the injected clock.
- **A denial is an answer; an abort is not.** A denial writes a `tool` message and lets the turn continue, so the model can respond to it — the whole point of the refusal text is to stop a retry loop. An abort returns the same `cancelled` path as a mid-tool Ctrl-C, which ends the turn and answers every remaining call without asking about it. A gate that _rejects_ denies, except with an abort-shaped error; there is no failure of an approval mechanism whose safe reading is "go ahead".
- **`addEventListener('abort')` on an already-fired signal never runs**, so the approval watcher checks `signal.aborted` first. Without that, a turn cancelled in the window between the `tool.call` event and the decision would sit out the full five-minute deadline before noticing.
- `RuntimeOptions.approvals` passes a gate through to every loop the runtime builds and survives `reconfigure` — the gate belongs to the process, config only says which risk bands need asking about.

</details>

<details>
<summary><b>Step 11 — <code>@ghostai/server</code>: app, boot, auth</b> ✅ done</summary>

Fastify 5 on one port for the API, the WebSocket and the static UI.

- **Refuse to start** when the bind is non-loopback and auth is off. `isLoopbackHost()` is already written for this. A warning is not enough; the result would be an unauthenticated shell-capable agent on a LAN address.
- argon2id passwords, sessions in an `auth_sessions` table on the shared connection, `httpOnly; Secure; SameSite=Strict` cookie for browsers and `Bearer` for CLI/CI, `timingSafeEqual` on every token comparison, hard rate limiting on login.
- One error handler producing `ErrorResponse` for every non-2xx, with codes from the `ErrorCode` vocabulary. Never derive a code from a message substring.
- `@fastify/swagger` fed `PROTOCOL_SCHEMAS` as its `$defs` pool, so the OpenAPI document is generated and cannot drift from the routes.
- A **route manifest** — `{ method, url, auth }` — that the router registers _from_, so the auth test iterates it and a new route cannot be silently unauthenticated.

**Done when:** the table-driven `fastify.inject()` auth matrix passes over every manifest entry across five auth states, the boot refusal has a test, and login is rate-limited. ✅ (99.2/94.8, matrix over 5 routes × 5 states)

Notes for later steps:

- **There are two boot refusals, not one.** The second is authentication enabled with no password set. Starting anyway produces a server whose login can never succeed and whose every route answers 401 — which reads as a broken UI rather than as setup that was never finished. `createServer` takes a `password` option that sets or rotates the hash before the policy runs; reading `GHOSTAI_PASSWORD` and `--password` is deliberately the caller's job, so Step 14's `ghost serve` owns it and nothing here needs `process.env` to be testable.
- **The password lives in `auth_secrets`, not in the `CredentialVault`.** The vault exists for secrets that have to be _recovered_ — an API key is useless unless it can be read back into a header. A password is only ever compared against a one-way digest, so encrypting it adds key management to something already unreadable.
- **A session token is `<id>.<secret>`, and that shape is what makes `timingSafeEqual` mean anything.** The row is found by `id`, which is not a credential; the secret is then compared as a SHA-256 digest of fixed length. A single opaque token looked up by its own value puts the secret in a SQL `=`, which short-circuits on the first differing byte. SHA-256 rather than argon2id for the token, because a KDF's cost buys nothing against 32 bytes of `randomBytes` and would put ~50 ms on every authenticated request.
- **Rotating the password revokes every session.** The reason to change it is that the old one may be known, and a token minted under it outliving the rotation makes the rotation cosmetic.
- **`Secure` is set unless this is plain HTTP to a loopback host.** Safari refuses to store a `Secure` cookie over `http://`, localhost included, so an unconditional flag makes `ghost serve` unusable in one browser on the default bind. The consequence — a plain-HTTP LAN bind cannot hold a session — is the intended outcome, not a gap.
- **Zod validates and Zod documents; Fastify's AJV is handed nothing.** `z.toJSONSchema` emits draft 2020-12 and AJV compiles draft-07, so the route's Zod schema is the validator (via `setValidatorCompiler`) and the same object becomes JSON Schema in `@fastify/swagger`'s `transform`. A response that _is_ a registered protocol schema emits a `$ref` into `components.schemas`; a request body always inlines **in input mode**, because output mode lists every `.default()` field as required and a client told that will invent values.
- **Nothing relies on serialisation to keep a credential out of a response.** Replacing the serializer compiler with `JSON.stringify` gives up schema-based response filtering; the routes simply never put a secret in a body. Step 13's `GET /api/settings` has to hold that line itself.
- **`@fastify/rate-limit` _throws_ whatever `errorResponseBuilder` returns**, so it must return an `Error`. A plain envelope object arrives at the error handler as an unrecognised value and becomes a 500 — which is how the limit silently stops being a limit. `HttpError` carries the status and code through to the one place a body is built.
- **The manifest carries an `id`, and `createRoutes` returns `Record<RouteId, RouteDefinition>`.** A manifest entry with no handler and a handler with no manifest entry are both type errors. `signed` is deliberately not yet in `RouteAuth`: it arrives in Step 13 beside the code that verifies a signature, because a variant nothing can enforce is worse than one that does not exist.
- **The auth hook reads `config.server.auth.enabled` from the object it was built with.** Step 13's `PATCH /api/settings` must re-point the server at the merged config — or, better, leave `enabled` out of what a running server honours, since a live toggle from `true` to `false` is a request to unauthenticate an already-authenticated session.
- `AuthSessionResponseSchema` was added to `protocol/rest.ts` for `GET /api/auth/me`; the registry test in `@ghostai/protocol` covers it automatically.
- The coverage gate for this package is 85/80, above the 70/65 default — an untested branch in the auth surface is a way in, not a bug report.

</details>

<details>
<summary><b>Step 12 — <code>SessionHub</code>: turns, queueing, replay, fanout</b> ✅ done</summary>

The protocol specifies `message.queued`, `session.status.queueDepth`, `session_busy` and `session.resume { lastSeq }`, and none of it has an implementation. `AgentLoop` will happily run two turns on one session key and interleave their writes. This is the one genuinely new design in the phase.

- Per session key the hub owns a FIFO turn queue, the live `AbortController`, the `seq` counter, and a replay ring buffer sized `server.replayBufferSize`.
- Running a turn is: iterate `loop.run()`, stamp `seq`, push to the ring, broadcast. `AgentEvent` _is_ `ServerMessage` minus `seq` and `sessionKey`, so this is a counter and a forward, not a mapping table.
- Fanout is the hub's job, not `MessageBus`'s — that queue is competing-consumer by design and explicitly does not broadcast, so it is the wrong primitive for three open tabs on one session.
- `session.resume` replays the ring after `lastSeq`; past the ring boundary, `session.replay` reports `complete: false` and the client refetches from REST.
- `turn.stop` aborts; `turn.steer` calls `loop.steer()`. One `AbortSignal`, from socket close through the loop and the provider fetch to `child.kill()`.
- The Step 10 approval gate is implemented here, resolving against inbound `tool.approve` and denying on `expiresAtMs`.
- Every inbound frame is `safeParse`d; a parse failure is an `error` event, never a throw.

**Done when:** tests cover two concurrent messages on one session, stop mid-tool, an exact replay from mid-stream, a resume past the ring boundary, and three connections receiving one stream. ✅

Notes for later steps:

- **`@ghostai/server` now depends on `@ghostai/agent`.** That arrow was always going to appear: the hub drives `AgentLoop.run()`. It points one way only — the loop still cannot see a transport — and pnpm's isolated `node_modules` plus the layering rule keep it that way.
- **The hub takes a `TurnRunner`, not an `AgentLoop`.** Two methods, `run` and `steer`, which `AgentLoop` satisfies structurally. That is what lets `hub.test.ts` drive a scripted async generator instead of standing up a provider, a jail, a registry and a store to assert that a second message queues.
- **Construction order for `ghost serve`:** the gate first, then the runtime, then the hub — `new HubApprovalGate()` → `createRuntime({ approvals })` → `new SessionHub({ store: runtime.store, loop: () => runtime.loop, approvals })`. The runtime needs the gate at construction and the hub needs the runtime, so the gate is built outside both. `loop` is a thunk for the same reason `reconfigure` rebuilds it: the next turn takes the new loop, the running one keeps its own.
- **Sequenced means broadcast.** Every event carrying a `seq` goes to every subscriber of the session and into the ring; `connected`, `pong` and `error` are the only frames addressed to one connection. A targeted frame with a `seq` would make one client's `lastSeq` mean something different from another's.
- **A replayed frame keeps the `seq` it was emitted with**, so a client must track the _maximum_ `seq` it has seen, not the last one it received: the `session.replay` envelope is a new event and therefore carries a higher number than the tail that follows it.
- **The two resume answers are exclusive.** Covered by the ring: the verbatim tail, which includes the deltas of a turn still running. Past it: `complete: false` plus the stored tail, and no ring frames — a stored assistant message and the deltas that produced it are the same text twice.
- **`message.ack.messageId` is the turn id**, not a stored row id. A queued message has not been persisted yet, and an ack that waited for persistence would wait for the turn in front of it — the one moment the client needs the ack. Step 15's client should key its optimistic bubble on it and reconcile against `turnId` when history arrives.
- **`turn.stop` aborts the running turn and leaves the queue alone.** Each queued message is something the user deliberately sent, and there is no `message.dropped` event with which to report discarding one.
- **`session_busy` is the queue cap**, the only place that code is emitted. Without a bound the queue fills from a socket and drains from a loop that may be blocked in a slow tool.
- **Idle session state is evicted oldest-first past `maxSessions`**, and a reconnect to an evicted session lands on the same path as one past the ring boundary. Anything live — a client, a running turn, a queue — is never evicted; the cap yields rather than dropping work.
- **`always`-scoped approvals live as long as the process.** Persisting "never ask me about this tool again" is a settings write, and Step 13 owns the route that could revoke it; a decision stored through a path nothing can undo is worse than one that expires with the server.
- **`audio.transcribe` answers `config_invalid`.** The frame is in the protocol and there is no STT provider yet; a typed refusal keeps the inbound switch exhaustive instead of leaving a message type silently unhandled.
- `ResolvedError` gained a typed `code`, so a turn that throws resolves through the same table the REST error handler uses rather than deriving a second kind→code mapping. `body.error.code` stays widened to `string` because the response schema is.
- **Nothing serves the hub yet.** It is transport-agnostic on purpose — `connect({ send })`, `receive(frame)`, `close()` — and Step 14's `ghost serve` is where a `@fastify/websocket` handler binds those three to a socket. A channel binds the same three without one.

</details>

<details>
<summary><b>Step 13 — REST routes</b> ✅ done</summary>

~25 routes, every schema already in `protocol/rest.ts`. Cursor pagination throughout — sessions and messages are append-only, so an offset shifts under a reader whenever a turn lands.

Status and health · auth · settings and credentials · providers and models · sessions CRUD, messages, context · tools · files, upload and signed media · notifications.

- `PATCH /api/settings` takes `ConfigPatch`, the deep-partial built by `patchOf()`. A plain `.partial()` would make saving one settings panel rewrite every untouched field back to its default.
- `GET /api/settings` never returns credentials. The vault is write-only over HTTP; the UI gets `credentialsPresent` booleans.
- `GET /api/providers` is `describeProvider()` mapped over `PROVIDERS` — that projection is already written.
- **`/api/media/:token` is the only signed route.** `<img src>` cannot carry an `Authorization` header, and the tempting fix — making the file endpoint public — is anonymous read access to the whole workspace. HMAC-signed, short-lived URLs instead, with the endpoint still authenticated. ~~This path uses `WorkspaceJail.contains()`, not `resolve()`.~~ It uses `check()` — see the note below.

**Done when:** every route has a `fastify.inject()` test, the generated OpenAPI validates as 3.1, and pagination is tested across a boundary with a concurrent append. ✅ (29 routes, 98.7/94.6, `@readme/openapi-parser` validating the generated document)

Notes for later steps:

- **The routes take a `ServerRuntime` port, not `GhostRuntime`.** `@ghostai/server` still does not import `@ghostai/runtime`. The dependency would type-check — nothing above the server imports it back — but it would put the whole wiring graph behind every route test, and the server would then be untestable without a provider, a workspace and a vault. The port is `config()`, `applySettings()`, `credentialsPresent()`, `setCredential()`, `store`, `agent()`, and two optional hooks; **Step 14's `ghost serve` owns the adapter over `GhostRuntime`**, which is also where the `config.json` write lives — `reconfigure` deliberately does not persist, and `applySettings` is documented as the operation that does.
- **The port is made of calls, not fields.** A settings save rebuilds the provider, the jail and the loop, so a route holding a snapshot taken at boot would keep answering with the model the operator just changed. `agent()` returns a fresh `AgentView` per request for the same reason.
- **Two configs, deliberately.** `ServerOptions.config` is what the _listener_ was built with — bind, rate limits, `auth.enabled` — and the hooks read it; `runtime.config()` is live and the handlers read that. This is the resolution of Step 11's open question: a live toggle of `auth.enabled` is a request to unauthenticate an already-authenticated session, so it is not honoured until a restart. `PATCH /api/settings` refuses a patch whose merged `server` block would fail `assertBootPolicy`, so a save can never produce a config file whose next boot is a refusal.
- **`AgentLoop.previewPrompt()` is new, and the context inspector reads it.** Composing the two prompt halves inside the route would work today and lie in Phase 3: memory, skills and profiles arrive as `ContextContributor`s attached to the loop, and a reimplementation cannot see them. The message window comes from `historyForLLM` with `maxToolResultChars: 0`, which returns the _same objects_ it was given — that identity is how each message is matched back to the stored row carrying its id.
- **Cursors are opaque base64url, and a bad one is a 400.** A cursor that reads as `42` is a cursor a client does arithmetic on. Silently ignoring an unparseable one pages a client through the same first page forever, which reads as a hung UI rather than a bad request. `SessionStore.listSessions` gained a keyset `after: { updatedAtMs, key }`; `offset` stays for callers that are not paging a user through a moving list.
- **Query schemas live in `server/src/queries.ts`, not in the protocol.** A query string carries only strings, so `limit=50` needs coercion, and `@ghostai/protocol` forbids transforms outright so its schemas stay representable as JSON Schema. They are the one place in the repo a schema does not infer its own type: this package keeps `isolatedDeclarations` on, so each is annotated `z.ZodType<T>` with `T` written out — checked against the schema, so the pair cannot drift. `queries.test.ts` holds them to `PaginationQuerySchema`'s bounds.
- **`RouteGroup<K>` is what keeps the manifest↔handler join a type error.** A handler module typed as `Record<string, RouteDefinition>` satisfies the composer no matter which routes it forgot, because a string index signature covers every key. Each module names the ids it owns.
- **Upload is a raw `POST`, not multipart.** A browser sends a `File` with no encoding step and a base64 envelope would inflate every upload by a third to restate what `Content-Type` already says — so a catch-all `parseAs: 'buffer'` parser replaces `@fastify/multipart` and the dependency behind it. The 25 MiB cap is a per-route `bodyLimit`, enforced while the body is still arriving.
- **The media route re-checks the path with `jail.check()`, not `jail.contains()`** — a change from what this step originally specified. `contains` compares an already-absolute path without canonicalising, so it would serve a file that became a symlink to `/etc/passwd` after the URL was minted. A signature says who asked, not what the filesystem looks like now. The same reasoning fixed the directory listing, which would otherwise advertise an escaping symlink it then refuses to open.
- **Nothing a browser executes is ever served inline.** `.svg`, `.html`, `.js`, `.xml` and friends come back as `application/octet-stream; attachment` with `nosniff`. An SVG is a document that can carry `<script>`, and the workspace is a tree a language model writes to.
- **`maxParamLength` is raised to 2048.** Fastify's default is 100 characters, which a signed media token and a channel-chosen session key both exceed as a matter of course — answering 414 to an ordinary request.
- **`AuthStore.ensureSecret(name)` mints and stores named server secrets**, used for the media signing key. It refuses `password` by name: that row holds a one-way digest, and handing it back as a signing key would be a category error. The key is created lazily, so an install that never serves a file never writes one.
- **`NotificationStore` lives in this package**, on the shared connection, because nothing below the transport raises a notification. Read is a timestamp rather than a flag — "when did this stop being new" is what a badge asks — and the routes are read-and-dismiss only: a `POST /api/notifications` would exist solely to let a client fabricate the server's own reports. **Step 14's channels and the scheduler create them**; the hub's `notification` event should carry the same row.
- **`GET /api/models` is config-derived until something can enumerate.** No adapter fetches a catalogue yet, and a hard-coded list would be stale within a month and wrong for every local server. The route serves what `providers.<id>.models` names plus the model a turn would use right now, and `ServerRuntime.models()` is the seam for a real fetcher. `errors` stays empty rather than reporting "not attempted" for every provider.
- **The auth matrix now asserts 401-vs-not-401**, not 2xx. Insisting on success would make it a test of every handler's happy path — needing a seeded session, an existing file and a real notification id — and it would then fail for reasons that have nothing to do with authentication. A `signed` route answers 401 in every matrix state, including with a valid session: the two credentials authorise different things and neither widens the other's reach.
- `src/testkit/` holds a `ServerRuntime` fake, a server harness and a manual clock. Not exported from `index.ts` — shipping it would make "a runtime whose settings save goes nowhere" part of the public API.

</details>

<details>
<summary><b>Step 14 — <code>@ghostai/channels</code> and <code>ghost serve</code></b> ✅ done</summary>

- `Channel`, `ChannelFactory` and `ChannelManager`, bridging the existing `MessageBus` to `SessionHub`. Channels publish `InboundMessage` and consume `OutboundMessage`; they never touch `AgentLoop`.
- `channelConformance(factory)` in `src/testkit/`, with a `loopback` reference channel in `examples/` proving the contract without a network.
- `parseMentions()` runs server-side in the hub for every channel, so `@kb:` is not a web-only feature.
- `ghost serve` — lazy-imported like every other subcommand, so `ghost --help` still loads nothing from `@ghostai/*`. Serves the built SPA with an SPA fallback and prints the URL and whether auth is on.

**Done when:** the loopback channel round-trips a message through the same agent into the same session store as a web turn, and `ghost serve` serves the SPA on one port. ✅ (channels 97/94, the round trip asserted against a real `SessionHub`, `AgentLoop` and `SessionStore` in `examples/loopback-channel`)

Notes for later steps:

- **The socket is a manifest route, not a registration in `ghost serve`.** `createServer` awaits `app.ready()`, so nothing can add a route afterwards — which settles where `GET /ws` and the static UI belong. `ServerOptions` gained `hub` (required) and `ui`. The gain is not tidiness: `/ws` is `auth: 'required'` in `ROUTE_MANIFEST`, so the auth matrix covers the upgrade, and an unauthenticated socket would have been an anonymous shell-capable agent that no test was looking at.
- **`wsHandler` beside `handler`, never `{ websocket: true }`.** That form hides the route from the generated document and answers a plain GET with a bare 404. The route therefore keeps its schema, its OpenAPI entry and a 426 for a request that forgot to upgrade. `?session=` is validated before the upgrade, so a bad query is a 422 rather than a socket that opens on a session nobody asked for.
- **A socket that stops reading is closed, not buffered.** `send` throws past `MAX_BUFFERED_BYTES`, which the hub already reads as a dead connection. Without it one tab that stopped draining holds a turn's whole output per session.
- **The SPA fallback is a callback into the one not-found handler**, since Fastify allows exactly one. It answers `GET` only, and never under `/api` or `/ws`: HTML for an unknown API path surfaces as a JSON parse error somewhere unrelated. The shell itself is unauthenticated — every byte of data behind it is not, and a login screen that needed a session could never load.
- **A channel cannot name another channel's session.** `ChannelManager` prefixes any key not already starting with `<channelId>:`, so a plugin channel publishing `web:1` writes into `plugin:web:1` rather than into a browser's conversation. It also stamps `channelId` on publish, so a channel cannot speak as another one, and it never hands out the `MessageBus` — a channel that drained `outbound()` would take other channels' replies out of a competing-consumer queue.
- **`Channel.accepts` is why `progress` is opt-in.** The projection's `progress` carries the answer _so far_ and `reply` carries the whole of it, which is what a transport that edits in place wants and what a transport that can only post renders as the answer twice. The default omits `progress`; Telegram's `StreamingEditor` declares it.
- **One hub connection per `(channel, session)`, LRU-bounded at 256 and never evicting a busy one.** A connection the hub can see is a session the hub will not evict, so the bound has to live in the manager. Outbound delivery is chained per channel: order holds within a channel, and a channel blocked on a `RetryAfter` cannot hold up another.
- **`TurnInput.mentions` is the seam `@kb:` will arrive through.** The hub parses mentions once, for every transport, and the loop passes them to `RuntimePromptContext` — the runtime half of the prompt, because they are turn-scoped and `staticSection` must stay stable for the session. Nothing reads them until Phase 3; a contributor that does will get them from the browser and from Telegram identically.
- **`saveConfig` landed in `@ghostai/core`, beside `loadConfig`.** Validate, write to `<file>.tmp`, rename — so a crash mid-write leaves the previous file rather than a truncated one, and a patch that merged into something the schema rejects is refused before it becomes a config the next boot cannot load.
- **`--host` goes through the config; `--port` does not.** `assertBootPolicy` reads the config it was handed, so a `--host 0.0.0.0` applied only at `listen` time would walk past the refusal that exists to stop an unauthenticated LAN bind. A port carries no such decision — and `--port 0` is not expressible in a schema that requires a real port number.
- **`credentialsPresent()` does not open the vault to answer.** `resolveVaultKey` mints a keychain entry the first time it runs, so the adapter reads the vault only when one already exists on disk or when a key is being written. A `PUT /api/settings/credentials` is followed by `reconfigure({})`, which re-reads the credential — that is what makes a key saved in the UI usable on the next turn without a restart.
- **`@ghostai/channels/testkit` is a real subpath export**, unlike the provider and tool suites which are importable only from inside their own package. A channel is the one implementation that will routinely live outside this repo, and `vitest` is marked `external` in tsup so the entry does not carry it. Step 15's `@ghostai/web` needs no equivalent.
- **`examples/*` are vitest projects now**, so the loopback channel's conformance run is part of `pnpm test` rather than a file nobody executes.
- `Fastify` is constructed with `routerOptions.maxParamLength`; the flat form is deprecated in Fastify 5 and warned once per route.

</details>

<details>
<summary><b>Step 15 — <code>@ghostai/web</code>: the token layer</b> ✅ done</summary>

Vite 8, React 19, Tailwind 4. Tailwind 4 is CSS-first, so **there is no `tailwind.config.js`** — the tokens _are_ the config, in two `@theme` blocks inside `tokens.css`. The whole token layer shipped before the first component.

Every colour derives from a seed block, which is what makes a second theme two dozen numbers instead of a second stylesheet. `src/styles/tokens.css` holds the dark seeds, the light seeds, the ~30 derived tokens and the Tailwind theme; nothing else in the package contains a colour.

Resolution is `prefers-color-scheme` with `:root[data-theme]` overriding in **both** directions, stamped on `<html>` by a blocking inline script in `index.html` so the page never flashes the wrong theme.

Three decisions worth knowing before writing a component:

- **Hover is an overlay, not a surface.** It lightens in dark and darkens in light, so it cannot be a fixed ramp stop. `--color-hover` composites over whatever surface is underneath, which also means it works on a card, a popover and a sidebar item without three values.
- **Fill uses `--color-accent`, text and icons use `--color-accent-fg`.** They are identical in dark, so the rule is only load-bearing in light — which is exactly the kind of thing that rots unless a lint rule catches it.
- **The root font size is never overridden.** Density comes from the type scale, so the UI honours the user's browser setting.

Additions with nothing to port: a real `:focus-visible` layer, a grabbable `0.5rem` scrollbar, and self-hosted Inter and JetBrains Mono via `@fontsource-variable` — a font CDN in a self-hosted privacy-first product leaks every user's IP and breaks air-gapped installs.

Three blocking gates: no `px` literals outside `tokens.css`; no raw hex, `rgb()` or `oklch()` outside `tokens.css`; and no `--color-accent` in a text or border position.

**Done when:** a page rendering nothing but a token swatch grid passes all three gates, every text-on-surface pairing meets WCAG AA **in both themes** under an automated contrast assertion, the theme toggles without a reload or a flash, the page reflows at 200% browser font size, and it renders with the network blocked. ✅ (142 tests; 88 contrast assertions across both themes; the gate sweep runs over `index.html` and every shipped `.css`/`.tsx`)

Notes for later steps:

- **The seed numbers in the plan did not survive the contrast assertion, which is the point of having written it first.** Three classes of change: light text and semantic text went darker (`--seed-text-3` `0.600 → 0.520`, `--seed-semantic-fg-l` `0.58 → 0.49`) because the planned values measured 3.9–4.4:1 on the sunken surface; a single `--seed-semantic-c: 0.168` turned out to be **outside sRGB** for blue and red at the fill lightness, so it is now `0.127` dark / `0.138` light — the largest chroma the tightest hue can hold; and the light surfaces lost their accent tint (`--seed-neutral-c: 0` in light) because `oklch(1 0.005 77.3)` — the planned pure-white top surface — is not a colour a display can show.
- **Chroma is a per-theme seed, not a constant.** `--seed-accent-fg-c` and `--seed-semantic-fg-c` exist because sRGB holds far less chroma at L 0.49 than at L 0.763: a gold that kept C 0.155 while its lightness dropped for the light theme would be clipped to a colour nobody chose, and clipped colours make the contrast maths fiction. **Any later step that adds a role adds four seeds, not two.**
- **`@theme inline`, never plain `@theme`.** The utility has to emit `var(--surface-0)` and resolve at paint time; a plain `@theme` freezes whichever value was current when Tailwind ran, which is to say dark. This is what makes the toggle one attribute write with no stylesheet swap.
- **The light seeds are declared twice** — a media query and an attribute selector cannot share a selector list — and `styles/tokens.test.ts` asserts the two blocks declare the same properties with the same values, plus that every dark seed has a light counterpart. A seed missing from the light block silently keeps its dark value, which is how one component ends up still inverted.
- **The gates are functions over source text, not an ESLint rule.** The same three rules have to hold in CSS, in TSX class strings and in `index.html`, and no single linter reads all three. They run two ways: `tokens/gates.test.ts` sweeps the package under `pnpm test`, and `pnpm --filter @ghostai/web lint` runs `run-gates.ts` as a command. `src/tokens/**` is excluded from the sweep — it contains every literal it bans — and so are test files. **Step 19 owns making the command a CI step in its own right.**
- **Contrast is measured against the file that ships.** `tokens/sheet.ts` parses `tokens.css`, resolves `var()` chains for one theme, and `tokens/color.ts` converts OKLCH → sRGB → WCAG luminance. A TypeScript palette object that generated the stylesheet would have left the stylesheet free to drift from the thing under test. The parser accepts only the subset the sheet uses and **throws on anything else** — including nested rules — so a token it could not see is a build error rather than a token nothing checks. `color-mix()` is deliberately unused for that reason; soft fills are `oklch(… / α)`.
- **The gamut assertion is load-bearing for every other assertion.** An out-of-sRGB colour is clipped by the display, so its measured contrast describes a colour the user never sees.
- **The pre-paint script is tested by extraction, not by copy.** `theme.test.ts` pulls the inline script out of the real `index.html`, runs it against a stubbed DOM and asserts it agrees with `theme.ts` on all eight combinations of stored preference and OS setting. The stored value is the _preference_ (`dark | light | system`); the stamped value is the _resolution_ — storing the resolution would turn "follow the system" into "dark forever, because it was dark when you first loaded".
- **`localStorage` is stubbed in tests rather than taken from the environment.** Node 26 ships its own experimental global that shadows jsdom's and is inert without `--localstorage-file`.
- **`ghost serve` now finds a UI.** `@ghostai/web` is a dependency of `@ghostai/cli`, so `resolveUiRoot(undefined)` resolves `dist/` through the package graph and turbo builds the SPA before the CLI. Two `serve.test.ts` cases assumed the package did not exist and now assert against whichever state the checkout is in — built or not — because both are real.
- **`useTheme` is the only React state here.** Step 16's toggle should consume it rather than reimplement it, and `watchSystemTheme` is why a `system` preference keeps tracking after first paint: the OS can flip at sunset and the pre-paint script only ran once.
- **200% reflow and "renders with the network blocked" are structural, not visual, at this step.** The first is the `no-px` gate plus a rem-only type scale; the second is `self-contained.test.ts`, which fails on any external origin in the shipped source. Step 19's Playwright run is what observes both in a browser.
- The package's `tsconfig.json` is the only one in the repo with `noEmit`: Vite owns the JavaScript, nothing imports `@ghostai/web` for its types, and `isolatedDeclarations` is off because a component's props are exactly the shape it cannot write a declaration for.

</details>

<details>
<summary><b>Step 16 — App shell and primitives</b></summary>

The two-column shell, the CVA button and badge recipes, and the interactive primitives.

- Unstyled **Radix** for anything with interaction semantics — `Dialog`, `DropdownMenu`, `Tooltip`, `Popover`, `Tabs`, `Select`, `Switch`, `ScrollArea`. No shadcn/ui, no vendored component tree; Radix contributes behaviour and every class is ours. It also lets most of the z-index scale retire, since portals manage layering.
- One badge recipe parameterised on semantic role, replacing ~25 hand-written variants of the same pill.
- One toast helper. The three-state `dark | light | system` theme toggle. The login overlay.
- TanStack Router and Query for routes and REST; Zustand for live turn state, because Query is the wrong tool for a stream you accumulate.

**Done when:** every interactive element is keyboard-reachable with a visible ring, dialogs trap focus and close on Escape, and every component has been reviewed in **both** themes — reviewing only in dark is how a light theme ships broken.

</details>

<details>
<summary><b>Step 17 — The chat view</b></summary>

The centrepiece.

- **Transport** — one WebSocket, `safeParse` on every frame, backoff reconnect that resumes with `session.resume { lastSeq }`. The client accumulates deltas; the server never holds a running copy of the response text.
- **Streaming markdown** — split into blocks with completed blocks memoised, so a delta re-renders only the last one. Deltas coalesce on `requestAnimationFrame` rather than setting state per token, and Shiki highlighting is deferred to idle and only runs on blocks that have stopped growing. Re-parsing the whole buffer every frame is O(n²) over a long answer and destroys selection and scroll state; block memoisation is what makes the same technique cheap.
- **Tool cards** — collapsible, with `tool.progress` driving an elapsed counter so a slow `exec` visibly has not hung, terminal output for `exec`, and a risk badge. **Never render the nonce envelope**: `tool.result` carries the tool's own output for exactly that reason, and the delimiters are a defence aimed at the model, not part of the answer.
- **Approval prompt** — inline in the tool card, `once | session | always`, expiring at `expiresAtMs`. Entirely net-new; there is no prior art to port.
- **Composer** — auto-growing textarea, send ⇄ stop driven by `session.status.busy`, attachment staging over signed URLs, and `@` autocomplete backed by the same `parseMentions` the server runs.
- Reasoning blocks, session list, notice badges for `prompt_injection` / `degraded` / `truncated_history`, and a welcome screen.

**Done when:** a turn with multiple tool calls streams and renders, Stop aborts mid-tool, a mid-stream reload rebuilds the in-flight turn from the replay buffer, and an `exec` call raises an approval prompt that actually gates execution.

</details>

<details>
<summary><b>Step 18 — Settings, files, notifications</b></summary>

Settings panels for the agent, providers (key entry writing to the vault, model list, `credentialsPresent` indicators) and tools including the approval policy matrix. A file browser with breadcrumbs, upload and signed-URL previews. A notification centre. The context inspector, rendering the token `breakdown` as a stacked bar — the panel that makes the budget legible instead of a mystery.

Panels whose backing systems arrive later — MCP, skills, plugins, knowledge, automation, OAuth — render a placeholder naming the phase, not a stub implementation.

**Done when:** a provider key saved in the UI is usable on the next turn with no restart, and no response anywhere in the network trace contains a credential.

</details>

<details>
<summary><b>Step 19 — E2E and the fidelity gate</b></summary>

- **Playwright** against a deterministic fake provider — reuse `scriptedProvider` from `packages/agent/src/testkit/`. Send → stream → tool card → stop, approval approve and deny, reload mid-stream. Screenshots run in both colour schemes, so a component that only works in one is a failing test rather than a bug report.
- **Fidelity:** screenshot-diff each screen against the product being replaced, in dark. Deviations should be sub-pixel except four known ones — focus rings, scrollbar width, the evened surface ramp, and ±1px on rounded spacing. There is no light-mode baseline, so light is held to the contrast assertion and review.
- **Then what the original cannot do:** 200% font size reflows without clipping, `:focus-visible` is reachable on every control, dialogs trap focus and close on Escape, and the app renders with no network access.
- All three Step 15 lint gates blocking in CI.

**Phase 2 done when:** browser chat streams tokens and tool cards and Stop aborts mid-tool; a reconnecting tab rebuilds an in-flight turn from the replay buffer; the loopback channel round-trips through the same agent and session store; the chat view is visually indistinguishable from the original at 1× in dark, works in light, and reflows at 200%; zero `px` literals and zero raw hex outside `tokens.css`; every route has a `fastify.inject()` test including the auth matrix; and the Playwright smoke test passes.

</details>

## Later phases

Detailed in the design document. Each is independently shippable:

| Phase | Scope                                                                                                |
| ----- | ---------------------------------------------------------------------------------------------------- |
| **3** | Full provider table, remaining wire adapters, MCP client, memory/skills/profiles/subagents, Telegram |
| **4** | Plugin SDK and host, install/uninstall from the UI, WhatsApp and Discord as external plugins         |
| **5** | Automation scheduler, RAG knowledge base, MCP server mode                                            |
| **6** | Threat-model regression suite, sandboxed plugins, Docker, `ghost doctor`                             |

**Run the native-module and embedding spike during Phase 1, not Phase 5** — it is the highest-risk dependency work and must not surface late.
