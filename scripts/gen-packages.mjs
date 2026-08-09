#!/usr/bin/env node
/**
 * Generates package.json + tsconfig.json for each workspace package.
 * Idempotent — safe to re-run when the package graph changes.
 *
 * The `development` export condition points at ./src/index.ts so `tsx` runs
 * the workspace with no build step; `default` points at built output.
 */
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import prettier from 'prettier';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * One version for the whole workspace, taken from the root manifest.
 *
 * Every package here is released together and only one of them — the CLI — is
 * something a person installs by name, so per-package versions would be
 * bookkeeping with no reader. Bumping the root and re-running this is the whole
 * release ceremony; there is no changesets bot to keep fed.
 *
 * It matters that this is *read* rather than repeated: `pnpm publish` rewrites
 * `workspace:*` to the exact version at pack time, so a package whose own
 * version disagreed with its siblings' would publish a dependency range that
 * resolves to nothing.
 */
const { version: VERSION } = JSON.parse(
  readFileSync(join(ROOT, 'package.json'), 'utf8'),
);

const REPOSITORY_URL = 'git+https://github.com/therezor/GhostAI.git';
const HOMEPAGE = 'https://github.com/therezor/GhostAI';

/** A package's subpath exports, shared by the workspace and published maps. */
const subpathExports = (cfg) =>
  Object.fromEntries(
    Object.entries(cfg.subpaths ?? {}).map(([subpath, entry]) => [
      subpath,
      { types: `./${entry}`, default: `./${entry}` },
    ]),
  );

/**
 * The `exports` map as a tarball should carry it: no `development` condition.
 *
 * See the note beside `publishConfig` below for why that one line cannot be
 * published. Everything else is identical, deliberately — a published package
 * that resolved differently from the workspace one would make every bug found
 * by an installer unreproducible here.
 */
const publishedExports = (cfg) => ({
  '.': { types: './dist/index.d.ts', default: './dist/index.js' },
  ...subpathExports(cfg),
});

/** Write a file through Prettier so regenerating never fails `format:check`. */
async function writeFormatted(path, contents) {
  const config = await prettier.resolveConfig(path);
  writeFileSync(
    path,
    await prettier.format(contents, { ...config, filepath: path }),
  );
}

/**
 * Injects `//` comments above named keys of a serialized tsconfig.
 *
 * JSON has no syntax for a comment and `tsconfig.json` does, so the rationale
 * for an override cannot survive `JSON.stringify`. Without this, re-running the
 * generator silently deletes the explanation for every deviation from the base
 * config — which is the half of the file worth reading.
 */
function withNotes(json, notes) {
  let out = json;
  for (const [key, note] of Object.entries(notes)) {
    const comment = note
      .split('\n')
      .map((line) => (line === '' ? '//' : `// ${line}`))
      .join('\n');
    out = out.replace(
      new RegExp(`^(\\s*)"${key}":`, 'm'),
      `\n${comment}\n$1"${key}":`,
    );
  }
  return out;
}

