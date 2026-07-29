# Build plan

Phase 1 (the agent from a terminal) and Phase 2 (the server and the web UI) are
done. This document is Phase 3 onward, at the granularity a session can pick up
and finish without re-deriving the design.

## How to read this

Every step below has the same four parts, and they are load-bearing:

- **Why** — the decision that would otherwise be re-made, differently, later.
- **Touches** — the files the change actually lands in. A step whose file list
  surprises the reader is a step that was scoped wrong.
- **Done when** — a criterion someone else can check. Never "implemented".
- **Edge cases** — the ones that are known now. Each is either handled in the
  step or written down here as deliberately out of scope. A blank list means
  nobody looked.

Two rules that apply to every step and are not restated in it:

- **The gate is `.github/workflows/ci.yml`, not `pnpm check`.** See `CLAUDE.md`.
  Run all three jobs before writing a summary, and say which ones you ran.
- **Never assert a transient state in an e2e test.** Assert the durable state a
  step settles into; cover the in-between wording in a component test, where the
  state can be held still. Also `CLAUDE.md`, also learned the hard way.

**Step 1 is first on purpose.** Every step after it adds a screen, and a screen
added to a system whose empty, error, offline and long-content states are
unsettled inherits every one of those gaps — then each has to be fixed six
times instead of once. Fixing the existing surface first is also what turns the
later steps into small additions rather than small additions plus a rediscovery
of what a loading state is supposed to look like here.

After that: 2, 3 and 4 are independent of each other. 5 wants 3 (the shared
command table). 6 wants 4 only for the `orchestrator` template and works
without it. 7 is independent of both. 8 can be done at any point and sits late
because it is the step most expensive to do twice. 9 is last by definition — it
documents what the other eight shipped.

---

## Phase 3 — the control surface

### Step 1 — The UI/UX pass

**What.** Not a redesign. Three things: the session list, a policy for content
too large to render, and the account surface that is missing outright.

**Why first.** These are defects that are individually too small to schedule and
collectively the whole impression of the product. They are also the ones that
compound: the session list gets a search box in Step 2, slash commands in Step
3, a task list in Step 7 — each of those inherits whatever this system's answer
is to "nothing here yet" and "this is 4 MB of text". Right now there is no single
answer to either, so each new screen invents one.

Everything here obeys `.claude/skills/ghostai-design/SKILL.md`: no new token
without deleting one, no `px` outside `tokens.css`, no raw colour, every text
pairing measured in both themes, native elements first. Run
`pnpm --filter @ghostai/web exec tsx src/tokens/run-gates.ts` — it is a CI job
and `pnpm check` does not call it.

**What came out of this step, and where it went.** The transcript, composer,
approval and connection sub-steps this section used to carry are gone, because
most of what they described has since shipped: `transcript-view.tsx` has
jump-to-latest, `approval.tsx` counts down against the server's `expiresAtMs`
and offers allow-for-the-session, `connection.ts` distinguishes a reconnect's
gap from a page load's, and `message.tsx` says when a failed turn is retryable.
Two things those sub-steps owned did **not** ship, and neither is orphaned:

- **The per-message DOM anchor.** `transcript-view.tsx` keys rows and addresses
  nothing; there is no `id` to scroll to. Step 2 needs it to open a search
  result at the matching message, so Step 2 now builds it.
- **The trigger character only opening a popover at the start of the message.**
  `mentions.ts` still anchors `@` at any word boundary, so typing a path opens
  the mention popover mid-word. Step 3 needs the same rule for `/`, so Step 3
  now establishes it for both.

Paste-and-drop image upload, the "new messages" divider and the mobile/a11y
audit are **dropped**, not deferred: they are worth doing and none of them
blocks another step, so they go in as ordinary work rather than as a gate on
Phase 3.

**1a — The session list.** Date grouping (Today / Yesterday / Earlier); a
running-turn indicator on a row whose turn is streaming in the background;
`confirm-dialog.tsx` wired into delete, which today deletes on a menu click with
no confirmation and no undo; a visible Cancel on the inline rename, which today
is Escape-only and therefore undiscoverable; roving arrow-key navigation.

**1b — Long content.** A 5 MB tool result, a 3 000-line file in the editor, a
turn with 200 tool calls. Each needs a threshold above which the card collapses
to a summary with an explicit expand, and the transcript needs a virtualisation
decision made once rather than per component.

**1c — Account settings: the session, its timeout, and the way out.**

The Account panel today changes a password and nothing else. Two things are
missing from it, and the second one is a hole rather than a nicety.

- **A sign-out button.** `POST /api/auth/logout` exists, revokes the presented
  session by id, clears the cookie and answers 204 — and **nothing in the web
  app calls it.** There is no `logout` on `api`; the only caller of that URL in
  the repo is `api.test.ts`. So the only way out of a signed-in browser today is
  to delete a cookie by hand or rotate the password, and rotating the password
  to leave a shared machine is the kind of workaround that ends with the
  password written down.
- **The session lifetime.** `server.auth.sessionTtlMs` defaults to 30 days and
  is editable in exactly one place: `config.json`, by hand. It is already
  accepted by `ConfigPatchSchema` (`server.auth` is a `patchOf(AuthConfigSchema)`),
  so the write path needs nothing new — this is a field and a label, not a
  feature.

**The one thing that has to change on the server.** `AuthStore` takes
`sessionTtlMs` in its constructor (`app.ts`) and holds it in a `readonly #ttlMs`,
so a saved change does nothing at all until the process restarts — a settings
field that silently no-ops is worse than no field. `AuthStore` takes a getter
rather than a number and reads it at mint time, which is the smallest change
that makes the save real and keeps the store ignorant of the config tree.
Sessions already issued keep the `expires_at_ms` they were minted with, and the
cookie's `Max-Age` is derived from that same value, so the two cannot disagree;
the panel's copy has to say that shortening the timeout applies to the next
sign-in, because the obvious reading is that it applies now.

**And one schema hole to close while here.** `sessionTtlMs` is
`z.number().int().positive()` — which accepts `1`, and a one-millisecond session
TTL is an install nobody can sign into. It gains a floor (5 minutes) and a
ceiling (a year), enforced in the schema rather than in the input, because the
CLI and a hand-edited `config.json` reach the same field.

