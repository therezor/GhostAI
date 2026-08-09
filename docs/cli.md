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
ghost install                  build the shipped toolboxes and install their agents
ghost agent     install <name-or-path> [--force] | list
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

## `ghost install`

The tedious half of setting an install up, in one command — six `docker build`s and
eight config merges, in the right order:

```bash
ghost install                  # build every shipped toolbox, install every agent
ghost install --approve        # …approving the toolboxes too, without asking
ghost install --no-approve     # …approving nothing, without asking
ghost install --presets-only   # only the agents that need no container; never runs Docker
```

`ghost init` offers this as its last question, so a fresh install usually never types it.

### Approving, in one keystroke or none

An agent cannot work in a toolbox until that toolbox is **approved** — a recorded
statement that somebody read what the container may do. `ghost install` builds and
installs the manifests, then settles that question in the same run, because approving is
what unblocks the agents and a command that made you run it twice would be doing half
its job.

| You pass       | It does                                                       |
| -------------- | ------------------------------------------------------------- |
| `--approve`    | Approves what it installed. No question.                      |
| `--no-approve` | Approves nothing, and prints the commands that would.         |
| neither        | Prints each toolbox's policy, then asks once — on a terminal. |

**The policy is printed before the question, not after it**, so a `y` is an informed one.
That costs a screen of text and buys the only thing in this command that re-running
cannot undo.

With no terminal — a pipe, a CI job — and no flag, it approves **nothing**. A default of
"yes" there would approve container policy nobody read, which is the failure the gate
exists to stop. Agents needing an unapproved toolbox are held back rather than
half-installed, since an enabled agent naming one is a config the server refuses to boot
on.

Two more rules worth knowing:

- **It never overwrites an agent you already have**, because that entry may carry your
  own edits. An agent already installed is skipped silently.
- **Delegators install last**, so `team-lead` is snapshotted after its specialists exist.
  If you approve toolboxes _between_ two runs, its roster is stale — the command says so
  and prints the `--force` line that refreshes it rather than rewriting it for you.

## `ghost agent`

Installs an agent preset — a JSON file holding a system prompt, tool permissions, a
toolbox reference and a delegation roster — as an entry in `agents.list`:

```bash
ghost agent list                      # configured agents, and presets not yet installed
ghost agent install researcher        # a shipped preset, by its id
ghost agent install ./my-agent.json   # a preset you wrote, by path
ghost agent install nano --force      # overwrite an existing agent of the same id
```

**There is one kind of preset.** A preset is `<id>.json` — the filename is the agent id
— whether or not the agent works in a container; one that does simply sets
`toolbox.name`. So there is one lookup, and the argument is either a path or an id
searched in two directories:

| Searched                       | Holds                                       |
| ------------------------------ | ------------------------------------------- |
| `~/.ghostai/presets/<id>.json` | Yours. Drop a file in; that is the install. |
| `catalogue/presets/<id>.json`  | The eight that ship.                        |

Yours first, so a local `nano.json` wins over the shipped one. Nothing is fetched at any
point: both are files already on the box, and the shipped ones come from
`@ghostbot/catalogue`, resolved as a package rather than by a path — the same way the
server finds the built UI, and for the same reason.

Installing is a config merge and nothing more: afterwards the agent is ordinary config,
edited in the web UI like any other. Three rules do the real work:

- A preset naming a toolbox that is not installed and approved is **refused**, with the
  command that fixes it — the server would refuse to boot on the result.
- An id that already exists is **refused without `--force`**, because the existing entry
  may carry your own edits.
- A preset's `subagents` roster is **filtered to the agents installed and enabled at
  that moment**. Install `team-lead` last — or re-run it with `--force` after adding
  specialists — and its delegation roster matches what can actually answer.

A preset deliberately cannot name a model, a provider, or anything from the toolbox
manifest's side of the security boundary. See
[Toolboxes](toolboxes.md#agent-presets).

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
