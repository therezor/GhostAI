# Web UI

React 19 and Vite, served by the same process as the agent. TanStack Router and Query,
Zustand for chat state, Radix for the headless primitives, Shiki for highlighting loaded
on demand.

**No CSS framework.** Hand-written CSS in five cascade layers — `reset`, `base`,
`layout`, `components`, `screens` — declared in that order. A component names what it _is_
(`.tool-card`, `.sidebar__link`) and the stylesheet says what that looks like.

**No external asset, ever.** Fonts come from npm, icons are inline, and two tests enforce
it — one scanning the source, one running the whole app in a browser with every foreign
origin blocked. See [Security](security.md#privacy).

## Screens

| Route                             | What it is                                                    |
| --------------------------------- | ------------------------------------------------------------- |
| `/`                               | Chat. `?session=` picks the conversation.                     |
| `/agents`, `/agents/:id`          | Agent list and editor.                                        |
| `/workspaces`, `/workspaces/:id`  | Workspace list and editor.                                    |
| `/files`                          | File browser. `?path=` and `?workspace=` are in the URL.      |
| `/notifications`                  | The archive.                                                  |
| `/settings`                       | `?panel=` picks the tab.                                      |
| `/settings/providers/:instanceId` | One endpoint's editor.                                        |
| `/tokens`                         | Every design token and primitive on one page. Not in the nav. |

The shell is two columns; below `md` the sidebar becomes a drawer rather than a narrowed
rail. The header carries the wordmark, a connection badge with a Reload action, the
notification bell and the theme switcher.

**The WebSocket hangs off the root route**, so moving between screens never redials it and
never drops a running turn.

## Chat

- Answers stream in; reasoning arrives in a separate collapsible block.
- **Tool cards** — one per call, with the risk badge, running/succeeded/failed status,
  progress ticks for slow calls, and a flag when output was truncated.
- **Approval prompts** show the arguments before the call runs, and take Approve once /
  this session / always, or Deny. See [Tools & permissions](tools.md#answering).
- **Subagent cards** nest inside the call that started them, and can be reopened after a
  reload.
- **Notices** badge prompt injection, degraded requests, provider fallback and truncated
  history.
- **Turn info** — tokens in and out, cached tokens, elapsed, tokens per second, model,
  provider, step count, stop reason.
- Markdown with highlighted code blocks.

### Composer

- Auto-growing textarea measured with a mirror element, so it holds up under browser zoom.
- **Send ⇄ Stop follows the session status.** Enter still queues while a turn is running,
  and the composer says the message is queued rather than going grey.
- **Steering** — what you type mid-turn reaches the running turn, not the next one.
- **Attachments upload when you pick them**, not on send, so a large file is already there
  when you hit Enter.
- **`@` autocomplete** for `@kb:`, `@mcp:` and `@skill:`, as a real listbox with
  `aria-activedescendant`. The grammar is parsed once, in the protocol, for every channel.
  _The mention kinds are parsed and carried today; the features behind them are in
  [ROADMAP.md](ROADMAP.md)._
- An agent picker, and a context budget strip.

### Message actions

**Edit** a user message and re-run from the new wording. **Regenerate** an answer.
**Branch** either into a new conversation, leaving the original intact. **Info** for the
turn's cost. **Copy**.

Destructive actions are disabled mid-turn, and anything needing a sequence number stays
disabled until the message has landed.

### Context inspector

A bar showing the whole context window and where it went — system prompt, tool
definitions, conversation — with overflow stated in words rather than a clipped bar. It is
the same measurement the CLI's `/context` prints and `GET /api/sessions/:key/context`
returns, so all three agree.

This is the screen that answers "why did it forget what I said".

## Files

Browse the workspace tree with filter and sort. Upload by button or drop. Create folders
and files, rename, move, delete with a confirm. Text editing with syntax highlighting, and
**save-conflict detection** — if the agent changed the file underneath you, the save is
refused rather than silently winning. Media previews go through short-lived signed URLs.

## Workspaces

Create one with a folder of its own choosing. Rename the label without moving the folder,
or move the folder on disk — which renames the directory and repoints the conversations.
Move conversations between workspaces. A workspace with conversations cannot be deleted
until they move.

Switching workspace moves the Files page and the session list. Workspaces do not see each
other.

## Agents

Create, rename, enable, delete. Per agent: the model, provider, reasoning effort and
temperature; limits (output tokens, context window, tool iterations, tool timeout, turn
timeout); the **system prompt**, live-state and wrap-up templates with a warning for stray
placeholders; the **per-tool permission map**; the **toolbox** and its network mode, with a
warning when a request is narrower than the manifest ceiling; and the **subagent list**,
each with its own description and permission.

Model and budget live on the agent, not in Settings — they are properties of an agent, and
an install with several agents has several answers.

## Scheduled jobs

A page rather than a settings panel, in the nav above Settings, built out of the same CRUD
chrome as Agents and Workspaces: filter, sort, `DataList` rows, a kebab, a create dialog
and a confirm on delete. Per job: the schedule (once at a time, on an interval, or on a
cron expression with its own zone), what it does (a fixed message, or a heartbeat that
reads a task file and decides), the agent it runs on, an optional pinned session key, and
delivery. Below it, the **run history** — each run's outcome, output, skip reason, error
and any warnings.

The scheduler's own switches are **not** here — enabled, catch-up on boot, default
timezone, concurrency and how much history to keep per job are install-wide, and live in
Settings → Automation. The split is the one Agents already makes: the agents are a page,
and only install-wide tool settings sit in Settings.

A row reports where the last run **landed** and when the next one is due, never whether one
is in flight. Keeping that honest would mean polling, and it is exactly the transient state
the e2e rule says not to build a UI around.

## Creating things

Every CRUD screen follows one rule: **`New X` is a link to `/x/new`, not a dialog.** That
route renders the same component the editor renders, seeded from defaults instead of from
a stored row, plus whatever fields only exist at creation. Save writes and navigates to
the row it made; the editor's Save patches.

The rule exists because a dialog that creates on submit has to invent the settings to
create _with_ — a job got a message made from its name, an agent a copy of the default
one, a workspace a `mkdir`. Abandoning the editor you landed on left that invented row
behind. Nothing is written before Save now, so an abandoned create leaves nothing.

| Screen         | Route                     | Asked only at creation                                    |
| -------------- | ------------------------- | --------------------------------------------------------- |
| Scheduled jobs | `/automation/new`         | —                                                         |
| Agents         | `/agents/new`             | The identifier, which follows the name until you type one |
| Workspaces     | `/workspaces/new`         | The folder — a `mkdir` now, a `rename(2)` later           |
| Providers      | `/settings/providers/new` | The type, fixed for the life of an instance               |

Duplicating an agent stays a direct create: it has a source to copy, so there is nothing
to fill in first.

## Settings

| Panel      | State                                                                                                                                                                  |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Providers  | Built. Add by type, save endpoint and key in one press, test the connection before saving, per-endpoint model catalogue, enable/disable, delete takes the key with it. |
| Tools      | Built. Install-wide only: approval timeout, `exec` settings, output caps. **No permission matrix here** — permission is per tool per agent.                            |
| Account    | Built. Username and password together, requires the current password, revokes every other session.                                                                     |
| Appearance | Built. Language and timezone (install-wide) and theme (this browser only).                                                                                             |
| Automation | Built. The scheduler engine only: enabled, concurrency, catch-up on boot, run retention, default timezone. **The jobs are a page.**                                    |
| Extensions | Placeholder naming its phase — MCP, skills, OAuth, channels, plugins.                                                                                                  |
| Knowledge  | Placeholder — the knowledge base.                                                                                                                                      |

The placeholders are shown rather than hidden, and each names what it will hold. A
setting that silently does not exist is worse than one that says when it will.

## First run

Five steps: language → code → password → provider → model. Language first, because
everything after it is prose. The code and password are mandatory; the provider and model
are skippable, and skipping lands you in a working app — files, workspaces, settings and
notifications all work, and only the composer is disabled, with a link to the panel that
fixes it.

## Theme

Three states, not two: `dark`, `light` and `system` — following the OS is a real choice,
not the absence of one. The stored value is the _preference_; the resolution is stamped
onto the document by a blocking inline script before first paint, so there is no flash.

Dark-first, but **every end-to-end assertion runs twice**, once per scheme, because
reviewing only in dark is how a light theme ships broken.

## Design tokens

`styles/tokens.css` is the **only** file allowed to contain a raw colour or a `px`
literal. Every colour derives from a per-theme seed block in OKLCH — about two dozen
numbers — and the tokens are formulas over them. Every length is a `rem`, so browser zoom
works. Elevation is a surface plus a stroke; there is no shadow scale.

Three gates enforce it, run in CI as their own step because no single linter reads all
three, and they hold across CSS, TSX class strings and `index.html`:

1. **`no-px`** outside `tokens.css`
2. **`no-raw-color`** outside `tokens.css`
3. **`accent-position`** — `--accent` fills; `--accent-fg` is text, icons and strokes

Plus a contrast test that parses the real stylesheet in both themes and holds every
text-on-surface pairing to WCAG AA. A seed edit that darkens text past the line fails the
suite rather than shipping.

`/tokens` in the running app renders every token and primitive on one page, which is the
fastest way to see what a change did.

## Accessibility

Held by tests rather than by intent: at 200% font size every screen reflows without a
horizontal scrollbar and the composer stays usable; every screen fits a phone; every
keyboard stop takes a visible focus ring; dialogs trap focus, close on Escape and return
focus; every message action is reachable and named; and no theme is second-class — there
is no invisible text on any screen in either.

## Languages

The translation layer is complete and **English is the only shipped locale**. The JSON
bundle _is_ the type, so a misspelled key is a compile error, and errors carry a
translatable key across package boundaries.

Adding a language is a `locales/<tag>/` directory plus one entry in the supported list —
negotiation, plural handling and right-to-left detection already work.

## Working on it

Run `pnpm --filter @ghostai/web dev` for an edit-reload loop; Vite proxies `/api` and
`/ws` to a running `ghost serve`.

**Restart `ghost serve` after a production UI build.** It enumerates the UI directory once
at boot, so a rebuild underneath a running server serves the new `index.html` and 404s its
hashed assets into the SPA fallback. The result is a blank page that looks like a crash
and is not one.
