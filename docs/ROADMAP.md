# Roadmap

What is left to build, one line each. No design here — the design happens when a
feature is picked up. The order is the order they were asked for, not a
schedule, and nothing depends on anything else unless it says so.

Every unchecked item already has its schema, config block or contract in the
tree. Read that first; it is the difference between building the feature and
building a second one beside it.

## Planned

- [ ] **Telegram** — hold a session with an agent from Telegram. Unblocks
      heartbeat `targets` delivery.
- [ ] **Skills** — reusable instruction bundles, some pinned, the rest loaded
      when relevant.
- [ ] **Memory** — the agent remembers across sessions and compacts before it
      outgrows the prompt.
- [ ] **Slash commands in the browser** — the terminal REPL's commands, in the
      composer.
- [ ] **Session search page** — find a session by what was said in it.
- [ ] **Extensions** — third-party packages that add tools, channels or
      providers.
- [ ] **RAG** — index the workspace, put the relevant chunks in the prompt.

## Done

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
