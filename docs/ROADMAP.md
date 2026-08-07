# Roadmap

What is left to build, one line each. No design here — the design happens when a
feature is picked up. The order is the order they were asked for, not a
schedule, and nothing depends on anything else unless it says so.

Every unchecked item already has its schema, config block or contract in the
tree. Read that first; it is the difference between building the feature and
building a second one beside it.

## Planned

- [ ] **Session search page** — find a session by what was said in it.

## Done

- [x] **Extensions** — a directory an operator installs under
      `~/.ghostai/extensions`, approved by a digest over every byte it holds,
      loaded into the server process. It may add tools, channels, providers,
      prompt sections and slash commands — the five registries that already
      existed, plus a command surface that did not. `ExtensionContext` is a
      _recorder_ rather than the registries: `activate` fills a bag and the host
      applies it, which is what makes unload exact and a half-finished
      `activate` install nothing at all. `reconcile` never throws, so one broken
      extension is a row with a sentence beside it rather than a boot that
      refuses. The digest covers the **directory**, not the manifest, and that
      is the one place this deliberately diverges from toolboxes: a toolbox
      manifest pins an immutable image, so hashing it hashes the code, while an
      extension manifest names a path and hashing it would approve a pointer.
      Three things are deliberately not built. **There is no sandbox** — an
      extension runs in-process with full `node:` access, `contributes` is
      disclosure rather than enforcement, and `docs/security.md` says so instead
      of implying otherwise. **Nothing fetches**: `extensions.load` takes a
      path, never a package spec, which is what keeps an air-gapped install
      air-gapped and is why the drafted `allowUnverified` flag was deleted
      rather than wired. **Reloading changed code needs a restart**, because
      Node's module registry has no eviction; the digest gate makes that visible
      by refusing to load a `drifted` extension at all.

- [x] **Slash commands in the composer** — `/new`, `/clear`, `/rename`,
      `/stop`, `/branch`, `/agent` and `/model`, each reporting in a toast, with
      a `/` autocomplete that also completes an agent or model id. Three read
      differently from the terminal on purpose and each says why at its
      definition in `packages/web/src/chat/commands.ts`: `/new` takes no title,
      `/branch` takes no ref, and `/model` persists. A third table rather than a
      shared core, for the reason `packages/channels/src/telegram/commands.ts`
      gives about `resolveSeq`. `DELETE /api/sessions/:key/messages` announces
      itself as `session.reset`, which is what makes `/clear` empty a second tab
      as well as this one.
- [x] **Memory** — the agent remembers across sessions in
      `<workspace>/memory/`, one markdown file per fact with frontmatter naming
      it, describing it and saying which of four kinds it is. Only the generated
      index reaches the static prompt; the model opens a memory with `read_file`
      when its line bears on the question, and corrects one by writing the same
      name again. The section's wording is `memoryPrompt`, the seventh editable
      prompt template. The tool's permission is the feature's only switch, which
      is also how `skill` gained one, and no bound on the index is configurable.
      Two things are deliberately not built: a delete operation, and a pass that
      folds a session into memory on its own. `/memory` lists what is held from
      the terminal and from Telegram.
- [x] **Skills** — reusable instruction bundles in `<workspace>/skills/`, one
      directory per skill. Every skill's description is indexed into the static
      prompt and the agent opens the sheet itself with `read_file`. Arrives
      through `ContextContributor`, wired in the composition root. No settings
      panel is planned: a skill is a folder committed beside the project rather
      than configuration, and `/skills` lists what a workspace holds.
- [x] **Telegram** — hold a session with an agent from a phone: the terminal's
      whole command set as bot commands, inline menus for the four pickers, and
      tool approvals answerable from the chat. One adapter over the Bot API in
      `@ghostai/channels`, registered by `ghost serve` like any other
      `ChannelFactory`. Unblocks heartbeat `targets` delivery.
- [x] **Connect MCP servers** — third-party MCP tools appear beside the
      built-ins, as `mcp_<server>_<tool>` rows in each agent's permission map.
      All three transports and OAuth; the client is `@ghostai/mcp`.
- [x] **The agent from a terminal** — agent loop, tool registry, built-in file
      and exec tools, workspace jail, credential vault, provider registry,
      session store, `ghost chat`.
- [x] **The server and the browser** — Fastify REST, WebSocket hub with replay,
      auth, OpenAPI; the React SPA over a hand-written token layer; an e2e suite
      in both colour schemes.
- [x] **Multiple agents with different settings** — one entry per agent under
      `agents.list`, each a patch over `agents.defaults`; a session is bound to
      an agent.
- [x] **Per-tool permissions** — `allow | ask | deny` per tool, per agent;
      absent means disabled.
- [x] **Toolboxes** — digest-pinned container image plus its security policy;
      `exec` runs inside it; declared programs can be exposed as tools.
- [x] **The i18n layer** — three namespaces, keys typed from the JSON, errors
      carrying a translatable key across packages, two CI gates.
- [x] **Scheduled jobs, and the heartbeat** — cron parser, job and run stores,
      REST routes, the Scheduled jobs page and the Automation panel; a heartbeat
      is a job, not a second system.
- [x] **Subagents** — one agent delegates to others as `ask_<id>` tools, each
      run a real turn on a real loop in its own linked session.
