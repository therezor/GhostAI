# Development

**Who this is for:** anyone changing the code. It is the CI gate, the conventions a
linter cannot enforce, the coverage bars, and how to release. If you only want to _run_
GhostAI, [Getting started](getting-started.md) is the page you want;
[CONTRIBUTING.md](../CONTRIBUTING.md) is the short version of this one.

## Setup

```bash
git clone https://github.com/therezor/GhostAI.git
cd GhostAI
pnpm install
pnpm build
pnpm --filter @ghostai/cli link --global   # gives you `ghost`
```

That `ghost` shadows an `npm install -g @ghostai/cli`, if you have one;
`pnpm --filter @ghostai/cli unlink --global` puts the released one back.

Node ≥ 22.13 and pnpm 11 (`corepack enable` — the version is pinned in the root
`package.json`).

The Node floor is `node:sqlite`, which means no native module to compile and no prebuilds
to go missing. **22.13 is exact, not cautious**: the module landed in 22.5 behind
`--experimental-sqlite` and was unflagged for the 22 line in 22.13, so 22.12 fails at
startup with `ERR_UNKNOWN_BUILTIN_MODULE` rather than degrading. Node 22 and 24 also print
`ExperimentalWarning: SQLite is an experimental feature` on every invocation; Node 26 does
not.

## The gate

**`pnpm check` is not the CI gate.** It runs `typecheck`, `lint` and `test`, and CI runs
six more things on top — most local sessions that end green and then fail CI fail on
`format:check`, which `pnpm check` never calls.

CI is [`.github/workflows/ci.yml`](../.github/workflows/ci.yml), and it is three jobs.
Run all of it before calling something done:

```bash
# job: check
pnpm typecheck
pnpm lint
pnpm --filter @ghostai/web exec tsx src/tokens/run-gates.ts   # design token gates
pnpm format:check                                             # ← the usual failure
pnpm i18n:check
pnpm test
pnpm build

# job: coverage — per-package thresholds, stricter than the default
pnpm test:coverage

# job: e2e — Playwright, both colour schemes, against a real server
pnpm build                                                    # a precondition, not a convenience
pnpm --filter @ghostai/e2e test:e2e
```

Notes that save a cycle:

- **`pnpm format:check` fails, `pnpm format` fixes it.** Prettier is not wired into
  `lint`. When it reports files you did not touch, format only your own.
- **e2e needs `pnpm build` first.** It serves the built SPA through the real server;
  without a build the harness fails at `resolveUiRoot`.
- **The fidelity spec skips without a baseline.** `2 skipped` is the healthy result.
- **A green local e2e run is evidence, not proof.** CI runs 2 workers on a shared runner;
  a laptop runs 5 with nothing competing. When CI reports a failure the local suite will
  not reproduce, re-run that spec under load before blaming CI:

  ```bash
  pnpm --filter @ghostai/e2e exec playwright test <spec> --repeat-each=6
  ```

### Scripts

| Command                               | Does                                                                  |
| ------------------------------------- | --------------------------------------------------------------------- |
| `pnpm typecheck`                      | `tsc -b` across all project references                                |
| `pnpm lint` / `lint:fix`              | ESLint with type-aware rules                                          |
| `pnpm format` / `format:check`        | Prettier                                                              |
| `pnpm test` / `test:watch`            | Vitest                                                                |
| `pnpm test:coverage`                  | Vitest with the per-package gates enforced                            |
| `pnpm build`                          | Turborepo build across the graph                                      |
| `pnpm i18n:extract` / `i18n:check`    | Regenerate the locale bundles / fail if they are out of step          |
| `pnpm --filter @ghostai/web dev`      | Vite dev server, proxying `/api` and `/ws` to a running `ghost serve` |
| `pnpm --filter @ghostai/e2e test:e2e` | Playwright, both colour schemes                                       |
| `pnpm screenshots`                    | Regenerate the documentation's images into `docs/screenshots/`        |
| `pnpm demo`                           | Regenerate the animated terminal cast in the README                   |
| `node scripts/gen-packages.mjs`       | Regenerate package manifests after changing the package graph         |

### Coverage gates

