# Configuration

One JSON file: `~/.ghostai/config.json`, or `$GHOSTAI_HOME/config.json`, or
`--home <dir>/config.json`. No YAML, no TOML, no XDG.

**A missing file is normal.** The schema produces a complete tree from `{}`, so every key
below has a default and an install with no config file runs. A _malformed_ file is a hard
error listing the dotted paths that failed — it will not silently fall back to defaults.

**It is safe to commit.** Credentials are never in it; they live in the encrypted vault.

Writes are atomic: validate, write `config.json.tmp` at mode `0600`, rename.

## Conventions in this tree

- `0` means "no limit" on anything named `*TimeoutMs` or `*PerMinute` — with one stated
  exception, `tools.maxOutputChars`, which is also an allocation bound.
- Durations always carry their unit in the name.
- Every nested object is prefaulted, so `{}` parses to a fully populated tree.
- There are no schema transforms anywhere, so the whole thing stays representable as JSON
  Schema and the OpenAPI document is generated rather than written.
- A relative path resolves against the GhostAI root, never against the process working
  directory.

---

## `agents.defaults`

What every agent inherits, and what an install with no named agents runs as.

| Key                            | Type                         | Default  | Notes                                                                                                                                          |
| ------------------------------ | ---------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `workspace`                    | string                       | `''`     | Empty means `<root>/workspace`. Deliberately not the literal path, so moving the root with `GHOSTAI_HOME` moves the workspace with it.         |
| `model`                        | string                       | `''`     | Empty means **unconfigured**, not "pick one". There is no model-picking code; an empty model makes every turn refuse with a message saying so. |
| `provider`                     | string                       | `'auto'` | An instance id, a bare provider type, or `auto`.                                                                                               |
| `maxTokens`                    | int > 0                      | `8192`   | Output cap per response.                                                                                                                       |
| `contextWindowTokens`          | int > 0                      | `65536`  | What the context inspector measures against.                                                                                                   |
| `temperature`                  | 0–2                          | _unset_  | Unset means the request carries no `temperature` at all, which is the only correct answer for models that reject it.                           |
| `maxToolIterations`            | int > 0                      | `40`     | Tool rounds in one turn.                                                                                                                       |
| `toolTimeoutMs`                | int ≥ 0                      | `0`      |                                                                                                                                                |
| `loopWallTimeoutMs`            | int ≥ 0                      | `0`      | Wall-clock cap on a turn, checked at the top of each iteration.                                                                                |
| `subagentTimeoutMs`            | int ≥ 0                      | `0`      | Applies to delegations _this_ agent makes.                                                                                                     |
| `reasoningEffort`              | `minimal\|low\|medium\|high` | _unset_  | Unset sends nothing.                                                                                                                           |
| `consolidationModel`           | string                       | _unset_  | A cheaper model for compaction. Falls back to `model`.                                                                                         |
| `learningEnabled`              | boolean                      | `true`   | _Declared, not yet read._                                                                                                                      |
| `learningInterval`             | int > 0                      | `10`     | _Declared, not yet read._                                                                                                                      |
| `memoryMaxPromptTokens`        | int ≥ 0                      | `2000`   | _Declared, not yet read._                                                                                                                      |
| `memoryCompactThresholdTokens` | int ≥ 0                      | `1600`   | _Declared, not yet read._ Lower than the cap on purpose: compaction should start before a turn discovers the limit.                            |
| `pinnedSkills`                 | string[]                     | `[]`     | _Declared, not yet read._                                                                                                                      |
| `maxPinnedSkills`              | int ≥ 0                      | `5`      | _Declared, not yet read._                                                                                                                      |

The keys marked _declared, not yet read_ belong to memory and skills, which are in
[BUILD_PLAN.md](BUILD_PLAN.md). They parse and persist; nothing consumes them.

## `agents.list.<id>`

Each entry is a **patch over `agents.defaults`** — every key above is overridable and
inherit-unless-set — plus the keys below. The id also names the agent's directory on disk.

`workspace` is deliberately not overridable: the working folder is a property of the
session, shared by every agent that opens it.

