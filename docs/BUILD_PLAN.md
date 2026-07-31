# Build plan

What is left to build, one entry each. Nothing here is a design document — the
design happens when the feature is picked up, and a plan written months early is
a plan that gets re-derived anyway.

Each entry says three things:

- **What** — one sentence, so the scope is arguable before any code exists.
- **Already there** — the schema, contract or config block that ships today.
  Every feature below has one, because the shapes were designed with the tree
  and the implementations were not. **Read it before designing anything**; it is
  the difference between building the feature and building a second one beside
  it.
- **Missing** — the actual work.

Nothing here depends on anything else here unless it says so. The order is the
order they were asked for, not a schedule.

Two rules apply to every entry and are not restated in them, both in
`CLAUDE.md`: **the gate is `.github/workflows/ci.yml`, not `pnpm check`**, and
**never assert a transient state in an e2e test**.

---

## Connect MCP servers

**What.** Speak MCP as a client, so a third-party server's tools appear beside
the built-ins.

**Already there.** `McpServerConfigSchema` covers all three transports
(`stdio`, `sse`, `streamableHttp`), OAuth, headers, `toolTimeoutMs` and
`enabledTools`. `ToolSource` already includes `'mcp'`, and `ToolRegistry`
carries the source so `unregisterBySource('mcp')` is exact. `ToolAnnotations`
mirrors MCP's own annotation vocabulary deliberately.

**Missing.** The client, the connection lifecycle, and the tool bridge. The
naming rule is already written down in `registry.ts` and must hold:
**flatten to `mcp_{server}_{tool}`** before registering, or two servers
exporting `search` collide and which one answers depends on load order.

Every bridged tool needs a `risk` band, and MCP does not supply one — deriving
it from `readOnlyHint` / `destructiveHint` is the obvious answer and should be
decided once, in the bridge.

## Telegram

**What.** Hold a conversation with an agent from Telegram.

**Already there.** `packages/channels` is the contract and the hard part:
`Channel` / `ChannelFactory` / `ChannelInbound`, `ChannelManager` with its
session cap, and `TurnProjection`, which turns agent events into messages a
chat app can send. `ChannelsConfigSchema` is a `looseObject` so a channel parses
its own block without a schema change here. `sessions.origin` accepts
`telegram`.

**Missing.** The adapter — one `ChannelFactory` over the Bot API, plus its
config block and its credential in the vault. Telegram ships in the box but
consumes the same contract a plugin would, so the contract cannot rot.

`TurnProjection` already emits an ungated notice when a tool needs approval,
because a chat app has no approval UI. Whether Telegram grows inline-keyboard
approval is a real decision and is not made.

## Skills

**What.** Reusable instruction bundles an agent can carry, some pinned always
and the rest loaded when relevant.

**Already there.** `AgentDefaults.pinnedSkills` and `maxPinnedSkills`.

**Missing.** All of it: the on-disk format, the loader, the prompt budget, and
the rule for what "relevant" means. The cap exists because the failure mode is
known — pinning everything is how the identity half of the prompt stops fitting.

## Memory

**What.** The agent remembers across sessions, and compacts what it remembers
before it outgrows the prompt.

