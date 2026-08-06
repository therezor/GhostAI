# GhostAI documentation

Everything here describes what is built. Work that is designed but not implemented lives
in [ROADMAP.md](ROADMAP.md) and is not documented as though it works.

## Using it

| Page                              | What it covers                                                                        |
| --------------------------------- | ------------------------------------------------------------------------------------- |
| [Configuration](configuration.md) | Every key in `config.json`, its type and its default. Env vars. Patch semantics.      |
| [Prompts](prompts.md)             | The three editable templates, their placeholders, and the caching split behind them.  |
| [Providers](providers.md)         | The registry, provider instances, resolution order, credentials, resilience.          |
| [Tools & permissions](tools.md)   | The eight built-in tools, and the `allow \| ask \| deny` model that gates them.       |
| [Skills](skills.md)               | Instruction sheets in `<workspace>/skills/`, indexed or named on a message.           |
| [Memory](memory.md)               | What an agent remembers between sessions, one file per fact in `<workspace>/memory/`. |
| [Toolboxes](toolboxes.md)         | Running `exec` inside a pinned, hash-approved container instead of on the host.       |
| [Web UI](web-ui.md)               | The screens, and what each one lets you do.                                           |

## Understanding it

| Page                            | What it covers                                                                      |
| ------------------------------- | ----------------------------------------------------------------------------------- |
| [Architecture](architecture.md) | The package graph, a turn end to end, the event stream, subagents, what is on disk. |
| [Security](security.md)         | Each guard, the attack it closes, why the obvious approach fails, and its limits.   |
| [API](api.md)                   | The REST surface and the WebSocket protocol.                                        |

## Working on it

| Page                          | What it covers                                                       |
| ----------------------------- | -------------------------------------------------------------------- |
| [Development](development.md) | The CI gate, conventions, coverage bars, the UI loop, the e2e suite. |
| [Roadmap](ROADMAP.md)         | What is built and what is left, as a checklist.                      |

## Where the truth lives

The code carries its reasoning in comments, and these pages are written from it rather
than from each other. When a page and the source disagree, the source is right — and the
page is a bug. The highest-value files to read directly:

- `packages/protocol/src/config.ts` — the settings tree, with a paragraph per decision
- `packages/protocol/src/prompt.ts` — the prompt templates and substitution rules
- `packages/agent/src/loop.ts` — the turn, and the invariants it maintains
- `packages/agent/src/dispatch.ts` — the tool half of a turn: authorise, run, answer
- `packages/security/src/` — the guards, each explaining its own threat model