/** @type {Record<string, { description: string; deps?: Record<string,string>; devDeps?: Record<string,string>; internal?: string[]; bin?: Record<string,string>; subpaths?: Record<string,string>; testkit?: boolean; compilerOptions?: Record<string, unknown>; tsconfigNotes?: Record<string,string> }>} */
const PACKAGES = {
  protocol: {
    description:
      'Zod schemas and derived types shared by every GhostAI package.',
    deps: { zod: '^4.0.0' },
    compilerOptions: { isolatedDeclarations: false },
    tsconfigNotes: {
      isolatedDeclarations: [
        'The one package that cannot honour `isolatedDeclarations`. Every export',
        'here is a Zod schema whose type is the *result* of inference',
        '(`z.object({...})` → a deep `ZodObject<...>`), so the declaration emitter',
        'cannot write a signature without type-checking the expression: TS9010.',
        '',
        'The alternative is to hand-write a TS type beside every schema and',
        'annotate it as `z.ZodType<T>`, which reintroduces exactly the',
        'schema/type drift this package exists to remove. Inference is the more',
        'valuable half of the pair, so it wins here and only here; every other',
        'package keeps the flag on.',
      ].join('\n'),
    },
  },
  core: {
    description:
      'Canonical message types, session store, message bus, logger, clock.',
    // `i18n` is declared and currently unimported: the keyed-error layer that
    // used it was removed and the manifest was not. Left in place rather than
    // dropped here, because a generator run is the wrong place to decide that.
    internal: ['protocol', 'i18n'],
    deps: { pino: '^9.5.0', zod: '^4.0.0' },
  },
  security: {
    description:
      'Credential vault, workspace jail, SSRF-guarded fetch, exec argv guard.',
    internal: ['protocol', 'core'],
    deps: { undici: '^7.2.0' },
  },
  providers: {
    description:
      'LLM provider registry, wire adapters, and resilience decorator.',
    internal: ['protocol', 'core', 'security'],
    // undici for the streaming request path: `fetch` alone cannot carry a
    // per-provider dispatcher, and the pool's idle timeouts are what tell a
    // hung model server apart from a slow one.
    deps: { 'gpt-tokenizer': '^2.8.0', undici: '^7.2.0' },
    // A conformance suite and a recording clock, importable from inside this
    // package only. Unlike `tools` and `channels`, nothing outside the repo has
    // a reason to run it: a wire adapter is code an extension supplies, and it
    // is exercised through `createProvider` like any other.
    testkit: true,
  },
  tools: {
    description: 'Tool definition helper, registry, and built-in tools.',
    internal: ['protocol', 'core', 'security'],
    deps: { zod: '^4.0.0' },
    // `toolConformance` is the contract every tool holds, and two of the three
    // kinds of tool — MCP-proxied and plugin-supplied — are defined in other
    // packages. Same argument `channelConformance` won; same arrangement.
    subpaths: { './testkit': 'test/testkit/index.ts' },
  },
  mcp: {
    description:
      'MCP client, connection lifecycle, and the bridge onto the tool registry.',
    // Above `tools` and below `runtime`: it turns a remote tool descriptor into
    // a `Tool`, and knows nothing about config files, HTTP or the session hub.
    internal: ['protocol', 'core', 'security', 'tools'],
    deps: { '@modelcontextprotocol/sdk': '^1.30.0' },
    // Tests only — `sdk-connector.test.ts` stands up a real `McpServer` on the
    // other end of an in-memory transport, and the SDK's server half describes
    // a tool's arguments with zod. Nothing in this package's runtime graph
    // imports it.
    devDeps: { zod: '^4.0.0' },
    // `@ghostbot/runtime`'s tests drive a connector to prove a settings save
    // reconciles the right servers, and the composition root has no more
    // business spawning a subprocess than this package does.
    subpaths: { './testkit': 'test/testkit/index.ts' },
  },
  agent: {
    description: 'The agent loop, subagent manager, and context contributors.',
    internal: ['protocol', 'core', 'security', 'providers', 'tools'],
    // The scripted provider, exported because the end-to-end suite is a second
    // consumer in another package. Duplicating it there would let the model a
    // browser test drives behave differently from the one every loop test
    // asserts against. Unlike the provider and tool conformance suites this
    // imports no `vitest`, so the entry pulls no test framework into a graph.
    subpaths: { './testkit': 'test/testkit/index.ts' },
    // Tests only — the tests here define tools with `defineTool`. Nothing in
    // this package's runtime graph imports zod.
    devDeps: { zod: '^4.0.0' },
  },
  'extension-host': {
    description:
      'Discovers, authorises, loads and unloads extensions, and collects what they contribute.',
    // Above every registry it hands work to and below the composition root that
    // applies it. `channels` is in the list for its `ChannelFactory` type alone,
    // which is also why this package rather than `runtime` owns the host:
    // `runtime` has no business importing `channels`, and an extension
    // contributing a channel has to be able to say so somewhere.
    internal: [
      'protocol',
      'core',
      'security',
      'providers',
      'tools',
      'agent',
      'channels',
    ],
    // Tests only — the conformance suite builds a tool with `defineTool` to
    // prove an extension's registration reaches the registry intact.
    devDeps: { zod: '^4.0.0' },
    // The suite an out-of-tree extension runs against its own `activate`.
    subpaths: { './testkit': 'test/testkit/index.ts' },
  },
  runtime: {
    description: 'The shared composition root: config in, a running agent out.',
    internal: [
      'protocol',
      'core',
      'security',
      'providers',
      'tools',
      'mcp',
      'agent',
      'extension-host',
    ],
    // Tests only — one test registers a tool with `defineTool` to prove a
    // reconfigure does not drop it. Nothing in the runtime graph imports zod.
    devDeps: { zod: '^4.0.0' },
  },
  server: {
    description:
      'Fastify app, boot policy, authentication, and the session hub.',
    // `agent` is a dependency of the *transport*, never the other way round: the
    // hub drives `AgentLoop.run()` and forwards its events, and the loop has no
    // idea a socket exists. The layering lint rule and pnpm's isolated
    // node_modules together keep that arrow pointing one way.
    // `providers` is here for its registry alone — `describeProvider` over the
    // `PROVIDERS` table is what `GET /api/providers` serves — not for an
    // adapter: nothing in this package makes a model request.
    // `tools` is here for `AutomationPort` alone: `automation-port.ts` is the
    // adapter between the scheduler's stores and the tool that reaches them.
    internal: ['protocol', 'core', 'security', 'providers', 'tools', 'agent'],
    // `zod` is a runtime dependency here, unlike in `agent` and `runtime`: the
    // route helper calls `z.toJSONSchema` to generate the OpenAPI document and
    // `safeParse` to validate every request body.
    deps: {
      '@fastify/cookie': '^11.0.0',
      '@fastify/rate-limit': '^10.2.0',
      // 10.x, not 8.x: every release below 10.1.2 carries a path-traversal or
      // route-guard-bypass advisory, and this plugin is what serves the built
      // SPA — the one place a traversal would reach outside the UI root. It
      // also drags `glob` from 11 to 13, which is where the deprecation
      // warning on install came from.
      '@fastify/static': '^10.1.3',
      '@fastify/swagger': '^9.4.0',
      '@fastify/websocket': '^11.0.0',
      '@node-rs/argon2': '^2.0.0',
      fastify: '^5.2.0',
      zod: '^4.0.0',
    },
    // `@readme/openapi-parser` validates the generated document as OpenAPI 3.1;
    // `ws` is the socket test client, because the WebSocket route is the one
    // surface `fastify.inject()` cannot reach.
    devDeps: {
      '@readme/openapi-parser': '^6.3.0',
      '@types/ws': '^8.5.0',
      ws: '^8.18.0',
    },
    // A scripted hub, a clock and an in-process server, importable from inside
    // this package only.
    testkit: true,
  },
  channels: {
    description:
      'The channel contract and the manager bridging MessageBus to the session hub.',
    // One of the four packages that *export* a testkit. `channelConformance`
    // has to be runnable by a channel living outside this repo, and the
    // provider and tui suites' rule — importable only from inside the package —
    // would make the contract unverifiable exactly where it matters most. It
    // stays off the package entry, so `vitest` is never in anyone's runtime
    // graph unless they ask for it by subpath.
    subpaths: { './testkit': 'test/testkit/index.ts' },
    // Neither `server` nor `agent`. A channel publishes an `InboundMessage` and
    // consumes `OutboundMessage`s; the hub it bridges to is stated here as a
    // structural port, so this package cannot reach into the transport it feeds
    // and an extension channel cannot reach the agent loop through it.
    internal: ['protocol', 'core'],
    // A channel parses its own settings block — `ChannelsConfigSchema` is a
    // `looseObject` precisely so that a channel needs no schema change in
    // `protocol` — and parsing it means owning a schema.
    deps: { zod: '^4.0.0' },
  },
  tui: {
    description:
      'A domain-free terminal toolkit: key decoding, display-width text, and a transient selection region.',
    // No `internal`, and that absence is the whole design. This package knows
    // strings, keys and streams; it has never heard of an agent, a session or a
    // translation key. Every string reaching it is already translated, which is
    // why a caller passes prose rather than a key — and because there is no
    // `@ghostbot/*` in its manifest, an import of one does not resolve. The
    // layering is a fact about the package graph, not a rule under review.
    deps: { picocolors: '^1.1.0' },
    // A fake terminal, importable from inside this package only.
    testkit: true,
    tsconfigNotes: {
      references: [
        'No references, and that absence is the point: this package depends on no',
        '`@ghostbot/*` at all, which is what makes "domain-free" a fact the build',
        'graph enforces rather than a rule a reviewer has to remember.',
      ].join('\n'),
    },
  },
  cli: {
    description: 'GhostAI command line interface.',
    internal: [
      'protocol',
      'i18n',
      'core',
      'security',
      'providers',
      'tools',
      'agent',
      'extension-host',
      'runtime',
      'server',
      'channels',
      'tui',
    ],
    // `@ghostbot/web` is a plain dependency and not an `internal`, because the
    // relationship is not a TypeScript one: `resolveUiRoot` finds the built SPA
    // through `require.resolve('@ghostbot/web/package.json')` and serves the
    // directory. A project reference would make `tsc -b` demand declarations
    // from a package whose tsconfig is `noEmit` — Vite owns its JavaScript, and
    // nothing here imports a type from it.
    deps: {
      '@ghostbot/web': 'workspace:*',
      // Like `@ghostbot/web` above and for the same reason: the relationship is
      // not a TypeScript one. `catalogueDir` finds the shipped agent presets
      // through `require.resolve('@ghostbot/catalogue/package.json')` and reads
      // the directory. It has no `src`, so it is hand-written rather than
      // generated here — its version is bumped by hand at release.
      '@ghostbot/catalogue': 'workspace:*',
      commander: '^13.0.0',
      // The CLI holds the i18next instance directly: `translationsFor` picks a
      // locale from `GHOSTAI_LANG`, `config.ui.locale` and the POSIX chain, and
      // there is no React provider out here to do it.
      i18next: '^26.3.6',
      picocolors: '^1.1.0',
    },
    // `ws` is the socket client `serve.test.ts` drives the running server with;
    // nothing in the CLI's runtime graph imports it.
    devDeps: { '@types/ws': '^8.5.0', ws: '^8.18.0' },
    bin: { ghost: './dist/index.js' },
  },
};

