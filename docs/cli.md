# CLI

**Who this is for:** anyone driving GhostAI from a terminal rather than a browser. It is
the reference for `ghost` — every command, every flag, and every slash command inside the
chat prompt. If you are setting up for the first time, start with
[Getting started](getting-started.md) and come back here.

One binary, `ghost`. The terminal and the browser are two views of one install, not two
programs: they share a single `ghost.db`, so a session you start here is the row the
browser sidebar lists, and a turn started from either goes through the same loop and the
same approval gate.

## Commands

```
ghost [chat] [message...]      talk to the agent — the default command
ghost init                     configure this install, in a wizard
ghost serve                    serve the web UI and the API on one port
ghost toolbox   list | approve <id> | revoke <id>
ghost extension list | approve <id> | revoke <id>
ghost help [command]
```

`chat` is the default, so `ghost "what changed today"` and `ghost chat "what changed
today"` are the same command.

### Global flags

| Flag                  | Does                                                               |
| --------------------- | ------------------------------------------------------------------ |
| `--home <dir>`        | The GhostAI root. Beats `$GHOSTAI_HOME`, which beats `~/.ghostai`. |
| `--log-level <level>` | `trace`, `debug`, `info`, `warn`, `error` or `fatal`.              |
| `--verbose`           | Report what the install is doing, not only the answer.             |
| `--no-color`          | Disable colour.                                                    |
| `-v`, `--version`     | Print the version.                                                 |
| `-h`, `--help`        | Print help. `ghost help <command>` does the same for one.          |

The log level defaults to `error` — or `info` while serving, because a server that says
nothing while it works reads as hung.

## `ghost chat`

Three shapes, decided by how you call it:

```bash
ghost chat                            # a prompt, with slash commands and Tab completion
ghost chat "summarise notes.md"       # one turn, then exit
git log --oneline -20 | ghost chat "what changed"   # a pipe target
```

| Flag                      | Does                                                     |
| ------------------------- | -------------------------------------------------------- |
| `-s, --session <key>`     | The session to continue. Default `cli:default`.          |
| `-a, --agent <id>`        | The agent this session runs on.                          |
| `-m, --model <id>`        | Model id, overriding the configured default.             |
| `-p, --provider <id>`     | Provider instance id, overriding the configured default. |
| `-w, --workspace <dir>`   | The workspace **root** — moves the whole tree.           |
| `-W, --workspace-id <id>` | Which workspace inside that root new sessions land in.   |
| `--new`                   | Clear the session before this turn.                      |
| `--json`                  | One agent event per line, as JSON.                       |
| `--no-reasoning`          | Hide the model's reasoning stream.                       |
| `--no-tools`              | Run the turn with no tools registered at all.            |

**`-w` and `-W` are deliberately different flags** for two different things, and the
capital is the narrower one: `-w` says where the whole tree lives, `-W` picks a workspace
inside it. Reaching for the wrong one moves your files rather than switching folder.

`--json` is the scripting surface. Each line is one event from the same stream the web UI
consumes, so a script can watch tool calls go by rather than waiting for prose.

### Slash commands

Type `/` in the prompt. Tab completes a slash command and nothing else — never a
filename, never a session key — so the completion list can never be a guess about what
you meant.

| Command          | What it does                                |
| ---------------- | ------------------------------------------- |
| `/help`          | This list                                   |
| `/messages [n]`  | The last n messages, with their seq numbers |
| `/clear`         | Forget this session's history               |
| `/exit`, `/quit` | Leave                                       |

**Sessions**

| Command           | What it does                              |
| ----------------- | ----------------------------------------- |
| `/sessions [n]`   | Pick a session to continue, or list them  |
| `/new [title]`    | Start a fresh session and attach to it    |
| `/session [key]`  | Show this session, or attach to another   |
| `/rename <title>` | Rename this session                       |
| `/delete [key]`   | Delete one, defaulting to this one        |
| `/branch [ref]`   | Fork up to `<ref>` and attach to the fork |

**Messages**

| Command              | What it does                                     |
| -------------------- | ------------------------------------------------ |
| `/edit <ref> <text>` | Replace a message and re-run from there          |
| `/regenerate [ref]`  | Re-run the last turn, or the one `<ref>` started |