| Key            | Type                               | Default            | Notes                                                                                                        |
| -------------- | ---------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------ |
| `label`        | string                             | `''`               | Falls back to the id.                                                                                        |
| `systemPrompt` | string                             | `''`               | The agent's **whole** identity prompt as a template. Empty inherits the built-in. See [Prompts](prompts.md). |
| `livePrompt`   | string                             | `''`               | The per-iteration live-state block. Empty inherits; a single space deletes the section.                      |
| `wrapUpPrompt` | string                             | `''`               | Appended in the last few iterations. Empty inherits; a single space silences it.                             |
| `enabled`      | boolean                            | `true`             |                                                                                                              |
| `tools`        | `Record<string, allow\|ask\|deny>` | see below          | **Replaces, never merges.** A tool absent from the map is not enabled.                                       |
| `exec`         | patch of `tools.exec`              | _unset_            | Merged over the install-wide exec config, so one agent can hold a tighter allow-list.                        |
| `toolbox`      | `{ name, network }`                | `{ name: '', … }`  | Empty name runs `exec` on the host. See [Toolboxes](toolboxes.md).                                           |
| `memory`       | `{ shared: boolean }`              | `{ shared: true }` | Whether this agent also reads the layer shared by every agent in the folder.                                 |
| `subagents`    | `{ id, prompt, permission }[]`     | `[]`               | Agents this one may delegate to, in the order the model sees them.                                           |

A new agent is seeded with:

```json
{
  "read_file": "allow",
  "list_dir": "allow",
  "write_file": "allow",
  "edit_file": "allow",
  "exec": "ask"
}
```

That seeding is the one place a tool's risk band turns into a permission, and it happens
at creation where the operator can see the result and change it. Nothing reads a risk band
at call time.

### `agents.list.<id>.toolbox`

| Key             | Type                    | Default  | Notes                                                            |
| --------------- | ----------------------- | -------- | ---------------------------------------------------------------- |
| `name`          | string                  | `''`     | A toolbox name, or empty to run on the host.                     |
| `network.mode`  | `none\|allowlist\|open` | `'none'` | **Intersected** with the manifest's `maxMode`, never unioned.    |
| `network.allow` | string[]                | `[]`     | CIDRs only — a hostname allow-list is defeated by DNS rebinding. |

There is no `image`, `runtime`, `caps` or `limits` here, deliberately. Those live in the
toolbox manifest, which an operator installs and approves by hash. A value with no
representation in this schema cannot be reached by a config patch — which is what makes
"an agent cannot change the image it runs in" a property of the shape rather than a rule
somebody enforces.

### `agents.list.<id>.subagents[]`

| Key          | Type               | Default   | Notes                                                                                                                                    |
| ------------ | ------------------ | --------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `id`         | string             | —         | An id in `agents.list`.                                                                                                                  |
| `prompt`     | string             | `''`      | **The tool description the model reads.** This is what decides when it fires. Empty falls back to a sentence naming the agent.           |
| `permission` | `allow\|ask\|deny` | `'allow'` | Allow by default: an agent given a subagent is one whose operator wants it used. The tools the _subagent_ runs are gated by its own map. |

---

## `providers.<instanceId>`

Keyed by an **instance id you choose**, not by a provider id — which is how two Ollama
servers become two entries.

| Key            | Type                    | Default | Notes                                                           |
| -------------- | ----------------------- | ------- | --------------------------------------------------------------- |
| `type`         | string                  | —       | **Required.** A registry id: `ollama`, `openai`, `custom`, …    |
| `label`        | string                  | `''`    | Shown in the UI. Falls back to the type's display name.         |
| `apiBase`      | string                  | _unset_ | Falls back to the type's default. Required for `custom`.        |
| `extraHeaders` | `Record<string,string>` | `{}`    | Replaced wholesale by a patch, not merged.                      |
| `models`       | string[]                | `[]`    | A fallback list for endpoints that do not answer `GET /models`. |
| `enabled`      | boolean                 | `true`  | A disabled instance is kept and skipped.                        |

