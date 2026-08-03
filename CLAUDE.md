# Working in this repo

## Run the tests before you call a task finished — every time

Not "when the change looks risky", not "when it touched tests". Every task, before
reporting it done. The list below is the whole gate; a task is finished when that
list is green, and saying it is finished on anything less is a false claim the user
finds out about in CI.

Two habits that make this cheap rather than a chore:

- Run it **before** writing the summary, not after. A failure found then is part of
  the task; a failure found by CI is a second session.
- Report what you actually ran. If you skipped e2e because the change was
  server-only, say that — an unqualified "all tests pass" that meant `pnpm test`
  is how the last four red CI runs happened.

## Before saying a task is done, run what CI runs

`pnpm check` is **not** the CI gate. It runs `typecheck`, `lint` and `test`, and CI
runs five more things on top of that — most sessions that end "green" and then fail
CI fail on `format:check`, which `pnpm check` never calls.

CI is `.github/workflows/ci.yml`, and it is three jobs. Run all of it:

```bash
# job: check
pnpm typecheck
pnpm lint
pnpm --filter @ghostai/web exec tsx src/tokens/run-gates.ts   # design token gates
pnpm format:check                                             # ← the usual failure
pnpm test
pnpm build

# job: coverage — per-package thresholds, stricter than the default 70/65
pnpm test:coverage

# job: e2e — Playwright, both colour schemes, against a real server
pnpm build                                                    # a precondition, not a convenience
pnpm --filter @ghostai/e2e test:e2e
```

Notes that save a cycle:

- **`pnpm format:check` fails, `pnpm format` fixes it.** Prettier is not wired into
  `lint`. When it reports files you did not touch, format only your own and say so —
  do not sweep unrelated files into the diff.
- **e2e needs `pnpm build` first.** It serves the built SPA through the real server;
  without a build the harness fails at `resolveUiRoot`.
- **The fidelity spec skips without a baseline.** `2 skipped` is the healthy result,
  not a problem to fix.
- **`@ghostai/security` and `@ghostai/server` have raised coverage gates** (95/95 and
  85/80). A new branch in a guard needs a test or `pnpm test:coverage` fails while
  `pnpm test` passes.
- **A green local e2e run is evidence, not proof.** CI runs on 2 workers on a shared
  runner; a laptop runs 5 with nothing else competing. When CI reports a failure the
  local suite will not reproduce, re-run just that spec under load before concluding
  it is CI's fault:

  ```bash
  pnpm --filter @ghostai/e2e exec playwright test <spec> --repeat-each=6
  ```

### Never assert a transient state in an e2e test

This is what actually broke e2e four runs in a row. `approvals.spec.ts` waited for
`Approved — waiting for the agent.` — the line the approval card shows _between_ the
operator answering and the tool result arriving. The scripted provider answers inside
a frame, so whether that line is ever painted depends on how the runner interleaves
the re-render with the socket message. It passed locally every time and failed CI
every time.

Assert the **durable** state a step settles into — the card's `Succeeded`/`Failed`
status, the text in the transcript — and cover the in-between wording in a component
test, where the state can be held still (`packages/web/test/chat/approval.test.tsx`).
The rule of thumb: if the only reason you can see it is that the machine was slow,
it does not belong in an `expect`.

## Where a test goes

Every test lives in its package's `test/` directory, mirroring `src/`. The test for
`packages/server/src/hub.ts` is `packages/server/test/hub.test.ts`; the test for
`packages/web/src/chat/markdown/blocks.ts` is
`packages/web/test/chat/markdown/blocks.test.ts`. Nothing under `src/` is a test.

Tests reach source through an alias, never a relative path:

- **`#src/…`** everywhere except web — a package.json `imports` entry, so
  `#src/hub.js` resolves the same way for node, tsc and vitest with no extra config.
- **`@/…`** in web, which already had the alias and uses it throughout.

Two consequences worth knowing before you fight them:

- **`test/` is its own TypeScript project** (`packages/<pkg>/test/tsconfig.json`,
  referenced from the root `tsconfig.json`). That is what keeps tests out of
  `rootDir` and so out of the emitted `dist`, and it is what ESLint's
  `projectService` finds when it walks up from a test file. A new package needs
  both of its references added at the root, not one.
- **A test no longer shares a program with the rest of `src/`**, so a module
  augmentation it used to inherit for free must now be imported by name. This is
  why `test/schema.test.ts` carries `import type {} from '@fastify/swagger'`:
  `summary` is not fastify's field, and `src/app.ts` is no longer in scope to
  merge it on.

**Web is the exception, deliberately.** Its tests are checked by
`packages/web/tsconfig.json` itself rather than a separate project, because that
config sets `noEmit` — and `tsc -b` refuses a reference to a project that disables
emit (TS6310), a reference being a promise of declarations. There is no `dist` to
keep tests out of there either, so the split would buy nothing.

### A `testkit/` is never in `src/`

`src/` is runtime code. A testkit is not runtime code, so every one of them lives in
`test/testkit/` — including the two that other packages import.

That last part is the bit worth stating, because "another package imports it" reads
like it must be built and therefore must be in `src/`. It does not. The `exports`
map can name TypeScript source directly:

```json
"./testkit": { "types": "./test/testkit/index.ts", "default": "./test/testkit/index.ts" }
```

Every consumer of a testkit is a test runner, and all of them read TypeScript —
vitest for `examples/loopback-channel`, Playwright for
`packages/e2e/src/harness/provider.ts`. Neither needs a build, so neither gets one:
`agent` and `channels` have no `src/testkit/` tsup entry and emit no `dist/testkit/`
at all. Their `files` array carries `test/testkit` beside `dist`, since the subpath
export resolves outside `dist`.

Reach a testkit by alias, never a relative path — `#testkit/server.js` (a
package.json `imports` entry), and `@testkit/render.js` in web beside the existing
`@/`. Both resolve from the package that _defines_ them, so they work unchanged
when a test in another package imports across the boundary.

Two things this arrangement bought, both of which had been quietly wrong:

- **`packages/channels/tsup.config.ts` no longer needs `external: ['vitest']`.** That
  line existed because a testkit under `src/` was a bundler entry point, and its
  comment said "without this, half a megabyte of vitest ends up inside dist/". With
  the testkit outside `src/`, tsup never sees it and the hazard is gone rather than
  suppressed.
- **Coverage stopped being padded.** A testkit runs on every test, so it scored
  94–100% and inflated the ratio for whichever package held it. Nothing under
  `test/` is inside `include: ['packages/*/src/**/*.ts']` any more, so the gates now
  measure product code alone — they got stricter, and no threshold had to move.

## Auth changes touch more places than they look like they do

The credential surface spans `packages/protocol/src/rest.ts` (DTOs — and every
exported `*Schema` must also be registered in `schemas.ts`, which a test enforces),
`packages/server/src/auth-store.ts`, `login-throttle.ts`, `routes/auth.ts`,
`manifest.ts`, the two web overlays, the Account settings panel, **and the e2e
harness** (`packages/e2e/src/harness/server.ts`, `fixtures.ts`,
`fidelity/capture.ts`) — the last of which only unit-tests-plus-e2e catches.
