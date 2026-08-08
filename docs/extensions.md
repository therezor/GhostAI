# Extensions

An extension is a directory of code an operator installed and approved. It adds
tools, channels, providers, prompt sections and slash commands to a running install,
and it runs **inside the server process** — which is why the approval is a content
digest rather than a checkbox.

```
~/.ghostai/extensions/hello/
  ghostai.extension.json     ← the manifest
  dist/index.js              ← a bundled ESM entry
~/.ghostai/extension-data/hello/   ← what it writes at runtime
```

```bash
ghost extension list        # what is installed, and what state each is in
ghost extension approve hello
ghost extension revoke hello
```

Or Settings → Extensions, which is the same three actions and reloads without a
restart.

## The manifest

```json
{
  "schema": "ghostai.extension/1",
  "id": "hello",
  "version": "1.0.0",
  "label": "Hello",
  "description": "A reference extension: one tool, one prompt section, one command.",
  "entry": "dist/index.js",
  "contributes": ["tools", "context", "commands"]
}
```

| Field             | Type                    | Default           | Notes                                                                        |
| ----------------- | ----------------------- | ----------------- | ---------------------------------------------------------------------------- |
| `schema`          | `'ghostai.extension/1'` | —                 | Required. An unrecognised tag is refused rather than guessed at.             |
| `id`              | string                  | —                 | 1–40 lowercase alphanumerics and hyphens. **Must equal the directory name.** |
| `version`         | string                  | `'0.0.0'`         |                                                                              |
| `label`           | string                  | `''`              | Shown in the UI. Empty falls back to the id.                                 |
| `description`     | string                  | `''`              | One sentence, shown beside the Approve button.                               |
| `entry`           | string                  | `'dist/index.js'` | Relative, inside the directory, ending `.js` or `.mjs`.                      |
| `contributes`     | string[]                | `[]`              | `tools`, `channels`, `providers`, `context`, `commands`.                     |
| `engines.ghostai` | string                  | `''`              | A semver range. Empty means any.                                             |

**The id and the directory name have to agree.** Neither side wins a
disagreement — it is refused — because the approval row is keyed by id and the
directory is how the extension is found, so letting either win would mean the id
an operator approved and the id the host registers under could differ.

## The entry module

```ts
import type { Extension } from '@ghostbot/extension-host';
import { defineTool } from '@ghostbot/tools';
import { z } from 'zod';

export const extension: Extension = {
  activate(context) {
    context.registerTool(
      defineTool({
        name: 'greet',
        description: 'Greet someone by name.',
        risk: 'safe',
        schema: z.strictObject({ who: z.string() }),
        execute: (args) => `Hello, ${args.who}!`,
      }),
    );
  },
};
```

A **named** export called `extension`, not a default: `import-x/no-default-export`
is on across this repository, so a default would be the one shape the in-tree
example and the conformance testkit could not themselves use.

`deactivate` is optional and is for what the abort signal cannot express — a
connection to close, a file to flush. Most extensions need neither.

`examples/hello-extension` is the whole contract in under a hundred lines.

### Building one

**Ship a bundled entry.** An extension directory is not an npm project — nothing
resolves a bare specifier from it at load time — so whatever `activate` imports
has to be in the file. The digest walks the whole directory anyway, and the
file-count cap that keeps that walk bounded is what makes an unbundled
dependency tree fail loudly instead of slowly.

Two bundler settings are not optional, and both fail at `import()` time — which
is to say **after** an operator has already approved it:

- **`removeNodeProtocol: false`.** tsup and esbuild rewrite `node:sqlite` to
  `sqlite`, a compatibility shim for node older than 14.18. `node:sqlite` has no
  unprefixed form, so the rewrite is unloadable.
- **A `createRequire` banner.** Reaching `defineTool` pulls in `@ghostbot/core`,
  which pulls in `pino`, which is CommonJS and calls `require('node:os')` at
  module scope. An ESM bundle has no `require`, so the bundler emits a stub that
  throws `Dynamic require of "node:os" is not supported`.

  ```ts
  banner: {
    js: [
      "import { createRequire as __req } from 'node:module';",
      'const require = __req(import.meta.url);',
    ].join('\n'),
  }
  ```

`examples/hello-extension/tsup.config.ts` is both of them with the reasoning
beside each.

