# Toolboxes

A toolbox is a container image **plus its whole security policy**, installed by an
operator and authorised by content hash. Point an agent at one and its `exec` calls run
inside that container instead of on the host.

This is the answer to the honest limit stated in [Security](security.md): a workspace is
an organisational boundary, not a security boundary, wherever host `exec` is enabled. A
container is the boundary.

It is also what makes heavy tooling practical. A research or security image carries
hundreds of programs a model already knows from pretraining; the toolbox declares them as
prose in about forty tokens rather than as tool schemas at sixty to eighty each on every
request.

## The shape

```json
{
  "schema": "ghostai.toolbox/1",
  "name": "web-research",
  "version": "3.0.0",
  "label": "Web research",
  "tools": [
    {
      "name": "search",
      "use": "Search the web and read the top results.",
      "args": "The query as plain words. --recent day|week limits by age.",
      "example": ["best local model for tool calling"],
      "permission": "allow",
      "requiresArgs": true
    },
    {
      "name": "curl",
      "use": "Call an API.",
      "permission": "ask",
      "requiresArgs": true
    }
  ],
  "notes": "Write findings to /workspace and search them with rg.",
  "expose": "tools",
  "image": "sha256:…",
  "runtime": "runc",
  "workdir": "/workspace",
  "user": "1000:1000",
  "caps": { "drop": ["ALL"], "add": [] },
  "security": {
    "noNewPrivileges": true,
    "seccomp": "default",
    "readOnlyRoot": true,
    "tmpfs": ["/tmp:rw,nosuid,size=256m"]
  },
  "limits": { "memoryMb": 1024, "cpus": 2, "pidsMax": 128, "shmSizeMb": 64 },
  "network": { "maxMode": "open", "dns": [], "proxyAllowHosts": [] },
  "env": ["LANG", "TZ"]
}
```

### Fields

