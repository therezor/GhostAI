# Architecture

One process. It serves the agent, a REST API, a WebSocket and the static UI on a single
port, and writes to one SQLite file. Nothing in it is heavy enough to justify a
split-process topology and the reconnect-and-fall-back-to-HTTP client that would need.

## The packages

Fourteen, plus one example. Each is a published-shaped workspace package with its own
tests and its own coverage bar.

| Package              | Does                                                                                                                |
| -------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `@ghostai/protocol`  | Zod schemas → types, JSON Schema and OpenAPI. Zero runtime deps but `zod`.                                          |
| `@ghostai/core`      | Message types, `SessionStore`, `WorkspaceStore`, `MessageBus`, `Logger`, `Clock`, config loading, history windowing |
| `@ghostai/security`  | `WorkspaceJail`, `guardExec`, `guardedFetch`, `CredentialVault`, nonce fencing, toolbox manifests and approvals     |
| `@ghostai/providers` | The provider registry, the `openai-chat` wire adapter, SSE parsing, `withResilience`, token counting                |
| `@ghostai/tools`     | `defineTool`, `ToolRegistry`, the built-in tools, the local and container runners                                   |
| `@ghostai/mcp`       | The MCP client, connection lifecycle and the bridge from a remote tool onto `Tool`                                  |
| `@ghostai/agent`     | `AgentLoop`, the approval contract, prompt assembly, steering, subagents                                            |
| `@ghostai/runtime`   | The composition root: config → provider, jail, store, registry, one loop per agent                                  |
| `@ghostai/channels`  | The `Channel` contract, `ChannelManager`, `TurnProjection` and the Telegram adapter                                 |
| `@ghostai/server`    | Fastify: REST, the WebSocket hub, auth, static UI, OpenAPI                                                          |
| `@ghostai/web`       | The React SPA                                                                                                       |
| `@ghostai/cli`       | The `ghost` binary                                                                                                  |
| `@ghostai/i18n`      | The i18next instance, locale negotiation, typed keys                                                                |
| `@ghostai/e2e`       | Playwright, plus the optional design-fidelity gate                                                                  |

### Layering

```
protocol → core → { security, providers } → tools → { mcp, agent } → runtime → server → cli
```

Dependencies only run downward, and the rule is enforced two ways, both mechanical:

1. **pnpm's isolated `node_modules`.** A package can only resolve `@ghostai/x` if it
   declares it in `dependencies`. The manifests _are_ the layer graph — an undeclared
   import fails to resolve, not merely to lint.
2. **`no-restricted-imports`** bans the deep relative imports (`../../*`) that would
   sneak across a package boundary.

The agent must never reach back into the HTTP server. One consequence is visible in the
subagent design below: delegation lives in `AgentLoop` rather than in a tool, because
`@ghostai/tools` sits underneath it and `ToolContext` has no event sink.

## A turn

`AgentLoop.run(input)` returns an `AsyncGenerator<AgentEvent, TurnResult>`. The caller
drives it with `for await`, and abandoning the iterator unwinds the turn through the same
`finally` an abort would. There is no `onToken` callback anywhere.

Per iteration, up to `maxToolIterations` (default 40):

1. **Drain the steering queue.** Anything the operator typed while the turn was running
   is appended as a user message, prefixed so the model can tell it apart from the
   original request. Capped at 16 pending.
2. **Check the abort signal, then the wall clock.** `loopWallTimeoutMs` is checked at the
   _top_ of the iteration — a turn should not discover it is out of time halfway through
   a provider call.
3. **Rebuild the runtime half of the prompt** and assemble the request as
   `[system] + history(sessionKey)`.
4. **Stream from the provider.** `assistant.delta` and `reasoning.delta` go out as they
   arrive; the terminal event carries the finished `ChatResult`.
5. **No tool calls** → append the assistant message and finish, unless steering arrived
   while the model was talking, in which case the loop continues.
6. **Tool calls** → authorize, execute, and append the assistant message and every tool
   result in one transaction.

`stopReason` is one of `complete`, `aborted`, `wall_timeout`, `max_iterations`, `error`.

### Invariants

These explain most of the surrounding design, and each one exists because its absence
caused a specific failure:

- **History is append-only.** A provider's prompt cache keys on an exact prefix, so no
  stored message is ever mutated. Regenerate and edit drop a _suffix_, which changes no
  prefix and is therefore allowed.
- **An error response is never appended.** A provider 400 in the transcript poisons the
  session forever — every subsequent turn replays it.
- **A denied or cancelled tool call still gets a `tool` message.** Providers reject an
  assistant turn whose `tool_calls` went unanswered, so a refusal is a _result_, not an
  omission.
- **Tool definitions and the turn's nonce are computed once per turn.** Recomputing them
  per iteration would rewrite the cached prompt prefix five or ten times a turn.
- **`messages[0]` is rewritten, not supplemented.** Two system messages is a shape some
  providers reject and others quietly reorder, and the ordering is what the cache depends on.
- **One cancellation mechanism.** A single `AbortSignal` threads from the request through
  the loop, the provider fetch, tool execution and any child process.

### Events

Every event the loop yields is a server message minus its sequence number — the hub just
stamps a counter, and a test asserts that property rather than trusting it.