**No API key field.** Keys live in the vault under the namespace `providers`, keyed by the
same instance id — so the two entries below can hold different tokens, and this file can
be committed.

```json
{
  "agents": { "defaults": { "provider": "ollama-gpu", "model": "qwen3:8b" } },
  "providers": {
    "ollama": { "type": "ollama" },
    "ollama-gpu": { "type": "ollama", "label": "GPU box", "apiBase": "http://gpu.lan:11434/v1" }
  }
}
```

See [Providers](providers.md) for the registry table and the resolution order.

---

## `server`

| Key                       | Type        | Default       | Notes                                                                           |
| ------------------------- | ----------- | ------------- | ------------------------------------------------------------------------------- |
| `host`                    | string      | `'127.0.0.1'` | A non-loopback host with `auth.enabled: false` **refuses to start**.            |
| `port`                    | int 1–65535 | `3000`        | One port for the API, the WebSocket and the UI.                                 |
| `corsOrigins`             | string[]    | `[]`          | Extra browser origins. Same-origin always works.                                |
| `replayBufferSize`        | int ≥ 0     | `512`         | Events retained per session so a reconnecting tab can replay an in-flight turn. |
| `auth.enabled`            | boolean     | `true`        |                                                                                 |
| `auth.sessionTtlMs`       | int > 0     | 30 days       |                                                                                 |
| `auth.rateLimitPerMinute` | int ≥ 0     | `0`           | `0` is off.                                                                     |
| `auth.signedUrlTtlMs`     | int > 0     | 10 minutes    | Lifetime of the HMAC-signed URLs that serve workspace media to `<img>`.         |

`0.0.0.0` and `::` count as remote. All of `127.0.0.0/8`, `localhost` and `::1` count as
loopback. The refusal is a startup error rather than a warning because a warning scrolls
past, and the result is an unauthenticated shell-capable agent on a LAN address.

---

## `tools`

Install-wide tool settings. **Which tools an agent may call is not here** — that is
`agents.list.<id>.tools`. See [Tools & permissions](tools.md).

| Key                   | Type    | Default   | Notes                                                                                                                                                                                      |
| --------------------- | ------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `approvalTimeoutMs`   | int > 0 | 5 minutes | How long an `ask` prompt stays open before it counts as denied.                                                                                                                            |
| `restrictToWorkspace` | boolean | `true`    |                                                                                                                                                                                            |
| `maxOutputChars`      | int > 0 | `8192`    | Head+tail budget for one tool result. **`0` does not mean unlimited here** — `read_file` sizes its buffer from this, so `0` would read one byte of every file. Set a large number instead. |

### `tools.exec`

| Key                         | Type                            | Default                       | Notes                                                                                                                                                                                                  |
| --------------------------- | ------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `enable`                    | boolean                         | `true`                        | `false` removes `exec` from the definitions entirely, rather than advertising a tool that refuses.                                                                                                     |
| `timeoutMs`                 | int ≥ 0                         | `0`                           |                                                                                                                                                                                                        |
| `pathAppend`                | string                          | `''`                          | Appended to the child's `PATH`.                                                                                                                                                                        |
| `allowedBinaries`           | string[]                        | `[]`                          | `argv[0]` allow-list, matched on basename. **Empty means "anything not denied"** — the opposite convention to `agents.*.tools`, and deliberately so: this narrows a tool the operator already enabled. |
| `deniedBinaries`            | string[]                        | `[]`                          | Checked first.                                                                                                                                                                                         |
| `envAllowlist`              | string[]                        | `['PATH','HOME','LANG','TZ']` | Everything else is scrubbed from the child's environment.                                                                                                                                              |
| `maxOutputBytes`            | int > 0                         | `1048576`                     | Enforced while the child writes, not after it exits.                                                                                                                                                   |
| `installAudit`              | boolean                         | `true`                        |                                                                                                                                                                                                        |
| `installAuditTimeoutMs`     | int ≥ 0                         | `0`                           |                                                                                                                                                                                                        |
| `installAuditBlockSeverity` | `low\|moderate\|high\|critical` | `'high'`                      |                                                                                                                                                                                                        |