| Field                        | Type                        | Default          | Notes                                                                      |
| ---------------------------- | --------------------------- | ---------------- | -------------------------------------------------------------------------- |
| `schema`                     | `'ghostai.toolbox/1'`       | —                | Required.                                                                  |
| `name`                       | string                      | —                | Also the directory name under `~/.ghostai/toolboxes/`.                     |
| `version`                    | string                      | `'0.0.0'`        |                                                                            |
| `label`                      | string                      | `''`             | Shown in the UI.                                                           |
| `tools[]`                    | see below                   | `[]`             | The programs worth naming. Not an inventory of the image.                  |
| `notes`                      | string                      | `''`             | Caveats about the box as a whole, included in the prompt.                  |
| `expose`                     | `prompt \| tools`           | `'prompt'`       | See [Exposure](#exposure).                                                 |
| `image`                      | string                      | —                | **Must be digest-pinned.** `name@sha256:<64hex>` or a bare local image id. |
| `runtime`                    | `runc \| runsc \| kata`     | `'runc'`         | `runsc` is gVisor, `kata` a lightweight VM.                                |
| `workdir`                    | string                      | `'/workspace'`   | Where the workspace is mounted inside the container.                       |
| `user`                       | string                      | `''`             | `uid:gid`.                                                                 |
| `caps.drop`                  | string[]                    | `['ALL']`        |                                                                            |
| `caps.add`                   | string[]                    | `[]`             | `NET_ADMIN`, `SYS_ADMIN` and `SYS_MODULE` are **never grantable**.         |
| `security.noNewPrivileges`   | boolean                     | `true`           |                                                                            |
| `security.seccomp`           | `default \| unconfined`     | `'default'`      | `unconfined` is surfaced to the operator, not refused.                     |
| `security.readOnlyRoot`      | boolean                     | `true`           |                                                                            |
| `security.tmpfs`, `.devices` | string[]                    | `[]`             |                                                                            |
| `limits.memoryMb`            | int                         | `2048`           |                                                                            |
| `limits.cpus`                | number                      | `2`              |                                                                            |
| `limits.pidsMax`             | int                         | `512`            |                                                                            |
| `limits.shmSizeMb`           | int                         | `256`            |                                                                            |
| `network.maxMode`            | `none \| allowlist \| open` | `'none'`         | A **ceiling**. See below.                                                  |
| `network.dns`                | string[]                    | `['127.0.0.11']` |                                                                            |
| `network.proxyAllowHosts`    | string[]                    | `[]`             | Hostname scoping for HTTP(S), through the proxy.                           |
| `env`                        | string[]                    | `[]`             | Host variables passed through. Everything else is scrubbed.                |

Each entry in `tools[]`:

| Field          | Type                   | Default | Notes                                                                       |
| -------------- | ---------------------- | ------- | --------------------------------------------------------------------------- |
| `name`         | string                 | —       | The program.                                                                |
| `use`          | string                 | `''`    | One sentence. This is what the model reads to decide whether to call it.    |
| `args`         | string                 | `''`    | Flag reference, in prose.                                                   |
| `example`      | string[]               | `[]`    | An argv.                                                                    |
| `permission`   | `allow \| ask \| deny` | `'ask'` | A **default** the agent may override — the opposite direction to `maxMode`. |
| `requiresArgs` | boolean                | `false` |                                                                             |

## Two absolute refusals

**The image must be digest-pinned.** A tag is a mutable pointer; a toolbox approved once
and then repointed would defeat the whole gate. The pattern is anchored at both ends —
an end-only anchor would let a manifest smuggle something like `-v /:/hostfs` past as an
argv token.

**`NET_ADMIN`, `SYS_ADMIN` and `SYS_MODULE` are never grantable.** A sandbox with
`NET_ADMIN` shares the egress gateway's network namespace and can flush its rules, which
would make every other network control decorative.

## tmpfs is memory

`security.tmpfs` and `limits.memoryMb` are not independent budgets. A tmpfs is
RAM-backed, and its pages are charged to the container's memory cgroup — so a box with
`/tmp` at 512m and `memoryMb` at 1024 has half its memory reachable by writing files.

It is easy to miss, because the default Docker behaviour hides it: without
`--memory-swap`, swap is twice the memory limit, so tmpfs pages get swapped and a write
past the limit succeeds slowly instead of failing. With swap disabled the same write is
OOM-killed. Size `/tmp` for what a job actually spills, not generously, and count it
against `memoryMb` when you set that.

Work belongs in the workspace anyway — a bind mount on real disk, outside this budget
entirely. `/tmp` is for what a program does behind your back.

`seccomp: unconfined` is deliberately _surfaced_ rather than refused — there are real
tools that need it, and the operator approving the manifest is the right person to make
that call knowingly.

## Network is a ceiling

The manifest's `maxMode` and the agent's requested `mode` are **intersected, never
unioned**. An agent asking for `open` against a manifest whose maximum is `none` gets
`none` — and the settings save that tried it is _refused_ rather than silently
downgraded, because a config that means something other than what it says is worse than
one that fails.

The agent's `allow` list is CIDRs only. A hostname allow-list is defeated by DNS
rebinding, which is the attack `guardedFetch` already exists to stop; a manifest whose
traffic is all HTTP(S) scopes by hostname through `proxyAllowHosts` instead.

Per-tool `permission` runs the other way: the manifest supplies a _default_ and the agent
may loosen or tighten it. That asymmetry is intentional. Network is a capability the
operator grants to the box; a tool permission is a judgement about a specific agent's job.

## Building and approving

All of them at once, which is what `ghost init` offers on a fresh install:

```bash
ghost install
```

Or one at a time, which is also what a repo checkout runs before `pnpm build` has
produced a CLI to run:

```bash
catalogue/build.sh web-research
```

The script runs `docker build --iidfile`, checks the result is a real `sha256:` image id,
substitutes it into the manifest and installs to `~/.ghostai/toolboxes/<name>/`. It
installs no agent — presets are not kept here and are not per-toolbox files; see
[Agent presets](#agent-presets).

**The image is referenced by its image ID, not by a registry digest.** An image ID is the
content hash `docker build` produces — a content address, exactly as unrepointable as a
registry digest, and available on a machine with no internet. A tag is neither. This is
what makes a toolbox work on an air-gapped install.

**Installing is only half of it.** The manifest lands on disk; nothing will _run_ it until
its hash is approved:

```bash
ghost toolbox list
ghost toolbox approve web-research
ghost toolbox revoke web-research
```

Approval records the sha256 of the manifest bytes as they are now. The manifest is a file
on disk and the approval is a database row, and the two do not trust each other: **editing
an installed manifest silently revokes its approval**, and the next turn refuses with a
sentence naming the drift. There is no `--force` — re-approving is reviewing the new bytes.

The hash covers the manifest bytes and nothing else, so a file an install puts beside
`toolbox.json` neither blocks resolution nor revokes an approval when it changes.

Toolboxes live beside the workspace, never inside it, so `write_file` plus a prompt
injection cannot rewrite the policy the agent runs under.

## Agent presets

A toolbox is an environment; the agent that works in it is config. That config is a
preset — a JSON file in `catalogue/presets/`, named for the agent id it installs — and
one command turns it into an entry in `agents.list`:

```bash
ghost agent install researcher
```

**A preset is not a per-toolbox file.** Every preset lives in that one directory whether
or not it names a container, because an agent that works in one is not a different kind
of agent — it is an agent whose `toolbox.name` is set. So `researcher` sits beside
`nano`, and `ghost agent install` has one place to look (plus `~/.ghostai/presets/` for
your own). The toolbox directory holds the Dockerfile and the manifest, and nothing else.

The preset carries the agent's `systemPrompt` — which is where the toolbox's tool
documentation lives, beside what each manifest entry already declares — its tool
permissions, its toolbox reference and its network request. It deliberately cannot carry
a model, a provider, or anything from the toolbox manifest's side of the boundary: the
shape is a strict subset of an `agents.list` entry, so a preset can express nothing a
settings save could not. See [CLI](cli.md#ghost-agent) for the full resolution order.

Install refuses a preset whose toolbox is not approved (the server would refuse to boot
on the result) and refuses to overwrite an existing agent without `--force`, because the
existing entry may carry your own edits.

## The shipped toolboxes

| Toolbox        | What is in it                                                                                                                                                          | Network ceiling |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| `web-research` | search, fetch, doc (with OCR); nmap, masscan, subfinder, amass, dnsx, httpx, katana, tlsx, gau, waybackurls, whois, dig, sslscan; rg, jq, curl, wget, openssl, python3 | `open`          |
| `data`         | anydoc, mlr (miller), sqlite3, jq, yq, 7z, strings, exiftool, file, rg                                                                                                 | `none`          |
| `media`        | ffmpeg/ffprobe (x264/x265/VP9/AV1/Opus/MP3), magick, sox, exiftool, mediainfo, gifsicle                                                                                | `none`          |
| `coding`       | git, node, npm, python3, rg, jq                                                                                                                                        | `open`          |
| `websec`       | nuclei, ffuf, gobuster, dalfox, sqlmap, commix, nikto, wafw00f, arjun, hydra, john, jwt_tool                                                                           | `open`          |

Five boxes, eight agents: `researcher` and `recon` both work in `web-research` — which
now carries the network recon and OSINT tools alongside search/fetch/doc, because both
jobs are network-open and share the same handful of base tools — while `data-analyst`
works in `data`, `media-ops` in `media`, `coder` in `coding`, and `security-tester` in
`websec`. `team-lead` and `nano` need no container at all.

`web-research` and `websec` are the worked example of [For security work](#for-security-work):
both `expose: "tools"`, so each program is a named, listable tool, and both cap network
at `open`, because a tool that cannot reach the target is inert. `web-research` adds back
the one capability a port scanner needs, `NET_RAW` (for `nmap -sS`) — a real widening it
did not carry as a pure research box, recorded in the manifest and re-approved on any
edit; `websec` keeps every capability dropped, since its tooling is all layer-7 HTTP.
`websec` runs its tools unattended (`exec` allowed, every tool `allow`) and acts against
a target, so it is the box to leave uninstalled unless someone is doing authorized
security testing.

**Documents and data are one box, and one agent, on purpose.** They were two of each,
and the boundary ran through the middle of a single job: a zip of spreadsheets with a
PDF summary needs whatever converts the document and whatever counts the rows to be the
same thing, in the same turn. Split, the one that could read the file could not query
it — and a coordinator had to guess which of them to ask.

**`coding` is the second box with a network, and the only one that also runs arbitrary
code.** A coding box that cannot reach a registry cannot run a test suite whose
dependencies are not vendored, so its ceiling is `open` — but node, python and git are
already arbitrary execution, and egress turns that into a way out. It is a per-toolbox
decision recorded in the manifest, and narrowing it back to `none` is a one-word edit
that forces a re-approval.

There is no scoped middle ground yet: `allowlist` needs an egress gateway container to
enforce it, and the runner refuses to start a scoped sandbox without one rather than
quietly running wide open. `proxyAllowHosts` is inert for the same reason. Until a
gateway ships, the honest choice is between `none` and `open`.

## Exposure

`expose` decides how the container's programs reach the model.

- **`prompt`** (default) — the manifest's `tools[]` are described in the system prompt and
  the model calls them through `exec`. About forty tokens for the whole box, cached once
  per session.
- **`tools`** — each declared program is materialised as a real callable tool with its own
  schema and its own permission. Sixty to eighty tokens each, on every request of every
  turn — but the model gets argument validation and per-program approval prompts.

Use `tools` when individual programs need different permissions, which is exactly the
shipped `web-research` case: `search`, `fetch`, `rg` and `jq` are `allow`, while `curl`
and `python3` are `ask`, because those two are the ones that can reach anywhere and run
anything.

## Inside the container

- Only `/workspace` is mounted from the host, read-write. Everything else in the
  filesystem disappears when the session ends.
- The manifest directory is mounted read-only at `/run/ghost`, so anything installed
  beside `toolbox.json` is readable from inside. Nothing shipped uses it today.
- Output too large to return inline is kept in full under `/run/ghost-runs/<id>/`,
  read-only and outside the workspace — reachable with a shell command, not with the file
  tools. That path is outside the workspace because a symlink-planting escape was
  demonstrated before it moved.
- **A shell is available**, so a pipeline goes through `["bash","-lc","…"]`. No shell
  string is ever built on the host side: a fixed `sh -c` literal takes the argv as
  positional parameters.
- The file tools are unaffected. They always act on the workspace on this machine, through
  the jail. What the file tools call `notes/todo.md` is `/workspace/notes/todo.md` to a
  command.

Containers are pooled — at most four live at once, keyed by agent, workspace and session,
and reaped after ten minutes idle.

**A sandbox that fails to start is a refusal, never a downgrade to the host.** An agent
configured to run in a container does not quietly get a shell on your machine because
Docker was not running.

## Why the exec guard relaxes inside one

On the host, `guardExec` refuses shell binaries and refuses path arguments pointing
outside the workspace. Inside a toolbox both restrictions lift — and they lift
**together**, which is the point.

Both exist to enforce by inspection what a container enforces by construction. A container
that mounts only the workspace has nothing else to point at, so refusing `../etc/passwd`
protects nothing; and with the filesystem already bounded, a shell is just the ergonomics
of running two commands. Lifting one without the other would be a real weakening; lifting
both, given the mount set, is not.

Everything else still applies: argv is still argv, the environment allow-list still holds,
the output budget is still enforced as the process writes, and the call is still gated by
the agent's tool permissions.

## For security work

The shipped `web-research` box is a worked example, not the only shape. The same manifest
format takes an image with whatever tooling a job needs, and the properties that matter
for that use are all in the table above: capabilities dropped, root read-only, pids and
memory bounded, network capped at the manifest and narrowed per agent, every argv audited,
and the whole policy pinned to bytes an operator reviewed.

Build the image locally, approve its hash, give one agent `toolbox.name` and a network
mode, and leave the rest of your agents on `none`.
