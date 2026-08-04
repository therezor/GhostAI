# Development

## Setup

```bash
pnpm install
pnpm build
pnpm --filter @ghostai/cli link --global   # gives you `ghost`
```

Node ≥ 22.11 and pnpm ≥ 10. The Node floor is `node:sqlite`, which means no native module
to compile and no prebuilds to go missing.

## The gate

**`pnpm check` is not the CI gate.** It runs `typecheck`, `lint` and `test`, and CI runs
five more things on top — most local sessions that end green and then fail CI fail on
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
| `node scripts/gen-packages.mjs`       | Regenerate package manifests after changing the package graph         |

### Coverage gates

Enforced by `pnpm test:coverage`, blocking in CI. Default is 70 lines / 65 branches.

| Package                             | Lines | Branches |
| ----------------------------------- | ----- | -------- |
| `security`                          | 95    | 95       |
| `core`, `channels`                  | 90    | 85       |
| `i18n`                              | 90    | 90       |
| `agent`, `runtime`, `server`, `web` | 85    | 80       |
| `providers`, `tools`                | 80    | 75       |
| everything else                     | 70    | 65       |

`security` carries the strictest bar because an untested branch there is a vulnerability,
not just a bug. A new branch in a guard needs a test, or `pnpm test:coverage` fails while
`pnpm test` passes.

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
protocol → core → { security, providers } → tools → { mcp, agent } → runtime → server → cli
```

Enforced two ways, both mechanical: pnpm's isolated `node_modules` means an undeclared
`@ghostai/x` import fails to _resolve_, not merely to lint; and `no-restricted-imports`
bans the deep relative paths that would sneak across a boundary.

The agent must never reach back into the HTTP server.

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