Enforced by `pnpm test:coverage`, blocking in CI. Default is 70 lines / 65 branches.

Thirteen packages are raised above it. The table lives in `vitest.config.ts`, with a
comment on each entry saying what an untested branch there would actually cost:

| Package                                               | Lines | Branches |
| ----------------------------------------------------- | ----- | -------- |
| `security`                                            | 95    | 95       |
| `i18n`                                                | 90    | 90       |
| `core`, `channels`, `tui`                             | 90    | 85       |
| `agent`, `runtime`, `extension-host`, `server`, `web` | 85    | 80       |
| `providers`, `tools`, `mcp`                           | 80    | 75       |
| everything else                                       | 70    | 65       |

`security` carries the strictest bar because an untested branch there is a vulnerability,
not just a bug. A new branch in a guard needs a test, or `pnpm test:coverage` fails while
`pnpm test` passes.

Only `packages/*/src/**` is measured. Nothing under `test/` counts, which is why a
`testkit` — which runs on every test and scores 94–100% — no longer pads the package that
holds it.

## Releasing

Fifteen packages publish, and they move in lockstep. Only one of them is something a
person installs by name — `@ghostai/cli`, which is what puts `ghost` on the PATH — but
`pnpm publish` rewrites `workspace:*` to the **exact** version at pack time, so a package
left behind on an old number does not degrade gracefully: it publishes a dependency that
resolves to nothing. That is why there is one version and no changesets.

Four edits and a tag:

```bash
# 1. the root version — the single source every manifest reads
#    "version": "1.1.0"  in package.json
# 2. carry it into all fifteen manifests
node scripts/gen-packages.mjs
# 3. VERSION in packages/cli/src/program.ts        — what `ghost --version` prints
# 4. SERVER_VERSION in packages/server/src/version.ts — what GET /api/status and
#    the OpenAPI document report

git commit -am 'Release 1.1.0' && git tag v1.1.0 && git push --follow-tags
```

Steps 3 and 4 are the only hand edits, and both are literals rather than a read of the
manifest on purpose: the bundle lands in `dist/`, so a relative read resolves differently
in the workspace and in a published tarball — a version that is silently _wrong_ is worse
than one that is missing. `program.test.ts` and `app.test.ts` each fail if you forget,
which is how they are meant to be found.

The tag fires [`release.yml`](../.github/workflows/release.yml), which runs the whole
gate again — a tag can be pushed from a branch CI never saw — checks the tag against the
manifests, publishes with `--provenance`, and attaches the tarballs to a GitHub release
for an install that never reaches a registry.

Three things about the manifests, all of which cost an afternoon to find:

- **`files` must say `dist/**`, not `dist`.** npm packs a bare directory name wholesale
  and never consults a later negation, so `['dist', '!dist/**/*.map']` ships every
  sourcemap and looks like it worked. `@ghostai/web` is 8 MB of maps on 11.8 MB total,
  for a built SPA nobody installing `ghost` will step through.
- **The `development` export condition cannot be published.** It points at
  `./src/index.ts`, `src` is not in `files`, and Vite's dev server sets that condition —
  so a published package imported from one fails to resolve against a file that was never
  in the tarball. `publishConfig.exports` drops it; the workspace keeps it, because it is
  what lets `tsx` run the repo with no build.
- **`web` and `i18n` are not generated.** They are hand-maintained, and the generator
  patches only their release fields for exactly this reason — `i18n` was found sitting at
  `0.0.0` while every generated package had moved, and nothing about it looked wrong.

Before a first publish, prove the graph resolves outside the workspace. This exercises
`resolveUiRoot`'s `createRequire(...).resolve('@ghostai/web/package.json')`, which is the
resolution most likely to break once packages are laid out by a registry install rather
than by pnpm's workspace links:

```bash
pnpm build
pnpm --filter @ghostai/cli deploy /tmp/ghost-deploy --legacy
node /tmp/ghost-deploy/dist/index.js serve --port 3999   # should print a UI path
pnpm install --frozen-lockfile                           # deploy leaves pnpm's state odd
```

## Screenshots