for (const [name, cfg] of Object.entries(PACKAGES)) {
  const dir = join(ROOT, 'packages', name);
  mkdirSync(join(dir, 'src'), { recursive: true });

  const dependencies = { ...(cfg.deps ?? {}) };
  for (const dep of cfg.internal ?? []) {
    dependencies[`@ghostbot/${dep}`] = 'workspace:*';
  }

  const pkg = {
    name: `@ghostbot/${name}`,
    version: VERSION,
    description: cfg.description,
    type: 'module',
    license: 'MIT',
    // npm's listing, and `--provenance`'s precondition: the attestation is
    // refused unless `repository` names the repo the workflow is running in.
    repository: {
      type: 'git',
      url: REPOSITORY_URL,
      directory: `packages/${name}`,
    },
    homepage: HOMEPAGE,
    bugs: `${HOMEPAGE}/issues`,
    // A scoped package defaults to `restricted`, which fails the first publish
    // on an account without a paid plan. Declared here rather than passed as
    // `--access public` on the command line so the manifest is the record.
    //
    // `exports` is overridden rather than repeated. pnpm swaps a
    // `publishConfig` field into the packed manifest, and the one condition
    // that must not survive publication is `development`: it points at
    // `./src/index.ts`, `src` is not in `files`, and Vite's dev server *sets*
    // that condition — so a published package imported from one would fail to
    // resolve against a file that was never in the tarball. In the workspace
    // the same line is what lets `tsx` run the repo with no build.
    publishConfig: {
      access: 'public',
      exports: publishedExports(cfg),
    },
    // The floor is `node:sqlite`, and 22.13 is exact rather than cautious: the
    // module landed in 22.5 behind `--experimental-sqlite` and was unflagged
    // for the 22 line in 22.13, so 22.12 fails at startup with
    // ERR_UNKNOWN_BUILTIN_MODULE. Stated on every package and not only the
    // root, because the root is private and is not what anyone installs.
    engines: { node: '>=22.13' },
    exports: {
      '.': {
        development: './src/index.ts',
        types: './dist/index.d.ts',
        default: './dist/index.js',
      },
      // A testkit resolves straight to TypeScript and is never built. Every
      // consumer of one is a test runner — vitest for `examples/*`, Playwright
      // for `packages/e2e` — and both read TypeScript, so a build step would
      // buy nothing and a `src/` entry would put vitest in the bundle. See
      // CLAUDE.md, "A `testkit/` is never in `src/`".
      //
      // It stays in the published map for the same reason: it is TypeScript on
      // purpose, and the runners that consume it read TypeScript whether the
      // package came from the workspace or from a tarball. `files` carries
      // `test/testkit` so the source is actually there.
      ...subpathExports(cfg),
    },
    imports: {
      '#src/*': './src/*',
      ...((cfg.subpaths ?? cfg.testkit)
        ? { '#testkit/*': './test/testkit/*' }
        : {}),
    },
    main: './dist/index.js',
    types: './dist/index.d.ts',
    // Tests live in `test/`, so nothing has to be excluded here. A testkit is
    // listed beside `dist` because its subpath export resolves outside it.
    //
    // The negation is about what a published tarball should weigh.
    // `sourcemap: true` is right for a workspace and wrong for an install:
    // `@ghostbot/web`'s maps alone are 8 MB of its 11.8 MB, and they map a
    // built SPA that nobody installing `ghost` will ever step through — anyone
    // debugging this has the repo.
    //
    // **`dist/**` rather than `dist`, and that is the whole trick.** npm packs
    // a bare directory name wholesale and never consults a later negation, so
    // `['dist', '!dist/**/*.map']` silently ships all 37 maps and looks like it
    // worked. Spelling the include as a glob is what makes the exclude apply.
    // Verify with `npm pack --dry-run`, not by reading this.
    // `.tsbuildinfo` is the other thing `dist/**` sweeps up: `tsc -b` needs
    // `composite`, `composite` implies `incremental`, and every package points
    // `tsBuildInfoFile` into `dist`. It is 44-128 kB of compiler bookkeeping
    // per package — about 1.4 MB across the workspace — that means nothing to
    // anyone installing this. A dotfile, and `dist/**` matches it anyway.
    files: [
      'dist/**',
      '!dist/**/*.map',
      '!dist/.tsbuildinfo',
      ...(cfg.subpaths ? ['test/testkit'] : []),
    ],
    ...(cfg.bin ? { bin: cfg.bin } : {}),
    scripts: {
      build: 'tsup && tsc -b',
      typecheck: 'tsc -b',
      test: 'vitest run',
      lint: 'eslint src test',
    },
    dependencies: Object.keys(dependencies).length
      ? Object.fromEntries(Object.entries(dependencies).sort())
      : undefined,
    devDependencies: cfg.devDeps
      ? Object.fromEntries(Object.entries(cfg.devDeps).sort())
      : undefined,
  };

  const tsconfig = {
    extends: '../../tsconfig.base.json',
    compilerOptions: {
      rootDir: './src',
      outDir: './dist',
      tsBuildInfoFile: './dist/.tsbuildinfo',
      ...(cfg.compilerOptions ?? {}),
    },
    include: ['src/**/*'],
    // The file, not the directory. `tsc -b` accepts either and resolves a
    // directory to the `tsconfig.json` inside it; Playwright's config loader
    // reads these same files to find path aliases and only accepts the explicit
    // form, so a reference written the short way makes the end-to-end suite
    // fail to start with an error about a package it never imported.
    references: (cfg.internal ?? []).map((dep) => ({
      path: `../${dep}/tsconfig.json`,
    })),
  };

  // Without a config of its own, a package running `vitest run` from its own
  // directory finds the *root* config and inherits its `projects` globs — which
  // are relative to the root, match nothing from inside `packages/x`, and fail
  // with "No projects were found". So `pnpm --filter @ghostbot/x test` was broken
  // everywhere, which is why the build plan noticed it for `protocol` alone: it
  // is the package a contributor is most likely to run on its own.
  //
  // The `name` is the second half. It is what `vitest --project <name>` selects
  // and what labels a line of output in a run that spans twelve packages.
  const vitest = `import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '${name}',
    include: ['test/**/*.test.ts'],
  },
});
`;

  const tsup = `import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node22',
  // tsc -b writes its declarations and .tsbuildinfo into this same dist, so
  // cleaning here would delete them and leave tsc believing they still exist.
  // Removing dist by hand is what forces a full rebuild of both tools.
  clean: false,
  dts: false, // tsc -b emits declarations; rollup-plugin-dts is the slow path
  sourcemap: true,
  // tsup rewrites \`node:sqlite\` to \`sqlite\` otherwise — a compatibility shim for
  // node versions older than 14.18 that turns a builtin into a missing package.
  // \`node:sqlite\` has no unprefixed form at all, so the rewrite is unloadable.
  // The default flips to false in tsup 9; this is only saying so early.
  removeNodeProtocol: false,
});
`;

  await writeFormatted(join(dir, 'package.json'), JSON.stringify(pkg, null, 2));
  await writeFormatted(
    join(dir, 'tsconfig.json'),
    withNotes(JSON.stringify(tsconfig, null, 2), cfg.tsconfigNotes ?? {}),
  );
  await writeFormatted(join(dir, 'tsup.config.ts'), tsup);
  await writeFormatted(join(dir, 'vitest.config.ts'), vitest);
  console.log(`generated packages/${name}`);
}