**Already there.** The tuning is all in config and none of it is read yet:
`learningEnabled`, `learningInterval` (turns between proactive passes),
`memoryMaxPromptTokens`, `memoryCompactThresholdTokens`, and
`consolidationModel` (a cheaper model, falling back to the agent's own).
`AgentMemoryScope.shared` decides whether an agent also reads the layer shared
by every agent in the same folder.

**Missing.** The store, the retrieval, the consolidation pass, and the prompt
section. Two thresholds rather than one is deliberate: compaction starts before
the cap, so a turn is never the thing that discovers the limit.

## RAG

**What.** Index the workspace and put the relevant chunks in the prompt.

**Already there.** `RagConfigSchema`: embedder `provider` and `apiBase`
(`local` is Ollama's `/api/embed`), `model`, `chunkSize` / `chunkOverlap`,
`topK`, `hybrid`, and `rrfK` — reciprocal-rank fusion at 60, the constant from
the original paper, for blending BM25 with vector ranking. The Settings →
Knowledge panel is a placeholder.

**Missing.** The index, the embedder client, the retrieval, and the panel. The
config already commits to hybrid search, so BM25 is not optional.

## Extensions

**What.** Third-party packages that add tools, channels or providers.

**Already there.** `PluginsConfigSchema`: explicit `load` specs, `disabled`,
`allowUnverified` (required before an arbitrary npm spec may be installed) and
`allowOverride`. `ToolSource` includes `'plugin'`, and `unregisterBySource`
makes uninstall exact — no module-cache surgery, no restart. The Settings →
Extensions panel is a placeholder.

**Missing.** Discovery under `~/.ghostai/plugins`, the loader, the manifest
format, and the panel. `allowUnverified` is the security decision and it is
already made: an arbitrary npm spec is refused by default.

## Slash commands in the browser

**What.** The commands the terminal REPL already has, in the composer.

**Already there.** `packages/cli/src/commands.ts` — the terminal's command
table, its help text and its tests.

**Missing.** A shared table both surfaces read, and the composer UI. The table
is the point: two hand-maintained lists is how `/help` ends up describing
commands one of them does not have.

## Session search page

**What.** Find a conversation by what was said in it, rather than scrolling the
sidebar.

**Already there.** `SessionListQuery` in `packages/server/src/queries.ts` filters
by `origin` and `workspace` over keyset pagination, and `SessionStore` already
pages that way.

**Missing.** Text search — a query field, an index over message content, and a
page to show the results on. Keyset pagination and relevance ordering do not
compose for free; which one wins is the first decision.

---

## Done

- **Phase 1 — the agent from a terminal.** `AgentLoop` with tool iteration,
  steering, approvals, abort threading and turn stats; the tool registry and the
  built-in file and exec tools; the workspace jail, the encrypted credential
  vault, the SSRF guard and argv-only exec; the provider registry with
  resilience; `SessionStore` over `node:sqlite` with keyset pagination, forking
  and truncation; `ghost chat` with a slash-command REPL.
- **Phase 2 — the server and the browser.** Fastify with REST, the WebSocket hub,
  replay on reconnect, auth with argon2id and two-scope login throttling, signed
  URLs for workspace media, OpenAPI from the Zod schemas; the React SPA with
  chat, agents, workspaces, files, notifications, settings and the token style
  guide, over a hand-written token layer with contrast and `px`/colour gates; an
  e2e suite driving a real server in a real browser in both colour schemes.
- **Multiple agents with different settings.** `agents.list.<id>` in
  `config.json`, each entry a patch over `agents.defaults` — model, provider,
  temperature, reasoning effort, context window, toolbox and memory scope. One
  `AgentLoop` per agent, cached; one shared workspace, store, registry and
  provider cache. A session is bound to an agent through `sessions.agent_id`,
  and the stored row wins over a frame once the session exists.
- **Per-tool permissions.** `agents.list.<id>.tools` is a `name → allow | ask |
deny` map; absent means disabled, so a tool is enabled explicitly or not at
  all. `ToolRisk` is metadata that seeds a new agent and decides nothing at call
  time. Edited on the agent, not in Settings.
- **Toolboxes.** A digest-pinned container image plus its whole security policy,
  installed by an operator and authorised by manifest hash. `exec` runs inside
  it; `network.maxMode` is a ceiling an agent's config can narrow and never
  widen. Declared programs can be exposed as callable tools, each with its own
  default permission.
- **The i18n layer.** Three namespaces, the JSON typed as the key union, errors
  carrying a translatable key across packages, and two CI gates for the opposite
  halves of the problem.
- **Scheduled jobs, and the heartbeat.** A rearming `Clock` timer to the
  earliest due job, clamped so a distant one-shot cannot overflow `setTimeout`
  and fire immediately; `automation_jobs` and `automation_runs` on the shared
  connection, with schedule and payload as JSON so a discriminated union stays
  one; a hand-rolled five-field cron parser in `@ghostai/core` with the
  day-of-month/day-of-week OR rule and both DST edges; seven REST routes with
  `run` answering 202; a **Scheduled jobs page** in the nav with an editor per
  job; and a Settings → Automation panel holding the engine's five knobs and
  nothing else. `catchUpOnBoot` **coalesces** — a job that missed twelve occurrences runs
  once, not twelve times. Runs go through the hub rather than straight to a
  loop, because `payload.sessionKey` lets two jobs — or a browser tab — name one
  session, and the hub is the only thing that serialises one. The
  heartbeat's decide/run/evaluate triad ships too: decide and evaluate are
  single forced-tool provider calls rather than turns, so no `heartbeat` tool
  ever enters the shared registry, and a decision that cannot be read becomes a
  skip rather than an unbounded turn on garbage.

  **A heartbeat is a job, not a second system.** Its interval is the job's
  schedule, its file and model are the payload, its on/off is the job's own
  flag — so the `scheduler.heartbeat` config block that described all of it a
  second time was deleted rather than wired up. What is left in `scheduler` is
  five knobs that are true of the engine and of no particular task: `enabled`,
  `concurrency`, `catchUpOnBoot`, `runRetention`, `timezone`. What remains of
  the original Heartbeat entry is only `targets` delivery, blocked on
  **Telegram**.

- **Subagents.** `agents.list.<id>.subagents` points one agent at others; each
  becomes a tool named `ask_<id>` whose description is the operator's own
  guidance, with its own `allow | ask | deny`. Delegation lives in `AgentLoop`
  rather than in a tool — `@ghostai/tools` sits below it, and `ToolContext` has
  no event sink — so a subagent's turn is a real turn on a real loop and its
  events stream out wrapped in `subagent.event`. It runs in a session of its
  own, in the caller's workspace, linked through the metadata bag the way a fork
  is; the session is excluded from the sidebar and deleted with its parent, and
  is what lets a reloaded transcript fetch the run back. Cycles and depth are
  refused with a tool result rather than a throw, `subagentTimeoutMs` finally
  reads, and an approval inside a subagent bubbles to the operator scoped to the
  conversation rather than to the delegation.
