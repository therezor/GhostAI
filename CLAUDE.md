# Working in this repo

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

## Auth changes touch more places than they look like they do

The credential surface spans `packages/protocol/src/rest.ts` (DTOs — and every
exported `*Schema` must also be registered in `schemas.ts`, which a test enforces),
`packages/server/src/auth-store.ts`, `login-throttle.ts`, `routes/auth.ts`,
`manifest.ts`, the two web overlays, the Account settings panel, **and the e2e
harness** (`packages/e2e/src/harness/server.ts`, `fixtures.ts`,
`fidelity/capture.ts`) — the last of which only unit-tests-plus-e2e catches.