The panel presents it in minutes/hours/days, never raw milliseconds, and shows
when the current session expires — `/api/auth/me` already returns `expiresAtMs`
and nothing renders it.

**Touches.** `packages/web/src/app/sidebar.tsx` and
`packages/web/src/styles/screens/sidebar.css` (1a), `packages/web/src/chat/**`
and `packages/web/src/files/**` (1b), `packages/protocol/src/config.ts`
(the TTL bounds), `packages/server/src/app.ts` and
`packages/server/src/auth-store.ts` (the live TTL read),
`packages/web/src/lib/api.ts` (`logout`),
`packages/web/src/settings/account-panel.tsx`,
`packages/web/src/settings/settings.test.tsx`,
`packages/e2e/src/tests/sessions.spec.ts` and `setup.spec.ts`.

This is an auth change, so `CLAUDE.md`'s list applies: the credential surface
spans further than it looks. Nothing here adds a DTO — logout has no body and
the TTL rides the existing settings patch — so `rest.ts` and `schemas.ts` stay
put, and the e2e harness only matters if a test pins a non-default TTL.

**Done when.** The session list groups by date, confirms a delete and can be
driven from the keyboard; a tool result and a file above the threshold collapse
to a summary with an explicit expand; the Account panel shows when this session
expires, changes the timeout with the new value applying to the next sign-in,
and signs out to the login overlay with the query cache cleared; the token gates
pass; and the e2e additions assert only durable states.

**Edge cases.**

- **Signing out must clear the React Query cache.** Otherwise the next sign-in —
  possibly as a different account on a shared machine — paints the previous
  session's conversations, workspaces and settings from cache before any request
  answers.
- **`auth.enabled: false`.** On a loopback dev install there is no session to
  revoke and no login overlay to land on. The button is disabled with the reason
  rather than present and inert; `/api/auth/me` already returns `authEnabled`.
- **Signing out while a turn is streaming.** The socket closes with the session;
  say so on the button rather than dropping a turn silently.
- **A TTL edit that is really a lockout.** The floor covers the accidental
  version. There is no defence against a deliberate 5-minute TTL, and none is
  wanted.
- **The date grouping's boundaries are local midnight**, not 24-hour windows, and
  a tab left open overnight recomputes them rather than captioning yesterday's
  conversations as Today.
- The remaining edge cases are the content of 1b; the ones deferred rather than
  fixed get a line in this file saying so.

---

### Step 2 — Session search, and a session list that pages

**What.** A search box over the session list, matching titles and message text,
scoped to the current workspace; and the sidebar list paging as it is scrolled
instead of showing whatever the first request returned.

**Why.** The pagination half is nearly built and unused: `listSessions` already
takes a keyset `after` cursor, `GET /api/sessions` already returns `nextCursor`,
and `cursor.ts` already encodes an opaque `SessionListCursor`. What the browser
does with all of that is call `api.sessions(workspaceId)` once and render the
first page as though it were the whole list — so an install past 50
conversations silently loses the rest, with no empty state to say so.

The search half is not built at all, and the reason to build it on FTS5 rather
than a `LIKE` scan is that the useful query is over _message text_, not titles.
A title is derived from the first message, so title-only search finds a
conversation by how it opened and never by what it turned into.

**Design.**

- One FTS5 external-content table over `messages`, kept in step by triggers, in
  a new `SessionStore` migration. External content (`content='messages'`) rather
  than a copy, so the text is not stored twice.
- **Probe, do not assume.** FTS5 is present in `node:sqlite` on the versions
  checked, but it is a compile-time option of the SQLite the Node binary embeds,
  and `engines` allows ≥ 22.11. The migration creates the virtual table inside a
  `try`; a failure records `search_mode = 'like'` in a store-level settings row
  and everything downstream degrades to a `LIKE '%…%'` scan with a hard `LIMIT`.
  A search that is slower is a worse product; a boot that fails on a supported
  Node version is a broken one.
- `SessionStore.searchSessions({ query, workspaceId, limit, after })` returns
  `SessionSummaryRecord` plus `{ matchSeq, snippet }` — the seq is what makes a
  result clickable _into the message_ rather than to the top of a conversation.
- **The per-message anchor is built here**, because this is the first thing that
  needs it. `transcript-view.tsx` keys its rows and gives them no `id`, so there
  is nothing for a link to address. A stable `id` per message seq, and a
  scroll-into-view that respects the transcript's own bottom-anchoring rather
  than fighting it. `/branch` gets it for free.
- **Search pagination does not use the list cursor.** The list is ordered
  `updated_at_ms DESC, key ASC`, which is a stable keyset; search is ordered by
  rank, which is not a column a reader can be positioned in. Search pages with
  `(rank, key)` and caps at a page count rather than promising an infinite
  scroll — the honest shape for a relevance list.

**Touches.** `packages/core/src/session-store.ts` (migration, triggers, search
query), `packages/protocol/src/rest.ts` (`SessionSearchResponseSchema`,
`SessionSearchResultSchema`) and `schemas.ts` (registration — a test enforces
it), `packages/server/src/queries.ts` (`q` on `SessionListQuery`),
`packages/server/src/routes/sessions.ts`, `packages/web/src/lib/api.ts`,
`packages/web/src/app/sidebar.tsx`, `packages/web/src/styles/screens/sidebar.css`,
`packages/web/src/chat/transcript-view.tsx` (the per-message anchor).

**Done when.** Typing in the sidebar's search box narrows the list to matching
conversations with a highlighted snippet; clicking a result opens that
conversation scrolled to the matching message; scrolling the unfiltered list past
the first page loads the next; and `packages/core/src/session-store.test.ts`
covers the `like` fallback path as well as the FTS5 one.

**Edge cases.**

- A query of only punctuation, or an unbalanced quote, is an FTS5 syntax error.
  User input is never passed to `MATCH` raw — tokenise and re-quote each term.
- A conversation renamed while a search is open: the result set is a snapshot,
  and a stale title is corrected on the next keystroke rather than live-patched.
- Search must not leak across workspaces. The workspace predicate is in the SQL,
  not in a client-side filter over a larger result set.
- Deleting a session with 10 000 messages has to delete its FTS rows too;
  external-content tables need the `delete` trigger to fire _before_ the row
  goes, which is the ordering bug this kind of table is famous for.
- Empty result vs. empty list are different states and need different copy —
  "No conversations match _foo_" is not "No conversations yet."