There are no patterns here for `$(...)`, backticks or `| sh`. The exec tool takes
`argv: string[]` and calls `execFile` with `shell: false`, so there is no string for a
shell metacharacter to live in — scanning for them would reject legitimate commands while
blocking nothing.

### `tools.web`

| Key                 | Type    | Default   |
| ------------------- | ------- | --------- |
| `proxy`             | string  | _unset_   |
| `search.provider`   | string  | `'brave'` |
| `search.baseUrl`    | string  | `''`      |
| `search.maxResults` | int > 0 | `5`       |

### `tools.mcpServers.<id>`

_The schema ships; the client does not. See [BUILD_PLAN.md](BUILD_PLAN.md)._

| Key                      | Type                                                         | Default          | Notes                             |
| ------------------------ | ------------------------------------------------------------ | ---------------- | --------------------------------- |
| `type`                   | `stdio\|sse\|streamableHttp`                                 | _unset_          | Inferred from `command` vs `url`. |
| `command`, `args`, `env` | string, string[], record                                     | `''`, `[]`, `{}` | For `stdio`.                      |
| `url`, `headers`         | string, record                                               | `''`, `{}`       | For the HTTP transports.          |
| `oauth`                  | `{ authUrl, tokenUrl, clientId, scopes, callbackTimeoutMs }` | _unset_          |                                   |
| `toolTimeoutMs`          | int ≥ 0                                                      | `0`              |                                   |
| `enabledTools`           | string[]                                                     | `['*']`          |                                   |
| `enabled`                | boolean                                                      | `true`           |                                   |

---

## `ui`

| Key      | Type          | Default | Notes                                                                                                                                                                          |
| -------- | ------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `locale` | BCP-47 string | `'en'`  | Unknown tags fall back to the nearest match and ultimately to English, rather than failing to parse and taking the whole file down. **`en` is the only shipped locale today.** |

## `channels`

| Key             | Type    | Default |
| --------------- | ------- | ------- |
| `sendProgress`  | boolean | `true`  |
| `sendToolHints` | boolean | `false` |

This object is **loose** by design: each channel — built-in or plugin — parses its own
block, so installing a channel does not require a schema change here.

## `audio`

| Key            | Type       | Default                    |
| -------------- | ---------- | -------------------------- |
| `providerUrl`  | string     | _unset_                    |
| `model`        | string     | `'whisper-large-v3-turbo'` |
| `ttsEnabled`   | boolean    | `false`                    |
| `ttsProvider`  | string     | `'browser'`                |
| `ttsVoice`     | string     | `'en_female'`              |
| `ttsSpeed`     | number > 0 | `1.0`                      |
| `ttsLang`      | string     | `'en'`                     |
| `ttsModelPath` | string     | _unset_                    |

## `rag`, `scheduler`, `plugins`

_All three are schema-only today. See [BUILD_PLAN.md](BUILD_PLAN.md)._

| Key                               | Type                         | Default                                                          |
| --------------------------------- | ---------------------------- | ---------------------------------------------------------------- |
| `rag.provider`                    | string                       | `'local'` (Ollama `/api/embed`)                                  |
| `rag.apiBase`                     | string                       | `''`                                                             |
| `rag.model`                       | string                       | `'nomic-embed-text'`                                             |
| `rag.chunkSize` / `chunkOverlap`  | int                          | `1024` / `128`                                                   |
| `rag.topK`                        | int > 0                      | `8`                                                              |
| `rag.hybrid`                      | boolean                      | `true`                                                           |
| `rag.rrfK`                        | int > 0                      | `60` — the constant from the reciprocal-rank-fusion paper        |
| `scheduler.enabled`               | boolean                      | `true`                                                           |
| `scheduler.concurrency`           | int > 0                      | `2`                                                              |
| `scheduler.catchUpOnBoot`         | boolean                      | `true`                                                           |
| `scheduler.heartbeat.enabled`     | boolean                      | `true`                                                           |
| `scheduler.heartbeat.intervalMin` | int > 0                      | `30`                                                             |
| `scheduler.heartbeat.model`       | string                       | _unset_                                                          |
| `scheduler.heartbeat.sessionKey`  | string                       | `'heartbeat:default'`                                            |
| `scheduler.heartbeat.file`        | string                       | `'TASK.md'` (workspace-relative)                                 |
| `scheduler.heartbeat.targets`     | `Record<channelId, address>` | `{}`                                                             |
| `scheduler.heartbeat.agentId`     | string                       | _unset_                                                          |
| `plugins.load`                    | string[]                     | `[]`                                                             |
| `plugins.disabled`                | string[]                     | `[]`                                                             |
| `plugins.allowUnverified`         | boolean                      | `false` — required before an arbitrary npm spec may be installed |
| `plugins.allowOverride`           | boolean                      | `false`                                                          |

