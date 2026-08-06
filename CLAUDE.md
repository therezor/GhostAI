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
runs six more things on top of that — most sessions that end "green" and then fail
CI fail on `format:check`, which `pnpm check` never calls.

CI is `.github/workflows/ci.yml`, and it is three jobs. Run all of it:

```bash
# job: check
pnpm typecheck
pnpm lint
pnpm --filter @ghostai/web exec tsx src/tokens/run-gates.ts   # design token gates
pnpm format:check                                             # ← the usual failure
pnpm i18n:check                                               # extract, then diff the bundles
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
- **`pnpm i18n:check` runs the extractor and then diffs `packages/i18n/locales`.** A
  new `t()` call whose key never reached the bundle fails it; `pnpm i18n:extract`
  fixes it. Note `keepRemoved: true` — the extractor never prunes, so a key going
  stale is _not_ something this gate can see.
- **Twelve packages have raised coverage gates**, not two: `security` 95/95, `core`
  90/85, `channels` 90/85, `i18n` 90/90, `tui` 90/85, `agent`/`runtime`/`server`/`web`
  85/80, and `providers`/`tools`/`mcp` 80/75, against a 70/65 default. They live in
  `vitest.config.ts`. A new branch in a guard needs a test or `pnpm test:coverage`
  fails while `pnpm test` passes.
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

## The style guide is Google's, and the linter owns it

This repo follows the [Google TypeScript Style Guide][gts]. You do not need to
have read it: the parts a machine can check are in `eslint.config.js` and
`.prettierrc.json`, so `pnpm lint` and `pnpm format:check` are the guide as far
as a change is concerned. Read it when you want to know _why_ a rule is there.

[gts]: https://google.github.io/styleguide/tsguide.html

Two things about it that surprise people:

- **80 columns, not 100.** This is the guide's, and it is the reason almost
  every file was touched at once. That reformat is listed in
  `.git-blame-ignore-revs`, so `git blame` can skip it — GitHub reads the file
  by name, and locally it takes one command per clone:

  ```bash
  git config blame.ignoreRevsFile .git-blame-ignore-revs
  ```

- **No leading or trailing underscores, including on unused parameters.**
  There is no `argsIgnorePattern`. A parameter that is not used is deleted; one
  that cannot be deleted because it sits before a parameter that _is_ used just
  gets an ordinary name. `_x` is not available as an escape hatch.

### The deliberate deviations, and why

Everything below is a place where the guide says one thing and this repo does
another on purpose. If you are about to "fix" one of these, this is the
argument you are arguing with.

- **PascalCase is allowed for values, not only for types.** Two kinds of value
  are PascalCase by an external convention and cannot be renamed without
  breaking what reads them: a React component or context (JSX treats a
  lowercase identifier as an intrinsic element), and a zod schema
  (`ChatMessageSchema`), whose name mirrors the type it produces and which is
  re-exported across every package.
- **`export default` is allowed in `*.config.ts`.** vite, vitest, tsup and
  playwright each load their config by taking the module's default export. The
  guide's rule is about our modules; a file whose shape is dictated by the tool
  reading it is not one. Everywhere else the rule is on.
- **Object and type _properties_ are exempt from naming rules.** They are wire
  formats, HTTP header names, route keys, CSS custom properties and i18n keys —
  data whose spelling is fixed outside this repository, not identifiers.
- **`ignoreRestSiblings` is on.** `const {password, ...rest} = user` has to name
  the key it drops. Without this there is no way to omit a field at all, and the
  guide's own advice is to use rest destructuring for exactly this.
- **Tests may assert object literals.** `{matches: true} as MediaQueryListEvent`
  is the point of a fixture: it supplies the one field under test and no other,
  and the annotation the guide asks for instead would be a compile error. Only
  the object-literal case is relaxed, and only under `test/` — `as` is still the
  required syntax, and product code still annotates.

### `#private` is gone; `private` is the spelling

The guide bans `#ident` in favour of TypeScript's `private`, and converting the
repo rewrote a little over 2,000 declarations and references across 30 files.
Two consequences worth knowing before you reintroduce one by habit:

- A `private` field is a real, enumerable own property. `#x` was invisible to
  `Object.keys`, spread, `JSON.stringify` and a deep-equality assertion;
  `private x` is not. If you write a test that deep-compares an instance, it now
  sees the internals.
- A private field can no longer share a name with a public getter. The pattern
  `#items` + `get items()` does not compile, so the _private_ side gets the new
  name — `private itemsByKey` + `get items()`. Fifteen of those were renamed
  during the conversion; the public surface was left alone deliberately, because
  a getter becoming a property is an API change and a rename of a private field
  is not.

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