Every picture in the README and in [Web UI](web-ui.md) is generated. `pnpm screenshots`
builds, boots the e2e harness — the real server, the real bundle, the real turn over a
scripted provider — drives each screen to the state worth showing, and writes twenty PNGs
into `docs/screenshots/`, one per screen per colour scheme. They are committed, because
GitHub cannot run a build step to render a README.

Regenerate them whenever the UI changes, and commit what comes out. **Two runs on one
machine produce byte-identical files**, so an image that shows up in `git status` means
the UI moved — which makes the diff worth reading rather than noise to skip. Two
_different_ machines will not agree, because font rasterisation is the platform's; there
is no CI gate on these for that reason.

`packages/e2e/src/screenshots/capture.ts` is a sibling of `fidelity/capture.ts`, not a
mode of it — the fidelity tool refuses to run without a reference product, and this one
has to work on any clone. Its header explains the five things that had to be pinned down
to get a stable image, and the surprising one is not the clock or the fonts: it is that
seed rows written in a loop share a millisecond often enough to make a list ordered
`time DESC, id ASC` reshuffle between runs.

### The terminal cast

`pnpm demo` regenerates `docs/screenshots/demo.svg`, the animated recording at the top of
the README. `scripts/demo-provider.mjs` stands up a mock `openai-chat` endpoint,
`scripts/ptyrec.py` records **bash** on a real pty — typing `ghost chat`, waiting for the
TUI, asking a question — and `svg-term` renders the cast to a self-contained SVG. Every
byte on screen came back through the pty from the real binary; the keystroke schedule is
authored so the run reproduces.

Three things that are not obvious:

- **A pipe is not a terminal.** Piping `ghost chat` gets the plain stream it writes for a
  machine — no session header, no composer, no status bar, no spinner. The child has to
  believe it is on a tty, and `script(1)` needs a controlling terminal that tooling does
  not always have. Python's `pty` is stdlib and needs nothing.
- **The mock must be its own process.** `demo-cast.mjs` drives the recorder with
  `execFileSync`, which blocks its event loop for the length of the take. A server in that
  process accepts nothing, and the recording is ten seconds of `thinking…`.
- **The cast ends at its last byte**, and the answer lands milliseconds after the question
  is sent. Without the trailing hold in `ptyrec.py` the loop is all typing and a flash of
  the reply.

The first cast had a doubled status bar and unrenderable glyphs, and both were the same
bug — the recorder decoded each `os.read` chunk on its own, so a multi-byte character
split across a read boundary became two U+FFFD, and a split _escape sequence_ corrupted
the repaint that erases the footer. `ptyrec.py` now holds partial sequences in an
incremental decoder. If either artifact comes back, that is where to look — not at
svg-term.

## Conventions

- **ESM only.** `"type": "module"` everywhere, `.js` extensions in relative imports
  (NodeNext resolution).
- **`isolatedDeclarations` is on** everywhere except `protocol`. Every exported function
  needs an explicit return type; this keeps declaration emit fast and makes the public API
  surface reviewable in diffs. `protocol` is the exception because a Zod schema export
  _is_ an inference result, and annotating it by hand would recreate the drift the schemas
  exist to prevent.
- **`tsup` owns the JavaScript, `tsc -b` owns the types.** `emitDeclarationOnly` keeps
  `tsc` from overwriting the bundle, `clean: false` keeps `tsup` from deleting the
  declarations. `pnpm build` runs both in that order. Delete `dist` to force a full
  rebuild.
- **Zod is the single source of truth** for config, wire messages and tool parameters.
  Types come from `z.infer`, JSON Schema from `z.toJSONSchema`. Never hand-write a type a
  schema could produce — and every exported `*Schema` must be registered in `schemas.ts`,
  which a test enforces.
- **Errors are values, not strings.** Never branch on a substring of an error message.
  Return a typed discriminated union with a `kind`.
- **One cancellation mechanism.** A single `AbortSignal` threads from the request through
  the loop, the provider fetch, tool execution and any child process. No parallel
  `_running` flags, no bespoke timeouts.
- **No shell, ever.** `exec` takes `argv: string[]` and calls `execFile` with
  `shell: false`. A lint rule fails the build on `shell: true`.
