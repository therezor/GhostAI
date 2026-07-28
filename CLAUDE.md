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
test, where the state can be held still (`packages/web/src/chat/approval.test.tsx`).
The rule of thumb: if the only reason you can see it is that the machine was slow,
it does not belong in an `expect`.

## Auth changes touch more places than they look like they do

The credential surface spans `packages/protocol/src/rest.ts` (DTOs — and every
exported `*Schema` must also be registered in `schemas.ts`, which a test enforces),
`packages/server/src/auth-store.ts`, `login-throttle.ts`, `routes/auth.ts`,
`manifest.ts`, the two web overlays, the Account settings panel, **and the e2e
harness** (`packages/e2e/src/harness/server.ts`, `fixtures.ts`,
`fidelity/capture.ts`) — the last of which only unit-tests-plus-e2e catches.
