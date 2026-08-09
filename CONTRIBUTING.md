# Contributing

## Setup

```bash
git clone https://github.com/therezor/GhostAI.git
cd GhostAI
pnpm install
pnpm build
pnpm --filter @ghostwire/ghostai link --global    # gives you `ghostai`
```

Node ≥ 22.13, pnpm 11 (`corepack enable`). The Node floor is exact — `node:sqlite` was
unflagged in 22.13, and 22.12 fails at startup rather than degrading.

`link --global` points `ghostai` at your working copy, so it shadows any
`npm install -g @ghostwire/ghostai` you already had. `pnpm --filter @ghostwire/ghostai unlink --global`
puts the released one back.

## Before you open a pull request

**`pnpm check` is not the gate.** It runs `typecheck`, `lint` and `test`; CI runs six more
things on top, and the one that catches most people is `format:check`, which `pnpm check`
never calls.

```bash
pnpm typecheck
pnpm lint
pnpm --filter @ghostwire/web exec tsx src/tokens/run-gates.ts   # design token gates
pnpm format:check                                             # ← the usual failure
pnpm i18n:check
pnpm test
pnpm build
pnpm test:coverage                                            # stricter than pnpm test
pnpm --filter @ghostwire/e2e test:e2e                           # needs the build above
```

[Development](docs/development.md) is the full walkthrough — what each gate catches, the
coverage bars, the e2e suite and the UI loop. Read it once before your first change.

Say what you actually ran. An unqualified "all tests pass" that meant `pnpm test` is how
most red CI runs happen; "typecheck, lint, test and format, not e2e — the change is
server-only" is a useful sentence and takes no longer to write.

## The rules a linter cannot enforce

The style guide is [Google's][gts], and `eslint.config.js` plus `.prettierrc.json` are
the machine-checkable half of it — 80 columns, no leading or trailing underscores,
`private` rather than `#private`. Run the linter and you have complied. The rest:

- **Tests live in `test/`, mirroring `src/`.** The test for `packages/server/src/hub.ts`
  is `packages/server/test/hub.test.ts`. Nothing under `src/` is a test, and a `testkit/`
  is never in `src/`. Reach source through the `#src/…` alias (`@/…` in web), never a
  relative path.
- **Never assert a transient state in an e2e test.** Assert what a step _settles_ into —
  a card's final status, the text in the transcript. If the only reason you can see
  something is that the machine was slow, it does not belong in an `expect`; cover the
  in-between wording in a component test where the state can be held still.
- **Errors are values.** Return a typed union with a `kind`; never branch on a substring
  of a message.
- **No shell, ever.** `exec` takes `argv: string[]` and calls `execFile` with
  `shell: false`. A lint rule fails the build on `shell: true`.
- **Comments say why, not what.** This codebase carries its reasoning in the source — the
  docs are written from it rather than from each other. If you close a subtle hole, the
  comment explaining which hole is the more valuable half of the change.

[gts]: https://google.github.io/styleguide/tsguide.html

## Changes that touch more than they look like they do

- **Anything about credentials or auth** spans `packages/protocol/src/rest.ts` (and every
  exported `*Schema` must be registered in `schemas.ts`, which a test enforces),
  `packages/server/src/auth-store.ts`, `login-throttle.ts`, `routes/auth.ts`,
  `manifest.ts`, both web overlays, the Account settings panel, **and the e2e harness** —
  the last of which only unit tests plus e2e catch.
- **Any string a person reads** needs a translation key, and there are two CI gates
  pulling in opposite directions: one finds copy that never became a key, the other finds
  keys that never reached the bundle. `pnpm i18n:extract` fixes the second.
- **Anything under `packages/web`** is subject to the design token gates: no `px` outside
  `tokens.css`, no raw hex/rgb/oklch outside it, no `--color-accent` in a text or border
  position. If the UI changed visibly, regenerate the screenshots with `pnpm screenshots`
  and commit them.
- **Adding a package** needs both of its `tsconfig.json` references added at the root, and
  an entry in `scripts/gen-packages.mjs` — the package manifests are generated, so
  editing one by hand is reverted by the next run.

## Reporting a bug

Include the version (`ghostai --version`), what you expected, what happened, and enough to
reproduce it. `--verbose` and `GHOSTAI_DEBUG=1` (which prints stack traces rather than the
operator sentence) usually turn a vague report into a fixable one.

**Security issues do not go in an issue.** See [SECURITY.md](SECURITY.md).

## Licence

By contributing you agree that your work is licensed under the [MIT licence](LICENSE),
the same as the rest of the project.