Both truncate and re-run rather than appending. History is append-only for the provider's
cache, so what these drop is always a suffix — see
[Architecture](architecture.md#a-turn).

**Context and cost**

| Command      | What it does                                    |
| ------------ | ----------------------------------------------- |
| `/context`   | What the next turn would send to the model      |
| `/stats [n]` | The last n turns: model, tokens, tokens/s, time |

`/context` prints the same measurement the browser's context inspector draws and
`GET /api/sessions/:key/context` returns, so all three agree.

**What a turn shows**

| Command                     | What it does                            |
| --------------------------- | --------------------------------------- |
| `/output`                   | What a turn shows, and what it does not |
| `/output <field> [on\|off]` | Flip one — `reasoning`, `stats`         |

**Agents and models**

| Command       | What it does                                        |
| ------------- | --------------------------------------------------- |
| `/agent [id]` | Show agents, or move this session onto one          |
| `/model [id]` | Show the models this install can reach, or pick one |

**Memory and skills**

| Command           | What it does                                                     |
| ----------------- | ---------------------------------------------------------------- |
| `/memory`         | How many memories this workspace holds, and what the index costs |
| `/memory on\|off` | Let this agent remember, or stop it                              |
| `/skills`         | The sheets this workspace holds                                  |

`/memory on|off` **changes the agent, not just this session** — it is the `memory` tool's
permission, which is the one switch rather than two. See [Memory](memory.md).

**Workspaces**

| Command                         | What it does                              |
| ------------------------------- | ----------------------------------------- |
| `/workspaces`                   | List them, marking the current one        |
| `/workspace <id>`               | Show or switch where new sessions land    |
| `/workspace new <name>`         | Create one                                |
| `/workspace rename <id> <name>` | Rename the label, without moving anything |
| `/workspace rm <id>`            | Detach; refuses while sessions name it    |
| `/workspace move <from> <to>`   | Move sessions between workspaces          |

An extension can add commands of its own; they appear in this list and in `/help` from
the same table, so one cannot exist in the completer and not the listing. See
[Extensions](extensions.md).

## `ghost init`

The terminal half of the first-run wizard: language, workspace, provider, model. The
provider step lists models from the endpoint itself, so on a machine running
`ollama serve` the model question is a list rather than a text box.

It **needs a real terminal** and refuses a pipe rather than reading EOF as an answer, and
it writes nothing until every question has been answered — a wizard abandoned halfway
leaves the install exactly as it was.

## `ghost serve`

Serves the UI, the REST API and the WebSocket on one port.

| Flag                    | Does                                                           |
| ----------------------- | -------------------------------------------------------------- |
| `-H, --host <host>`     | Bind address, overriding the configured default.               |
| `-P, --port <port>`     | Port, overriding the configured default.                       |
| `-w, --workspace <dir>` | Workspace root, overriding the configured default.             |
| `--password <password>` | Set or rotate the login password. Or `GHOSTAI_PASSWORD`.       |
| `--username <username>` | The login name, alongside `--password`. Or `GHOSTAI_USERNAME`. |
| `--ui <dir>`            | A built UI to serve instead of the bundled one.                |

It starts with nothing configured and prints a one-time setup code. Two refusals are
worth knowing before you meet them:

- **A non-loopback bind with authentication off refuses to start.** Not a warning — the
  process exits. See [Security](security.md#binding).
- **`--ui <dir>` must contain an `index.html`.** A directory that does not is an error at
  startup rather than a blank page later.

If `@ghostbot/web` has not been built, `serve` says so and runs the API alone rather than
serving nothing at a URL it just printed.

## `ghost toolbox` and `ghost extension`

Both are the same three verbs over a digest-based approval:

```bash
ghost toolbox list            # every installed toolbox, and whether it is approved
ghost toolbox approve <id>    # approve its current contents
ghost toolbox revoke <id>     # stays installed, stops running
```

Approval records the sha256 of the exact bytes you reviewed, so **editing an installed
toolbox or extension revokes its own approval** — the next turn refuses and names the
drift rather than running code nobody looked at. `extension` differs in one way that
matters: its digest covers every byte of the install directory rather than the manifest,
because an extension manifest names a path where a toolbox manifest pins an image.

See [Toolboxes](toolboxes.md) and [Extensions](extensions.md).

## Environment

| Variable            | Does                                                              |
| ------------------- | ----------------------------------------------------------------- |
| `GHOSTAI_HOME`      | The root. Beaten by `--home`, beats `~/.ghostai`.                 |
| `GHOSTAI_PASSWORD`  | Fallback for `serve --password`.                                  |
| `GHOSTAI_USERNAME`  | Fallback for `serve --username`.                                  |
| `GHOSTAI_LANG`      | Locale. Ranks above `config.ui.locale`, which ranks above `LANG`. |
| `GHOSTAI_LOG_LEVEL` | Then `LOG_LEVEL`, then `info`.                                    |
| `GHOSTAI_DEBUG`     | Any non-empty value prints stack traces instead of the sentence.  |

Provider API keys are read from the environment **only when the vault has no entry** for
that instance — the vault wins. [Configuration](configuration.md#environment-variables)
has the full list and [Providers](providers.md) explains the precedence.

## Exit codes

`ghost` sets `process.exitCode` and returns rather than calling `process.exit`, so a
piped answer is never truncated by the process leaving before its output has flushed.
`--help` and `--version` are successful exits.