---

## Patching

The UI and CLI send deep-partial patches through `PATCH /api/settings`. The rules:

- **A key the patch does not mention is untouched.** The patch schema strips defaults, so
  an absent key genuinely means "not mentioned" rather than "reset to default".
- **Arrays replace.**
- **These paths replace wholesale rather than merging** — `providers.*.extraHeaders`
  (merging per header would make deleting one impossible, since a patch has no syntax for
  "absent") and `agents.list.*` (an agent is edited as a whole, and almost every field is
  an override that may legitimately be cleared).
- **`null` deletes, and only at these paths** — `providers.*`, `tools.mcpServers.*`,
  `agents.list.*`, `agents.defaults.temperature`, `agents.defaults.reasoningEffort`.
  Everywhere else `null` is a validation error.
- **The merged tree is re-parsed** through the full schema, so a bad combination is a 400
  rather than a broken next boot.

Agents are created, renamed and deleted through `PATCH /api/settings` (which carries a
`renameAgents` field); `GET /api/agents` is read-only. Credentials go through
`PUT /api/settings/credentials`, which is write-only — nothing reads a key back out.

---

## Environment variables

| Variable                    | Does                                                                       |
| --------------------------- | -------------------------------------------------------------------------- |
| `GHOSTAI_HOME`              | The root directory. Same as `--home`.                                      |
| `GHOSTAI_PASSWORD`          | Fallback for `ghost serve --password`.                                     |
| `GHOSTAI_USERNAME`          | Fallback for `ghost serve --username`.                                     |
| `GHOSTAI_LANG`              | Locale override. Ranks above `config.ui.locale`, which ranks above `LANG`. |
| `GHOSTAI_LOG_LEVEL`         | Then `LOG_LEVEL`, then `info`.                                             |
| `GHOSTAI_DEBUG`             | Any non-empty value prints stack traces instead of the friendly message.   |
| `GHOSTAI_FIDELITY_ORIGINAL` | Path used by the optional e2e design-fidelity gate. Without it, it skips.  |

Provider keys — read only when the vault has no entry for that instance, because **the
vault wins over the environment**:

`OPENAI_API_KEY` · `ANTHROPIC_API_KEY` · `OPENROUTER_API_KEY` · `GEMINI_API_KEY` ·
`DEEPSEEK_API_KEY` · `GROQ_API_KEY` · `XAI_API_KEY` · `VLLM_API_KEY`

---

## CLI flags that override config

| Flag                        | Overrides                                                     |
| --------------------------- | ------------------------------------------------------------- |
| `--home <dir>`              | The root. Same as `GHOSTAI_HOME`.                             |
| `--host` / `--port`         | `server.host` / `server.port`.                                |
| `--workspace <dir>`         | The workspace root — moves the whole tree.                    |
| `--workspace-id <id>`       | Which workspace new conversations land in. A different thing. |
| `--model` / `--provider`    | `agents.defaults.model` / `.provider`, for one invocation.    |
| `--ui <dir>`                | Serve a UI built somewhere else.                              |
| `--password` / `--username` | Sets the login credential without the wizard.                 |