`turn.start` · `assistant.delta` · `reasoning.delta` · `tool.call` · `tool.progress` ·
`tool.approvalRequest` · `tool.result` · `notice` · `error` · `turn.end` ·
`subagent.event`

`tool.progress` is emitted on a fixed 15-second heartbeat while a tool runs, so a slow
command looks alive rather than hung.

`notice` is the loop telling the operator something without derailing the turn:
`prompt_injection`, `degraded`, `truncated_history`, `provider_fallback`,
`approval_denied`, `agent_fallback`.

### History windowing

`historyForLLM` runs four ordered steps: keep the last `maxMessages` (default 500), start
at the first `user` message, align to a legal tool-call boundary, then truncate tool
results (default 8,000 characters, head and tail with the middle marked).

The boundary alignment is the part that matters. A window that cuts through a tool
exchange leaves either an orphaned tool result or an unanswered tool call, and both are a
provider 400. Truncation is head-and-tail rather than head-only because the end of a
command's output is usually where the error is.

## Subagents

An agent can be given other agents to delegate to. A subagent is not a different kind of
thing — it is an ordinary entry in `agents.list` that another entry points at, so a
researcher is configured, tested and used on its own, and being someone's subagent is a
relationship rather than a mode.

Each becomes a tool named `ask_<id>` (hyphens become underscores), taking a single
required `task` string. The tool _description_ is the operator's own guidance, which is
the part that decides when the model reaches for it.

- **Delegation lives in the loop, not in a tool.** A subagent's turn is a real turn on a
  real loop, and its events stream out wrapped in `subagent.event`.
- **It runs in a session of its own**, in the caller's workspace, linked through metadata
  the way a fork is. That session is excluded from the sidebar and deleted with its
  parent — and is what lets a reloaded transcript fetch the run back.
- **Depth is capped at 3, and cycles are refused** — both as a tool _result_ rather than
  a throw, so the model can adapt instead of the turn dying.
- **Nesting forwards rather than recurses.** A grandchild's event is passed through with
  only its `turnId` rewritten, which keeps the wire schema non-recursive.
- **An approval inside a subagent bubbles to the operator** scoped to the session
  they are looking at, not to the delegation.
- **The timeout is the caller's** `subagentTimeoutMs`, composed with `AbortSignal.any`.
  It kills the child, not the parent turn.

## What is on disk

Everything under `~/.ghostai`, or `$GHOSTAI_HOME`. Directories are created `0700`.

| Path                      | Contents                                                                                                           |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `config.json`             | The settings tree. Written atomically via a `0600` temp file and a rename.                                         |
| `ghost.db`                | One SQLite file, one connection, one WAL.                                                                          |
| `vault.json`, `vault.key` | The encrypted credential vault.                                                                                    |
| `workspace/`              | The jail root. Named workspaces are subdirectories of it.                                                          |
| `agents/<id>/`            | Per-agent state — **outside the jail**, so `write_file` cannot rewrite the agent's own prompt.                     |
| `shared/<workspaceId>/`   | The layer agents in one folder share. Also outside the jail.                                                       |
| `toolboxes/<name>/`       | Installed manifests. Outside the workspace, so injection cannot edit the policy the agent runs under.              |
| `runs/<containerId>/`     | Sandbox command transcripts. Outside the workspace — a symlink-planting escape was demonstrated before this moved. |
| `logs/`, `plugins/`       | —                                                                                                                  |

### The database

`node:sqlite`, built into Node 22 — no prebuilds, no compiler on the install path. One
`DatabaseSync` connection is shared by every store so all writes land in one WAL. Every
table is `STRICT`.

| Table                                            | Holds                                                             |
| ------------------------------------------------ | ----------------------------------------------------------------- |
| `sessions`                                       | Key, title, origin, agent, workspace, metadata, sequence counters |
| `messages`                                       | Append-only, `(session_key, seq)` unique, cascade-deleted         |
| `turn_stats`                                     | Per turn: model, provider, iterations, stop reason, token counts  |
| `workspaces`                                     | Id, label, root                                                   |
| `auth_secrets`, `auth_sessions`, `auth_throttle` | Password, username, setup code, sessions, throttle counters       |
| `notifications`                                  | The bell and the archive                                          |
| `toolbox_approvals`                              | The sha256 of each approved manifest's exact bytes                |
| `automation_jobs`                                | Schedule and payload as JSON, plus the indexed `next_run_at_ms`   |
| `automation_runs`                                | One row per execution: status, output, warnings, session key      |

`seq` is both the ordering and the pagination cursor. Timestamps are not usable for
either, because a turn writing parallel tool results collides on them.

`sessions.origin` is `web`, `cli`, `telegram`, `automation`, `subagent`, or a plugin id.
Session listing excludes `subagent` **and `automation`** unless asked for one by name.
Both are real rows and neither is a session: one turn, started by a model. Automation
is the one that scales badly if it leaks — a job on a five-minute interval writes about
105,000 sessions a year, and the sidebar is a list of sessions a person had.

A job's `schedule` and `payload` are JSON columns rather than a flat set of nullable ones.
They are discriminated unions, and the union exists precisely so `{kind: 'cron', atMs: 5}`
cannot be represented; spreading them into columns would rebuild that. `state` _is_
decomposed, because `next_run_at_ms` has to be indexable for the timer's due query. Run
history is trimmed per job rather than globally — one shared ceiling would let a busy job's
afternoon evict a nightly job's whole year.