**Expect a large artifact.** The example is about sixty lines and builds to
roughly 1.8 MB, because reaching `defineTool` bundles `@ghostbot/tools` and
everything under it. That is the cost of the rule above rather than a mistake: an
install directory has no `node_modules`, so an extension either carries what it
imports or fails at load. An extension that defines its tools as plain objects
against the `Tool` interface, rather than through `defineTool`, ships a fraction
of that — which is a real trade and not an obvious one, so it is worth knowing
before you measure.

## What `activate` is handed

Everything an extension can reach is a member of `ExtensionContext`. There is no
module to import for the registry, no singleton, and no way to get at the
`ToolRegistry` or the `ChannelManager` the host will eventually feed.

| Member                             | Is                                                                     |
| ---------------------------------- | ---------------------------------------------------------------------- |
| `id`, `manifest`                   | Its own identity.                                                      |
| `settings`                         | `config.extensions.settings.<id>`, **unparsed**. Parse it yourself.    |
| `dataDir`                          | Where it may write. A sibling of its install directory, never a child. |
| `logger`, `clock`                  | The injected pair everything else here uses.                           |
| `signal`                           | Fires when the host unloads it, or the process stops.                  |
| `secret()`                         | From the vault, namespace `extensions`, keyed by id.                   |
| `registerTool` … `registerCommand` | The five contribution points.                                          |

**The context is a recorder, not the registries.** `activate` fills a bag and the
host applies it afterwards. Three things fall out of that, and they are the reason
it is built this way:

- **Unload is exact.** The host holds what `activate` asked for, so removing an
  extension removes exactly that. Nothing has to be diffed.
- **A partial `activate` installs nothing.** An extension that registers four
  tools and throws on the fifth leaves no trace — the bag is discarded whole.
- **Nothing an extension keeps outlives it.** A live registry handle in a closure
  would still work after `deactivate`, and there would be no way to take it back.

It is **not** a sandbox. `node:fs` is one import away, and the section on trust
below says so plainly.

### Settings

`config.extensions.settings.<id>` reaches `activate` unparsed, because the config
schema cannot know its shape — the same arrangement `config.channels.<id>` has.
Parse it with your own Zod schema and throw on a bad block: that lands on the
extension's row as `failed` with the message, which is where an operator who
mistyped it should read about it.

**Credentials do not go there.** Put a secret in the vault under the `extensions`
namespace keyed by extension id, and read it with `context.secret()` — the same
arrangement a channel's bot token gets, for the same reason: `config.json` is a
plain file that backups, dotfile repositories and screen shares all reach.

## One namespacing rule

Every id an extension contributes is `<extensionId>` or `<extensionId>-<suffix>`.
A channel id becomes a session-key prefix, a provider id becomes a
`providers.<id>.type`, and a command id becomes what an operator types after a
slash — one character class across three registries, so two extensions cannot
silently fight over a name and an operator reading any of the three can tell whose
it is.

**A tool is the exception in spelling only.** Tool names have their own character
class, so `greet` is rewritten to `ext_hello_greet` on the way in — the same
64-character cap and digest tail an MCP server's `mcp_<server>_<tool>` gets.

A registration that breaks the rule, or one whose kind `contributes` never
declared, is **dropped with a warning on the extension's row** rather than
throwing. An extension whose fifth tool is misnamed should install the other four
and say so.

## What an extension may add

| Kind        | Contract                                                                             |
| ----------- | ------------------------------------------------------------------------------------ |
| `tools`     | `defineTool`. Registered under source `extension`; granted per agent like any other. |
| `channels`  | `ChannelFactory` — the contract Telegram consumes, unchanged.                        |
| `providers` | A `ProviderSpec`, and a `WireAdapter` when it names a wire this build has none for.  |
| `context`   | A `ContextContributor` — the seam Skills and Memory arrive through.                  |
| `commands`  | A slash command, reachable from the composer and the terminal.                       |

**Registering a tool grants nothing.** It joins the registry and every agent still
decides for itself whether it may call it — `agents.list.<id>.tools`, where an
absent name means disabled. There is no permission vocabulary in the manifest,
deliberately: one reachable from a file an extension ships would be a way to grant
something the operator never enabled.