- The e2e assertion is the settled filtered list, never the intermediate spinner.

---

### Step 3 — Slash commands in the browser

**What.** The command vocabulary `packages/cli/src/commands.ts` already
implements, available in the web composer: type `/`, get a filtered list, Enter
runs it.

**Why.** Everything in the CLI's `HELP` is a thing the browser can already do
through a menu, a dialog or a route — and every one of them takes the hands off
the keyboard. The point is not parity for its own sake; it is that a chat
interface's fastest control surface is the box the user is already typing in.

**The drift risk is the whole design.** Two hand-maintained command tables is one
command table plus a lie. So:

- A new `packages/protocol/src/commands.ts` holds the **spec** — a frozen table
  of `{ name, args, summary, scope }` where `scope` is `'cli' | 'web' | 'both'`.
  It is data, not behaviour: no handler lives there, because the CLI mutates the
  store in-process and the browser goes over REST and the socket, and a shared
  handler would need an abstraction over both that nothing else wants.
- `commands.ts` in the CLI renders `/help` from the table instead of a string
  literal, and a test asserts that every `case` in its `dispatch` has a table
  entry with a matching scope, and vice versa. That test is what actually stops
  the drift — the shared table alone would not.

**Which commands are web-scoped.** `/exit` and `/quit` are `cli`. `/copy` and
`/theme` are `web`. Everything else is `both`, including `/agents` and
`/agent <id>` — see Step 5, where the whole point is that switching agents is a
chat command rather than a `ghost` subcommand. `/edit` and `/regenerate` map onto
the `user.edit` and `turn.regenerate` socket frames that already exist, so the
browser reuses the hub's one turn-running path exactly as the CLI reuses its own.

**Touches.** `packages/protocol/src/commands.ts` (new) and `index.ts`,
`packages/cli/src/commands.ts`, `packages/web/src/chat/commands.ts` (new,
parsing and dispatch), `packages/web/src/chat/composer.tsx`,
`packages/web/src/chat/mentions.ts` (the shared position-0 predicate),
`packages/web/src/styles/screens/chat.css`.

**Done when.** `/` at the start of an empty composer opens a filtered listbox;
Enter runs the highlighted command; `/help` renders the same table the CLI
prints; unknown commands are refused before send; and the CLI/web parity test
passes.

**Edge cases.**

- **`/` only opens the menu at position 0**, and **this step establishes that
  rule for `@` too.** `mentions.ts` currently anchors at any word boundary — its
  own comment concedes it "does not anchor, but every real mention in practice
  starts a word" — so typing `src/foo` would open a command palette mid-path and
  typing an email address already opens the mention popover. One predicate, both
  triggers, tested once.
- **Sending a literal leading slash.** `//` escapes to a single `/`. Without an
  escape, "…/usr/bin is on PATH" typed as the first word is unsendable.
- **An unknown command is not sent as a message.** It shows an inline notice and
  leaves the text in the box. Silently sending `/regenrate` to the model is the
  worst of the three options.
- **A command that cannot run right now is listed as disabled with a reason**,
  not hidden. `/branch` needs a session that exists; `/regenerate` needs a turn
  that happened. A menu whose contents change based on invisible state is a menu
  nobody learns.
- The listbox reuses the mention popover's accessibility shape —
  `role="listbox"`, `aria-activedescendant`, focus staying in the textarea — and
  the two must not both be open. `/` and `@` are mutually exclusive at position 0.
- Arrow keys inside the menu must not also move the caret.

---

### Step 4 — Predefined agent templates

**What.** A table of ready-made agents — a system prompt, a tool selection, an
approval posture — that an operator can start from instead of filling in an
empty form.

**Why.** `agents.list` is expressive enough to express a bad agent very easily:
an empty `tools.allow` means "everything not denied", the approval bands default
to asking only for exec and network, and the system prompt field replaces rather
than extends. The three of those together mean the default new agent is the
_most_ capable one, and a template table is how a safer starting point becomes
the path of least resistance rather than a paragraph in a doc.

**Templates are seeds, not links.** Applying one writes an `agents.list` entry
and nothing afterwards references the template again. The alternative — an agent
that inherits from a template id — means an upgrade silently rewrites a running
agent's prompt and tool access, which is a supply-chain change disguised as a
version bump. Stated here because the inheritance version is the one that looks
more elegant in a design doc and is wrong.

**The initial table.**

| id             | Posture                                                               |
| -------------- | --------------------------------------------------------------------- |
| `coder`        | read/write/exec inside the jail; exec asks; a tight `allowedBinaries` |
| `researcher`   | read + web; no write, no exec                                         |
| `reviewer`     | read only; every write and exec denied, not merely asked              |
| `ops`          | exec allowed with every band on `ask`; the deliberate slow one        |
| `writer`       | read/write; no exec; a prose-shaped prompt                            |
| `orchestrator` | `spawn_agent` allowed and little else — the front end of Step 6       |

**Touches.** `packages/protocol/src/templates.ts` (new; the table plus
`AgentTemplateSchema`) and `schemas.ts`, `packages/server/src/routes/agents.ts`
(`GET /api/agents/templates`), `packages/web/src/agents/agents-page.tsx` and a
new `template-gallery.tsx`.

Creation itself stays a `PATCH /api/settings` with an `agents.list` patch, as
`routes/agents.ts` already documents — the template endpoint returns the patch
the client is about to send, so there is one write path for an agent and not two.

**Done when.** "New agent" offers the gallery with a plain-language description
of each posture; picking one and naming it produces an entry whose diff against
`agents.defaults` is exactly the template; and a template naming a tool this
install does not have applies without it _and says which ones it dropped_.

**Edge cases.**

- A template that names a tool the registry does not have yet (`web_search`
  before Phase 4). Filter against the live registry at apply time and report the
  drop — silently swallowing it produces an agent that is quietly weaker than the
  description the operator read.
- An id that collides with an existing agent: the dialog refuses, it does not
  overwrite.
- An id that is not a legal directory name — agent ids name directories on disk
  and follow the workspace id rules (`packages/core/src/agent-id.ts`).
- `reviewer` must deny writes rather than un-allow them, because `deny` wins over
  `allow` and a later blanket allow-list would otherwise resurrect them.

---

### Step 5 — `/agents`: switching agents from the prompt