- **No `Math.random()`.** Inject a generator so tests are deterministic; use `node:crypto`
  for anything security-relevant. Also lint-enforced.
- **Injected `Clock` and `fetch`.** Tests use fake timers and a mock dispatcher; nothing
  sleeps and nothing touches the network.

### Layering

```
{ protocol, i18n } → core → security → { providers, tools } → { mcp, agent } ─┬→ runtime → server ┐
{ protocol, i18n } → web                                                      │                   │
             core → channels ────────────────→ extension-host ────────────────┘                   ├→ cli
                    tui                                                                           ┘
```

Enforced two ways, both mechanical: pnpm's isolated `node_modules` means an undeclared
`@ghostai/x` import fails to _resolve_, not merely to lint; and `no-restricted-imports`
bans the deep relative paths that would sneak across a boundary.

The agent must never reach back into the HTTP server.
[Architecture](architecture.md#layering) explains why `tui` sits beside the roots.

## Working on the UI

There is no CSS framework and there are three token gates. The full picture is in
[Web UI](web-ui.md#design-tokens); the short version:

- `styles/tokens.css` is the only file allowed a raw colour or a `px` literal.
- `pnpm --filter @ghostai/web lint` runs ESLint _and_ the gates.
- `/tokens` in the running app renders every token and primitive on one page.
- A contrast test resolves the sheet in both themes and holds every text-on-surface
  pairing to WCAG AA, so a seed edit that darkens text past the line fails the suite.

**Restart `ghost serve` after a UI build.** `@fastify/static` enumerates the UI directory
once at boot, so a rebuild underneath a running server serves the new `index.html` and
404s its hashed assets into the SPA fallback — a blank page that looks like a crash and is
not one. For an edit-reload loop use the Vite dev server instead.

## End-to-end tests

```bash
pnpm build
pnpm --filter @ghostai/e2e exec playwright install chromium   # once
pnpm --filter @ghostai/e2e test:e2e
```

Every spec boots its own server in-process against a scripted model, so nothing reaches
the network and nothing shares state. **The colour scheme is a Playwright project**, which
means every assertion runs twice.

### Never assert a transient state

This is what broke CI four runs in a row. A spec waited for the line an approval card shows
_between_ the operator answering and the tool result arriving. The scripted provider
answers inside a frame, so whether that line is ever painted depends on how the runner
interleaves the re-render with the socket message. It passed locally every time and failed
CI every time.

Assert the **durable** state a step settles into — the card's `Succeeded`/`Failed` status,
the text in the transcript — and cover the in-between wording in a component test, where
the state can be held still. The rule of thumb: **if the only reason you can see it is
that the machine was slow, it does not belong in an `expect`.**

### The fidelity gate

`fidelity.spec.ts` compares the shell's geometry and colour ramps against a checkout of a
reference build. That checkout is not in this repository and is not required — point
`GHOSTAI_FIDELITY_ORIGINAL` at one to run the gate, and
`pnpm --filter @ghostai/e2e baseline` to write the side-by-side captures. Without it the
gate skips.

## Translations

Two CI gates catch opposite halves of the problem, and neither substitutes for the other:

- **`pnpm i18n:check`** runs the extractor and fails if the locale bundles moved — this
  finds a key that was used in code and never reached the bundle a translator reads.
- **`untranslated.test.ts`** sweeps the source for English prose in JSX text and in
  `aria-label`, `placeholder`, `title`, `alt` and friends — this finds copy that never
  became a key at all.

The JSON bundle _is_ the type: keys are walked into a dotted-path union, so a typo is a
compile error rather than a string that renders as itself.

## Areas that touch more than they look like they do

**Auth.** The credential surface spans `packages/protocol/src/rest.ts` (DTOs — and every
exported `*Schema` must also be registered in `schemas.ts`), `packages/server/src/`
(`auth-store.ts`, `login-throttle.ts`, `routes/auth.ts`, `manifest.ts`), the two web
overlays, the Account settings panel, **and the e2e harness** — the last of which only
unit tests plus e2e catches.

**Config.** A new key means the schema, the patch merge rules if it is a record, the
settings panel, and this documentation. A key that parses but is never read should say so
in its doc comment, so the next person does not go looking for the consumer.
