# Build plan

- Memory — per agent under `<root>/agents/<id>/memory`, plus the layer shared
  per working folder under `<root>/shared/<workspaceId>`. Both paths exist and
  are deliberately outside the jail; they arrive in the prompt through
  `ContextContributor`, which nothing implements yet.
- Skills — same seam, same directories.
- Add sessions lazy loading and search
- Subagents
- Telegram
- MCP integration
- Sandboxed tools — the `CommandRunner` seam is in place and `exec` routes
  through it; what is missing is a docker backend. `AgentSandbox.kind: 'docker'`
  parses and is refused at agent resolution until one exists.
- ghost doctor
- Plugin SDK and host, install/uninstall from the UI, WhatsApp and Discord as external plugins
- RAG?

## Done

- **Multiple agents with different settings.** `agents.list.<id>` in
  `config.json`, each entry a patch over `agents.defaults` — model, provider,
  temperature, reasoning effort, context window, tool allow/deny, approval and
  exec overrides, sandbox and memory scope. One `AgentLoop` per agent, cached;
  one shared workspace, store, registry and provider cache. A session is bound
  to an agent through `sessions.agent_id`, and the stored row wins over a frame
  once the session exists.