**What.** Two slash commands, in both front ends via Step 3's shared table:

```
/agents            the agents this install can run, marking the current one
/agent [id]        show which agent is running, or switch to another
```

**The `ghost` command surface does not grow.** No `ghost agents`, no
`ghost sessions`, no `ghost tasks`. This is a decision, not an omission, and it
is the one worth stating loudest here because the alternative is the obvious
thing to build.

**Why.** A second family of subcommands would be a second implementation of
things the REPL already does — `/sessions`, `/rename`, `/delete`, `/branch` all
exist in `packages/cli/src/commands.ts` today — reachable only by leaving the
conversation you are in. The prompt is already attached to a session, a workspace
and an agent; a subcommand has to be told all three on every invocation. And
every new top-level command is a new entry in `--help`, a new argument parser,
and a new way for the two paths to disagree about what `--workspace` means.

So the rule for the whole plan: **the terminal's control surface is the REPL.**
`ghost` keeps `chat`, `init` and `serve`. Anything that manages state gets a
slash command, which Step 3 then gives the browser for free. Step 7's tasks
follow the same rule — `/tasks`, not `ghost tasks`.

**Creation and editing stay where they are.** Defining an agent means a system
prompt, a tool allow/deny list, approval bands per risk band and an exec
allow-list — a form, not a command line. That form is the Agents screen, and the
other honest terminal answer is editing `config.json`, which is already
documented, already validated on load and already the file the UI writes.
`/agents` is for _switching_, and switching is the thing anyone does more than
once a day.

**What it costs to build: almost nothing.** `GhostRuntime` already exposes
`agents: readonly EffectiveAgent[]` and `requireLoopFor(agentId)`, and the loop
cache already keeps one `AgentLoop` per agent. The REPL holds a pending agent id
beside the pending workspace id it already holds, `/agent <id>` sets it, and
`chat.ts` calls `requireLoopFor(pending)` where it currently calls
`requireLoop()`.

**The one real decision: what `/agent` does to a session that already exists.** A
session is bound to an agent when it is created, and the stored row wins over a
frame from then on. `/agent <id>` therefore **rebinds the current session** via
`updateSession({ agentId })` and says so, rather than silently applying only to
the next conversation — the workspace behaviour, which does not rebind, is right
for workspaces because a workspace is where the files are and moving a
conversation between them would invalidate every path in its history. An agent is
only who is answering, and mid-conversation is exactly when someone wants to hand
over to the reviewer.

**The config watcher lands here**, for the case the CLI deliberately no longer
covers: `config.json` edited by hand, or by the UI on another host, while
`ghost serve` is running. `packages/server/src/boot.ts` watches the file,
debounces, re-parses and calls the runtime's existing all-or-nothing
`reconfigure`. A parse failure keeps the running config, logs at `error` and
writes a notification — a server that dies because someone fat-fingered a comma
is worse than one running yesterday's settings and saying so.

**Touches.** `packages/protocol/src/commands.ts` (two table entries),
`packages/cli/src/commands.ts` (`/agents`, `/agent`, and `HELP` gaining the
section), `packages/cli/src/chat.ts` (the pending agent id and
`requireLoopFor`), `packages/web/src/chat/commands.ts`,
`packages/server/src/boot.ts` (the watcher). `packages/cli/src/program.ts` is
deliberately untouched.

**Done when.** `/agents` lists every runnable agent with the current one marked;
`/agent reviewer` switches mid-conversation and the next turn demonstrably runs
under the reviewer's prompt and tool scope; `/agent` with no argument reports
which agent is answering; the same two commands work in the browser composer;
`ghost --help` lists exactly `chat`, `init` and `serve`; and a hand-edit of
`config.json` is picked up by a running server without a restart.

**Edge cases.**

- `/agent` naming an agent that is disabled or does not exist: the refusal lists
  the known ids, which `resolveAgent` already does — surface its message rather
  than writing a second one.
- Switching **while a turn is running**. The rebind takes effect on the next
  turn: `AgentLoop` is constructor-bound to its agent, so the running turn keeps
  the one it started under. Say that in the confirmation rather than leaving it
  to be discovered.
- Switching to an agent whose provider has no credential: refuse at the switch,
  where someone is watching, rather than at the next turn.
- `/agents` on an unconfigured install still lists `default` — it always
  resolves, and its `enabled` flag is ignored by design.
- The browser has an agent picker in the composer already. `/agent` must drive
  the same state, not a second copy of it, or the picker and the command disagree
  about who is answering.
- A watcher that fires on its own writes. Debounce and compare content, or a UI
  save triggers a reconfigure that triggers a save.
- Editors that write via rename (vim) vs. in place (`>`) produce different fs
  events; watch the directory, not the inode.

---

### Step 6 — Subagents

**What.** An agent can hand a scoped task to another agent and get its answer
back as a tool result.

**Why.** This is the feature that makes several configured agents worth more than
one: a `reviewer` with no write access is a safety property only if something can
_call_ it. It is also the feature most likely to be built as an unbounded
recursion with a provider bill attached, which is why most of what follows is
caps.

**Where it lives.** A `spawn_agent` tool needs the loop cache, and
`@ghostai/tools` sits below `@ghostai/agent` in the layer graph. So the tool is a
factory in `@ghostai/agent` — `createSpawnAgentTool({ loops, budget, depth })` —
registered by `@ghostai/runtime`, which already owns the `LoopCache`. The agent
package must never reach back into the server; nothing here does.

**Shape.**

```
spawn_agent({ agent: string, task: string, timeoutMs?: number })
  → the child's final text, as the tool result
```

**The caps, and why each one.**

| Cap                                   | Default | Without it                                             |
| ------------------------------------- | ------- | ------------------------------------------------------ |
| `maxSubagentDepth`                    | 2       | A prompt injection becomes an infinite tree            |
| `maxSubagentsPerTurn`                 | 4       | One turn fans out to the provider's rate limit         |
| `subagentTimeoutMs` (exists already)  | 0/off   | A wedged child hangs the parent turn forever           |
| A token budget shared across the tree | derived | Each child is individually reasonable, the tree is not |
| `subagents.allow` per agent           | `[]`    | Every agent can call every agent; there is no posture  |