**A provider comes in two halves.** A `ProviderSpec` alone is enough for anything
OpenAI-compatible, which is the common case and needs no code. A `WireAdapter`
beside it is for a spec naming a protocol this build has no adapter for — and it
cannot replace one that ships, so `openai-chat` is not swappable. Either way the
result goes through `withResilience`, so an extension's provider inherits retry,
backoff and timeout classification rather than reimplementing them.

**A command answers with text, not a resource key.** Its copy ships with the
extension and the translation layer has never seen it — the same rule a toolbox's
`notes` follows.

## The five states

| State        | Means                                                |
| ------------ | ---------------------------------------------------- |
| `ready`      | Loaded and activated.                                |
| `unapproved` | Discovered, never approved.                          |
| `drifted`    | Approved once; the bytes on disk have changed since. |
| `disabled`   | Named in `extensions.disabled`.                      |
| `failed`     | Approved and enabled, and it threw.                  |

Four of the five are reasons it is _not_ running, and each is distinct because
each has a different fix: approve it, re-approve it, enable it, or repair it.
Collapsing them into one `failed` would put an operator back to reading logs,
which is the state the row exists to replace.

**A broken extension never stops a boot.** A manifest that will not parse, one
nobody approved, an `activate` that dies on line one — each is a row with a
sentence beside it. An install that refuses to start because one extension of five
is broken is a worse outcome than one that runs with four.

## Approval

**The digest covers every byte of the install directory**, not the manifest. A
toolbox manifest pins an immutable image, so hashing the manifest hashes the code;
an extension manifest names a _path_, so hashing it would approve a pointer.
Editing any file — including the one `entry` points at, adding one, removing one,
renaming one — moves the digest and revokes the approval automatically. Nobody has
to remember to re-approve, because they cannot avoid it.

Bounded at 4,096 files and 64 MB, refused above with a message saying so. An
extension is expected to ship a bundled entry; the cap makes that expectation
explicit instead of turning an unbundled `node_modules` into a ninety-second boot.

**Reloading code needs a restart.** Node's module registry keys on the resolved
URL and has no eviction, so re-importing an edited file returns the module already
held. The digest gate makes that visible rather than silent: an edited extension
reads `drifted` and stops loading until it is approved again, and the approval is
the natural moment to restart. A `failed` extension is not retried until its
digest moves either, for the same reason — a second `activate` would run the same
module and throw the same error.

**Drift is noticed at the next reconcile, and the two surfaces say so
differently.** `ghost extension list` reads the directory every time it runs, so
it reports `DRIFTED` the moment a file changes. `GET /api/extensions` and the
Settings panel report what the _server has loaded_, which is still the old copy
until something reconciles — a settings save, an approve or revoke, or a restart.
That is the same split `GET /api/settings` and `GET /api/mcp` make, one layer
along: the CLI is answering "what is on disk" and the panel is answering "what is
running", and both are true.

### What this does and does not buy

It answers **"are these the exact bytes the operator reviewed?"** and nothing
more. An extension that passes runs in the server process with full `node:`
access — it can read the vault file, spawn a process and open a socket, and
nothing here stops it. That is the same trust level as a toolbox with host `exec`,
and [Security](security.md#extension-authorisation) states it rather than papering
over it.

`contributes` is **disclosure, not enforcement**. It is what the approval screen
shows, and the host drops a registration whose kind is not listed — which keeps
the declaration honest and stops an honest mistake becoming an invisible one. It
is not a boundary, because the code is already running.

## Configuration

See [Configuration](configuration.md#extensions). The short version:

```json
{
  "extensions": {
    "load": ["/opt/corp-extensions/audit"],
    "disabled": ["hello"],
    "settings": { "hello": { "greeting": "Ahoy" } }
  }
}
```

`load` takes a **path**, never a package spec. Nothing here fetches: an extension
is a directory an operator put on the box, which is what keeps an air-gapped
install air-gapped.

## Testing one

`@ghostbot/extension-host/testkit` runs an extension through the host's own
recorder:

```ts
import { extensionConformance } from '@ghostbot/extension-host/testkit';

extensionConformance({
  manifest,
  extension: () => extension,
  expect: { tools: 1, commands: 1 },
});
```

It catches the failure an extension's own tests structurally cannot: registering
something `contributes` never declared works perfectly in isolation, and the host
silently drops it. A red test in your own repository is a better place to find
that than a warning on somebody's settings panel.

`examples/hello-extension/test/hello.test.ts` is three lines of it.