/**
 * The release fields of the packages this generator does *not* own.
 *
 * Two packages are hand-maintained rather than generated. `web` is a Vite app
 * rather than a tsup library and exports only its own `package.json` (which is
 * how the CLI finds `dist/` to serve); `i18n` carries split `./web` and `./cli`
 * subpath bundles so the terminal never loads browser copy. Regenerating either
 * from the template above would be writing a shape it does not have.
 *
 * But both publish alongside the rest, and `pnpm publish` rewrites
 * `workspace:*` to an **exact** version — so one left behind on an old number
 * does not degrade, it publishes a dependency that resolves to nothing. That is
 * not hypothetical: `i18n` was found sitting at `0.0.0` while every generated
 * package had moved, and nothing about it looked wrong. Patching the fields
 * that must agree is narrower than owning the files, and removes the only way
 * they can drift.
 *
 * A package added here later needs adding to this list. The check that catches
 * a miss is `pnpm -r exec node -p "require('./package.json').version"`.
 */
for (const name of ['web', 'i18n']) {
  const path = join(ROOT, 'packages', name, 'package.json');
  const pkg = JSON.parse(readFileSync(path, 'utf8'));
  // Whatever the file already says, minus the one condition a tarball must not
  // carry. Derived from what is there rather than restated, so a subpath added
  // by hand is covered without anyone remembering this loop exists.
  const published = Object.fromEntries(
    Object.entries(pkg.exports ?? {}).map(([subpath, target]) => {
      if (typeof target === 'string') return [subpath, target];
      const { development, ...rest } = target;
      return [subpath, rest];
    }),
  );

  const patched = {
    ...pkg,
    version: VERSION,
    repository: {
      type: 'git',
      url: REPOSITORY_URL,
      directory: `packages/${name}`,
    },
    homepage: HOMEPAGE,
    bugs: `${HOMEPAGE}/issues`,
    publishConfig: {
      ...(pkg.publishConfig ?? {}),
      access: 'public',
      exports: published,
    },
    engines: { node: '>=22.13' },
    // `dist` becomes `dist/**` so the negation applies at all — see the note on
    // `files` above. Anything else the package listed (`i18n` ships `locales`)
    // is kept as it was.
    //
    // The filter drops what this loop itself writes, not just `dist`: the
    // generator promises to be idempotent, and a re-run that appended its own
    // output produced `["dist/**", "!dist/**/*.map", "dist/**",
    // "!dist/**/*.map"]` — harmless to npm, and a diff on every run.
    files: [
      'dist/**',
      '!dist/**/*.map',
      ...(pkg.files ?? []).filter(
        (entry) => !['dist', 'dist/**', '!dist/**/*.map'].includes(entry),
      ),
    ],
  };
  await writeFormatted(path, JSON.stringify(patched, null, 2));
  console.log(`patched packages/${name} (release fields only)`);
}