`subagents.allow` empty means **none**, which is the opposite of the convention
`tools.allow` uses — and deliberately. An empty tool allow-list means "anything
not denied" because a new agent that can do nothing looks broken; an empty spawn
list meaning "anything" would make every template silently an orchestrator. The
asymmetry is worth the comment it needs in the schema.

A cycle guard on top of the depth cap: an agent may not appear twice on its own
ancestor chain. Depth alone permits A→B→A at depth 2, which is the loop the cap
was for.

**Cancellation and approvals.** The parent's `AbortSignal` threads into the child
loop, its provider fetch and its tools — one cancellation mechanism, per the repo
convention. The child's approval requests go to the _same_ gate as the parent's,
tagged with the child's agent id and the parent turn id: an approval prompt that
does not say which agent asked is a prompt an operator cannot answer.

**What the transcript shows.** New `subagent.start` / `subagent.end` server
events, and a `subagent` block on the existing `tool.call` / `tool.result` frames
so a nested card can render inline. Child sessions are **real rows** with
`origin: 'subagent'` and a `parentSessionKey` column — hidden from the sidebar,
reachable from the tool card via "open transcript". Discarding the child's
transcript would make every subagent failure undiagnosable, which is precisely
when someone needs it.

Child usage rolls into the parent's `turn_stats` row _and_ stays on the child's
own, so the info panel can answer both "what did this turn cost" and "what did
the reviewer cost".

**Touches.** `packages/protocol/src/config.ts` (`subagents` on `AgentEntry`,
depth and fan-out on `AgentDefaults`), `packages/protocol/src/ws.ts` +
`schemas.ts`, `packages/agent/src/subagent.ts` (new),
`packages/agent/src/loop.ts` (budget threading),
`packages/core/src/session-store.ts` (the `parent_session_key` migration),
`packages/runtime/src/runtime.ts`, `packages/web/src/chat/tool-card.tsx` and
`subagent-card.tsx` (new), `packages/server/src/hub.ts` (event forwarding).

**Done when.** An `orchestrator` agent asked to review a file spawns `reviewer`,
the transcript renders a nested card that expands to the child's messages,
stopping the parent turn stops the child within one heartbeat, and depth,
fan-out and cycle caps each have a test that shows the refusal reaching the model
as a tool error it can act on.

**Edge cases.**

- A child that returns nothing (empty final text): the tool result says so rather
  than returning `""`, which the model reads as success.
- A child that hits its timeout: a tool _error_ with the partial text attached,
  not a hang and not a silent truncation.
- A named agent that is disabled, missing, or has no provider credential — three
  different messages, all actionable, all before the child loop is built.
- A parent aborted mid-child: the child aborts, its session row is kept and
  marked cancelled.
- Approval timeout inside a child (`approvals.timeoutMs`, 5 min) while the
  parent's own wall clock is shorter. The shorter deadline must win, and the
  message must say which one fired.
- Budget exhaustion mid-tree: the refusal is a tool error, and the parent gets the
  chance to answer from what it has. Killing the parent turn wastes everything
  already spent.
- The nested card at 360px, and a tree three deep — indent by depth, cap the
  visual indent, and do not build a horizontally scrolling transcript.

---

### Step 7 — Tasks: the scheduler, the heartbeat, and CRUD for both

**What.** Scheduled and interval jobs, and the heartbeat that reads a markdown
file and decides whether anything needs doing. Full CRUD from the web UI and,
per Step 5's rule, from a `/tasks` slash command rather than a `ghost` subcommand.

**Why now.** The vocabulary already exists and nothing implements it. Rechecked
against the tree, what is built is:

- `packages/protocol/src/automation.ts` — schedules (`at` / `every` / `cron`),
  both payload kinds, the delivery block, `AutomationJob`, `AutomationJobState`,
  `AutomationRun`, `RunStatus` and the create/update DTOs. All sixteen are
  registered in `schemas.ts`, so the OpenAPI document already describes an API
  that does not exist.
- `rest.ts` — `AutomationJobListResponse` and `AutomationRunListResponse`, both
  registered, neither served by a route.
- `config.ts` — `SchedulerConfig` (`enabled`, `concurrency: 2`,
  `catchUpOnBoot`) and `HeartbeatConfig` (`enabled`, `intervalMin: 30`, `model`,
  `sessionKey`, `file: 'TASK.md'`, `targets`, `agentId`), both in the settings
  tree and both already reachable through `ConfigPatchSchema`.
- The seams downstream: `NotificationEventSchema.jobId` is documented as "set
  when raised by an automation run", and `sessions.origin` — a persisted column —
  already lists `automation` as one of its values in `SessionListQuery`.

What is missing is everything that runs: no `packages/scheduler`, no tables, no
timer, no cron evaluator, no `routes/tasks.ts`, no `/tasks` route in the web app,
no `api.*` methods (the header comment in `packages/web/src/lib/api.ts` says so
in as many words), and no CLI commands. So this step writes code against a
vocabulary that is already fixed, which is the cheap half of the work.

**One word for it: `task`.** The wire DTOs are `Automation*` and the UI would
call them Tasks, which is two names for one concept and the reason a doc and a
screen eventually disagree. Rename the exported DTOs to `Task*` (nothing ships
yet — this is a mechanical pre-alpha rename), keep `automation.ts` as the file
that holds the _schedule_ vocabulary, and register the renamed schemas in
`schemas.ts`.

**A new `@ghostai/scheduler` package**, between `agent` and `server` in the layer
graph — the README's layout already reserves the slot.

- `TaskStore` — `tasks` and `task_runs` tables in `ghost.db`, created through
  `migrate(db, 'tasks', […])` like every other store. Runs are real rows, not
  last-run-only state, so a nightly job that failed on Tuesday is still
  diagnosable on Friday.
- `Scheduler` — **one** timer against the injected `Clock`, re-armed for the
  earliest `nextRunAtMs`. Not one timer per job: a hundred jobs is a hundred
  timers a fake clock has to advance in the right order.
- `nextCronTime(expr, tz, afterMs)` — hand-rolled, in this package, with property
  tests under `fast-check` (already a devDependency). A 5-field cron evaluator is
  a known quantity; the timezone comes from
  `Intl.DateTimeFormat(…, { timeZone })`, so it needs no dependency and no tz
  database of its own.
