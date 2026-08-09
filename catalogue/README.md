# catalogue

The things an operator installs: agent presets, and the toolboxes some of them
run in. Data only — no TypeScript, no build step, nothing imported.

```
presets/<id>.json          an agent preset. The filename is the agent id.
toolboxes/<name>/          a Dockerfile and the manifest describing its policy
build.sh <name>            builds one image and installs its manifest
```

It is a package rather than a loose folder for one reason: `@ghostbot/cli` has
to find `presets/` at runtime, in a workspace checkout **and** in a global npm
install. It resolves this package the same way the server finds the built SPA —
`require.resolve('@ghostbot/catalogue/package.json')` — which is a path that
works identically in both, unlike anything relative to `dist/`.

**Its `version` is bumped by hand at release**, alongside `SERVER_VERSION` in
`packages/server/src/version.ts` and `VERSION` in `packages/cli/src/program.ts`.
`scripts/gen-packages.mjs` does not generate this manifest — there is no `src`
to describe — so it is the one workspace package that number can be forgotten
in. `pnpm publish` rewrites the CLI's `workspace:*` to an exact version at pack
time, and a version that disagreed with its siblings would publish a dependency
range resolving to nothing.

## Presets

One JSON file per agent, all in one directory, whether or not the agent needs a
container. `ghost agent install <id>` reads them from here, after looking in
`~/.ghostai/presets/` so an operator's own file of the same name wins.

A preset that needs a toolbox names it in `toolbox.name`; the toolbox itself is
installed and approved separately, and installing the preset refuses until it
is. See [docs/toolboxes.md](../docs/toolboxes.md).

## Toolboxes

`build.sh <name>` runs `docker build`, pins the resulting image **id** into the
manifest and installs it to `~/.ghostai/toolboxes/<name>/`. Nothing runs until
`ghost toolbox approve <name>` records the hash of the bytes you reviewed.