- `Heartbeat` — the decide/run/evaluate triad the schema comment describes. Read
  `TASK.md` through the jail; ask a cheap model with a forced `heartbeat` tool
  that returns `skip | run` and a reason; on `run`, run a real turn in the job's
  session; then evaluate the output for whether it is worth interrupting anyone.
  Every outcome writes a run row, including `skipped` — a heartbeat that leaves no
  trace when it decides nothing is exactly the one you cannot debug.

**The heartbeat is specified twice today, and this step collapses it to once.**
`scheduler.heartbeat` in the settings tree describes one install-wide heartbeat
with its own `intervalMin`, `sessionKey`, `file`, `model`, `agentId` and
`targets`; `HeartbeatPayloadSchema` describes a heartbeat as a job payload, with
its own `file` and `model` and whatever schedule the job carries. Built as
written, those are two runtimes that can both be passing over `TASK.md` on
different intervals with neither aware of the other, and an operator who turns
one off and watches the other keep going.

So: **the config block seeds a job, it does not run anything.** At boot the
scheduler ensures one built-in task with the reserved id `heartbeat`, whose
schedule is `{ kind: 'every', everyMs: intervalMin * 60_000 }` and whose payload
is the `heartbeat` payload the config describes. There is exactly one execution
path — the scheduler — and `scheduler.heartbeat` is the settings _for that one
job_. It follows that the built-in job is not deletable from the Tasks screen
(disabling it is `scheduler.heartbeat.enabled: false`, which is where an
operator will look), and that editing its schedule in the UI writes the config
rather than the row, or the next boot overwrites it. A second, hand-made
heartbeat job is still allowed — it is just an ordinary task with a heartbeat
payload, and it is visible in the same list as everything else.

**REST.** `GET|POST /api/tasks`, `GET|PATCH|DELETE /api/tasks/:id`,
`POST /api/tasks/:id/run` (run now, ignoring the schedule),
`GET /api/tasks/:id/runs` (cursor-paged, like every other listing here).

**Live updates: polling, deliberately.** The socket hub is session-scoped
(`SessionHub` keys everything by session key), and making it app-scoped to push
task state is a larger change than this step earns. The Tasks screen polls the
runs list while any job is running and relies on the existing notification centre
for completion. Written down so the next person does not read the polling as an
oversight.

**Web, and it is two surfaces, not one.** The split is the same one Providers
and Agents already draw: settings live in a settings panel, records live on a
page.

- **`/tasks`** holds the records. A table of name, schedule (in words, not
  cron), next run, last status, an enable switch and a run-now button; a
  run-history drawer; and an editor dialog whose schedule builder **previews the
  next three fire times**. That preview is the single most effective defence
  against a wrong cron expression, and it is cheap because the evaluator is
  already pure.
- **Settings → Automation** holds the settings, and it is a placeholder today:
  `scheduler.enabled`, `scheduler.concurrency`, `scheduler.catchUpOnBoot`, and
  the built-in heartbeat's own block. Nothing in it is a job. Saying so here
  because the panel is named "Automation" and the obvious thing to build inside
  it is the job list, which would then exist in two places.

**The panel is also lying about when it arrives, and the test does not catch
it.** `packages/web/src/settings/panels.ts` marks Automation as **Phase 5** and
lists "Scheduled jobs" and "Heartbeat" as Phase 5 systems; this plan builds them
in Phase 3, here. The other two placeholders are wrong in the same direction:
Extensions says Phase 3 for MCP, skills, channels and OAuth, which this plan puts
in Phase 4, and Knowledge says Phase 5 for RAG, which is Phase 4. `panels.test.ts`
asserts only that the numbers are internally consistent — that a planned panel
lists something, and that no system is promised earlier than its panel — so all
six can be wrong together and stay green.

The fix has two halves. Automation loses its `phase` outright, because this step
builds it — and that half is already guarded: `panels.test.ts` asserts the built
list is exactly `['providers', 'tools', 'account']`, so the suite goes red until
someone updates it deliberately. Extensions becomes 4 and Knowledge becomes 4,
with the per-system numbers under `PLANNED_SYSTEMS` moved to match, and each one
gains the plan reference in a comment — a number with no citation is a number
nobody can check. What is _not_ worth building is a test that parses this
document; the numbers change once per phase, and the cheap guard for a wrong one
is that it is written next to the sentence that explains it.

**Terminal.** `/tasks` lists with next run and last status; `/task <id>` shows
one with its recent runs; `/task run <id>` fires it now; `/task on|off <id>`
toggles. Creating a task with a cron expression and a delivery target is a form —
the Tasks screen — for the same reason creating an agent is.

**Touches.** `packages/scheduler/**` (new package, manifest via
`node scripts/gen-packages.mjs`), `packages/protocol/src/automation.ts` +
`rest.ts` + `commands.ts` + `schemas.ts`,
`packages/server/src/routes/tasks.ts` (new) and `routes.ts`,
`packages/server/src/boot.ts` (start/stop with the process),
`packages/web/src/routes/tasks.tsx` + `packages/web/src/tasks/**` +
`styles/screens/tasks.css`, `packages/web/src/settings/automation-panel.tsx`
(new) with `panels.ts` and `panels.test.ts` (the phase correction),
`packages/cli/src/commands.ts`, `packages/e2e/src/tests/tasks.spec.ts`.

**Done when.** A task created in the UI fires on its schedule under a fake clock
in tests and under a real one in a manual run; its runs appear in the history with
status and output; `deliver: false` still records the run and notifies without
interrupting; the heartbeat skips with a reason on an unchanged `TASK.md` and
runs as one job in the same list as every other, not as a second timer;
`/tasks` lists the same rows the screen does; Settings → Automation is a form
rather than a placeholder and no panel still names a phase this plan disagrees
with; and coverage stays above the scheduler package's gate.

**Edge cases.** This is the step where they _are_ the work:

- **A laptop that slept for eight hours.** An `every: 15min` job must fire once on
  wake, not 32 times. Coalesce missed fires; `catchUpOnBoot` governs `at` jobs
  only, and a one-shot whose time passed fires once then self-destructs if
  `deleteAfterRun`.
- **DST.** A 02:30 daily job on the spring-forward day fires once, at 03:30 — not
  zero times and not twice. On the autumn repeat it fires once. Both get a
  property test with a pinned zone.
- **Overlapping runs of the same job.** The second is skipped with
  `skipReason: 'previous run still in flight'`, not queued. A slow nightly job
  queueing 30 copies of itself is how an install runs out of memory overnight.
- **A failure loop.** After N consecutive errors, back off exponentially and raise
  a notification — but never auto-disable. A job an operator finds disabled with
  no record is worse than one that is failing loudly.
- **A job whose agent was deleted, or whose provider lost its credential.** The
  run records `error` with the reason; the _save_ validates the agent exists, so
  the common case fails at edit time where someone is watching.
- **`deliver: true` with no channel configured** — refused at save, not at fire.
- **`sessionKey` overriding the isolated per-run session** is how a nightly job
  grows an unbounded context window. The schema already defaults to fresh; the UI
  must say what setting it costs.
- **Timezone absent** means the host zone, and the host zone can change (a laptop
  crossing one). Recompute `nextRunAtMs` on resume rather than trusting the stored
  value.
- **Concurrency.** `scheduler.concurrency` defaults to 2; a third due job waits
  rather than being dropped, and waiting is visible in the UI.
- **Run output size.** A run that produced 4 MB of text is truncated on the way
  into `task_runs` with the truncation marked, or the database grows without
  bound.
- **The reserved `heartbeat` id.** A task the operator creates may not claim it,
  and the seeded row is reconciled with the config on every boot rather than
  inserted once — otherwise changing `intervalMin` edits a file nothing reads
  again.
- **`scheduler.enabled: false` with jobs due.** Nothing fires and nothing
  accumulates a backlog; the screen says the scheduler is off rather than
  showing next-run times that will not happen. Turning it back on recomputes
  from now, which is the same coalescing rule the sleeping laptop gets.

---

### Step 8 — Installation and deployment

**What.** The three ways someone installs this — npm, Docker, a service on a box
— plus `ghost doctor`, backup/restore, and the upgrade path.

**Why it is a step and not a README section.** Nothing exists today: no
Dockerfile, no compose file, no service unit, no publish pipeline, and every
package is `version: 0.0.0`. "It runs from a source checkout" is a demo, not an
install.

**8a — npm.** `npm i -g @ghostai/cli` has to work, which means the CLI package
ships the built web UI (it depends on `@ghostai/web`, and `serve` resolves the UI
root from it), a `prepublishOnly` that builds, `publishConfig.access: public`,
and a real version. One `pnpm release` script that versions the workspace
together — this is one product, and independently versioned internal packages buy
nothing but a compatibility matrix.

**8b — Docker.** Multi-stage on `node:22-alpine` — `node:sqlite` is built in, so
there is no native module to compile and no build-essential in the runtime image.
A non-root user; `GHOSTAI_HOME=/data` as the one volume; a `HEALTHCHECK` against
`/api/health`, which already returns a typed `HealthResponse`; the UI dist baked
in. A `docker-compose.yml` with an optional `ollama` service, a named volume, and
an `.env.example` carrying `GHOSTAI_USERNAME` / `GHOSTAI_PASSWORD` so the first
run is non-interactive.

**8c — A service on a box.** A systemd unit and a launchd plist, both with the
home directory, the log level and a restart policy; documented, not generated.

**8d — Behind a reverse proxy, and a real security decision.** The login throttle
buckets by address. Behind nginx, every attempt arrives from the proxy, so **the
per-address scope collapses into one bucket** and either locks everyone out or is
trivially useless. The fix is a `server.trustProxy` setting that is **off by
default** and, when on, names how many hops to trust — because trusting
`X-Forwarded-For` unconditionally lets an attacker choose their own bucket and
defeat the throttle entirely. This is an auth change, so it touches more than it
looks like: `packages/server/src/login-throttle.ts`, `app.ts`, `routes/auth.ts`,
the two web overlays, and the e2e harness (`packages/e2e/src/harness/server.ts`,
`fixtures.ts`, `fidelity/capture.ts`). See `CLAUDE.md`.

**8e — `ghost doctor`.** The one new subcommand this plan adds, and it earns the
exception to Step 5's rule: it has to run when the server does _not_ come up,
which is exactly when no REPL and no browser is available. Node version;
`GHOSTAI_HOME` existence and permissions; `PRAGMA integrity_check` on `ghost.db`;
the vault key readable and the keychain reachable; each configured provider
reachable with its credential; the workspace jail resolving to a real directory;
the port free; the UI dist present; clock skew; free disk. `--json` output and a
non-zero exit on any failure, so it is usable as a container readiness probe.

**8f — Backup and restore.** `ghost backup` produces one archive: `config.json`,
the database via `VACUUM INTO` (never a file copy of a live SQLite database), and
`vault.json`. **`vault.key` is excluded by default** — an archive containing both
halves is a plaintext credential dump, and `--include-key` should be a thing
someone typed on purpose. `ghost restore` refuses to overwrite a non-empty home
without `--force`. Both are flags on `doctor`'s sibling rather than a third
family: `ghost backup` and `ghost restore`, and that is the end of the growth.

**8g — The upgrade path, and a bug to fix while here.**
`packages/core/src/migrate.ts` returns early when the recorded version is at or
ahead of the migration list — so an **older binary opens a newer database and
runs against a schema it does not understand**, silently. A downgrade must throw,
naming both versions. Add it with the test.

**Done when.** `docker compose up` reaches a login page with no host Node
installed; a published tarball installs globally and `ghost serve` serves the
bundled UI; `ghost doctor` fails loudly on a deliberately broken install; a backup
restores into an empty home and the sessions are there; and an older binary
refuses a newer database.

**Edge cases.**

- A non-loopback bind with auth disabled already refuses to start. Confirm the
  container path hits that refusal rather than tripping over it.
- `GHOSTAI_HOME` on a bind mount whose uid does not match the container user — the
  single most common Docker complaint. Detect and say so at boot.
- An air-gapped install: nothing in the image may fetch at runtime, which the
  design system already requires of the UI and which `self-contained.test.ts`
  already enforces for assets.
- A restore across a schema upgrade: restore, then migrate, in that order.
- The one-line `curl | sh` installer, if it ships, pins a version and verifies a
  checksum. An unpinned pipe-to-shell for a tool that runs commands on the host is
  not a convenience worth its risk.

---

### Step 9 — Documentation

**What.** The README brought up to what actually ships, and a `docs/` directory
that is more than this file.

**Why last.** Documentation written ahead of the code documents an intention, and
the gap between the two is invisible to everyone except the person who hits it.
The README already says things that are aspirational rather than true — the
Telegram bot is described as "the built-in chat channel" and no channel is
implemented; the layout lists `mcp/`, `memory/`, `rag/`, `scheduler/`,
`plugin-sdk/` and `plugin-host/` as though those packages existed. That is fine
in a pre-alpha README that says so at the top, and not fine the day someone
installs it from npm.

**The documents, and what each is for.**

| File                    | Answers                                                                |
| ----------------------- | ---------------------------------------------------------------------- |
| `README.md`             | What is this, does it do what I need, how do I run it in five minutes  |
| `docs/CONFIGURATION.md` | Every key in `config.json`: type, default, what it changes             |
| `docs/DEPLOYMENT.md`    | Docker, systemd, reverse proxy, backups, upgrades — Step 8, written up |
| `docs/SECURITY.md`      | The threat model, and what is explicitly not defended against          |
| `docs/ARCHITECTURE.md`  | The layer graph, why it runs one direction, where a seam is            |
| `CONTRIBUTING.md`       | The gate, the conventions, how to add a tool / provider / channel      |
| `CHANGELOG.md`          | Kept from the first published version, not retrofitted after three     |

**The configuration reference is generated, or it will be wrong within a
month.** `ConfigSchema` has ~90 leaf fields and grows every step in this plan; a
hand-written table is a table that silently drifts. A script walks the schema and
emits each path with its type and default; the prose for each path lives in a
sibling map keyed by the same path — **and a test fails when a schema path has no
prose entry.** That test is the whole mechanism. Without it this is just a
generated table nobody updates the words in.

The same trick for the CLI: a test compares the README's flag table against
commander's registered options, so a flag renamed in `program.ts` fails the suite
rather than the reader.

**`SECURITY.md` is the one that has to be honest about limits.** The vault, the
jail, argv-only exec, the SSRF guard, the nonce wrapping, the two-scope login
throttle and the approval gate are all real. What is _not_ defended: an agent
with `exec` is a shell on the host by construction, and the jail bounds file
tools rather than child processes; a prompt injection in a fetched page can drive
any tool the agent already has; `trustProxy` off means an install behind a proxy
has a throttle with one bucket until someone turns it on. Writing those down is
what makes the rest credible.

**In-app help comes from the same source as the docs.** `/help` renders from the
command table (Step 3), so a docs page listing commands renders from it too, and
the OpenAPI document `@fastify/swagger` already generates is published rather
than regenerated by hand into prose.

**Touches.** `README.md`, `docs/CONFIGURATION.md`, `docs/DEPLOYMENT.md`,
`docs/SECURITY.md`, `docs/ARCHITECTURE.md`, `CONTRIBUTING.md`, `CHANGELOG.md`,
`scripts/gen-config-docs.mjs` (new), `packages/protocol/src/config-docs.ts` (the
prose map) and its coverage test, `packages/cli/src/program.test.ts` (the flag
table check).

**Done when.** The README describes only what ships and shows the install that
Step 8 made real; every `ConfigSchema` path has a documented meaning and the
coverage test proves it; `docs/` holds the five documents; the CLI flag table
test passes; and the pre-alpha disclaimer either goes or says something narrower
and true.

**Edge cases.**

- Documenting a feature that is behind a config flag defaulting to off — say
  which, or the reader files a bug that it does nothing.
- Screenshots are assets in the repo, never remote images. Same rule as the UI:
  air-gapped installs, and a README that leaks a reader's IP to a host.
- Install instructions pin a version. `latest` in a copy-pasted command is how
  someone lands on a build nobody tested against their data.
- `CLAUDE.md` is instructions for an agent working _in_ this repo and
  `CONTRIBUTING.md` is for a human contributing to it. They overlap; the
  duplicated parts live in one and are linked from the other.

---

## Phase 4 — context and reach

Sequenced but not yet expanded to the detail above; each becomes a step's worth
of plan when it is next.

- **Memory.** Per agent under `<root>/agents/<id>/memory`, plus the layer shared
  per working folder under `<root>/shared/<workspaceId>`. Both paths exist and are
  deliberately outside the jail. They arrive in the prompt through
  `ContextContributor` (`packages/agent/src/prompt.ts`) — the seam is built and
  nothing implements it. `AgentDefaults` already carries the budgets:
  `memoryMaxPromptTokens`, `memoryCompactThresholdTokens`, `consolidationModel`,
  `learningEnabled`, `learningInterval`.
- **Skills.** Same seam, same directories, plus `pinnedSkills` /
  `maxPinnedSkills` and the `@skill:` mention that is already parsed and already
  reaches `runtimeSection` with nothing reading it.
- **MCP client.** `McpServerConfig` is fully specified in the settings tree —
  stdio, SSE and streamable HTTP, OAuth, per-server tool enablement — and there is
  no `@ghostai/mcp` package. `@mcp:` mentions scope tool exposure per turn.
- **MCP server.** Expose GhostAI's own tools to other agents.
- **Telegram.** The `Channel` / `ChannelFactory` contract and `ChannelManager`
  exist and are tested; Telegram is the first real consumer, and it must go
  through the same contract a plugin would or the contract rots.
- **Sandboxed tools.** The `CommandRunner` seam is in place and `exec` routes
  through it; what is missing is a docker backend. `AgentSandbox.kind: 'docker'`
  parses and is refused at agent resolution until one exists
  (`packages/runtime/src/agents.ts`).
- **Plugin SDK and host.** Versioned contract, discovery, manifest validation,
  lifecycle, capability gating; install/uninstall from the UI. WhatsApp and
  Discord ship as external plugins, which is the proof the contract is real.
- **RAG.** `RagConfig` exists — embedder, chunking, hybrid BM25 + vector with RRF,
  `topK`. The `@kb:` mention scopes retrieval. Last, because it is the item most
  likely to be wanted less than it looks.
- **Audio.** `AudioConfig` exists for STT and TTS; the `audio.transcribe` socket
  frame is already in the protocol.

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
  temperature, reasoning effort, context window, tool allow/deny, approval and
  exec overrides, sandbox and memory scope. One `AgentLoop` per agent, cached;
  one shared workspace, store, registry and provider cache. A session is bound to
  an agent through `sessions.agent_id`, and the stored row wins over a frame once
  the session exists.
