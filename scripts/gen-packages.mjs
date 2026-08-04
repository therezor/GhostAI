#!/usr/bin/env node
/**
 * Generates package.json + tsconfig.json for each workspace package.
 * Idempotent — safe to re-run when the package graph changes.
 *
 * The `development` export condition points at ./src/index.ts so `tsx` runs
 * the workspace with no build step; `default` points at built output.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import prettier from 'prettier';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

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

/** @type {Record<string, { description: string; deps?: Record<string,string>; devDeps?: Record<string,string>; internal?: string[]; bin?: Record<string,string>; compilerOptions?: Record<string, unknown>; tsconfigNotes?: Record<string,string> }>} */
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
    internal: ['protocol'],
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
    // `@ghostai/runtime`'s tests drive a connector to prove a settings save
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
    subpaths: { './testkit': 'src/testkit/index.ts' },
    // Tests only — the tests here define tools with `defineTool`. Nothing in
    // this package's runtime graph imports zod.
    devDeps: { zod: '^4.0.0' },
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
    internal: ['protocol', 'core', 'security', 'providers', 'agent'],
    // `zod` is a runtime dependency here, unlike in `agent` and `runtime`: the
    // route helper calls `z.toJSONSchema` to generate the OpenAPI document and
    // `safeParse` to validate every request body.
    deps: {
      '@fastify/cookie': '^11.0.0',
      '@fastify/rate-limit': '^10.2.0',
      '@fastify/static': '^8.1.0',
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
  },
  channels: {
    description:
      'The channel contract and the manager bridging MessageBus to the session hub.',
    // The one package that exports its testkit. `channelConformance` has to be
    // runnable by a channel that lives *outside* this repo — a plugin channel
    // in Phase 4 — and the provider and tool suites' rule (importable only from
    // inside the package) would make the contract unverifiable exactly where it
    // matters most. It stays off the package entry, so `vitest` is still not in
    // anyone's runtime graph unless they ask for it by subpath.
    subpaths: { './testkit': 'src/testkit/index.ts' },
    external: ['vitest'],
    // Neither `server` nor `agent`. A channel publishes an `InboundMessage` and
    // consumes `OutboundMessage`s; the hub it bridges to is stated here as a
    // structural port, so this package cannot reach into the transport it feeds
    // and a plugin channel cannot reach the agent loop through it.
    internal: ['protocol', 'core'],
  },
  cli: {
    description: 'GhostAI command line interface.',
    internal: [
      'protocol',
      'core',
      'security',
      'providers',
      'tools',
      'agent',
      'runtime',
      'server',
      'channels',
    ],
    // `@ghostai/web` is a plain dependency and not an `internal`, because the
    // relationship is not a TypeScript one: `resolveUiRoot` finds the built SPA
    // through `require.resolve('@ghostai/web/package.json')` and serves the
    // directory. A project reference would make `tsc -b` demand declarations
    // from a package whose tsconfig is `noEmit` — Vite owns its JavaScript, and
    // nothing here imports a type from it.
    deps: {
      '@ghostai/web': 'workspace:*',
      commander: '^13.0.0',
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
    dependencies[`@ghostai/${dep}`] = 'workspace:*';
  }

  const pkg = {
    name: `@ghostai/${name}`,
    version: '0.0.0',
    description: cfg.description,
    type: 'module',
    license: 'MIT',
    exports: {
      '.': {
        development: './src/index.ts',
        types: './dist/index.d.ts',
        default: './dist/index.js',
      },
      ...Object.fromEntries(
        Object.entries(cfg.subpaths ?? {}).map(([subpath, entry]) => {
          const out = entry.replace(/^src\//, '').replace(/\.ts$/, '');
          return [
            subpath,
            {
              development: `./${entry}`,
              types: `./dist/${out}.d.ts`,
              default: `./dist/${out}.js`,
            },
          ];
        }),
      ),
    },
    main: './dist/index.js',
    types: './dist/index.d.ts',
    // Tests are colocated in src/ so they are typechecked and linted like
    // everything else; the negation keeps them out of the published tarball.
    files: ['dist', '!dist/**/*.test.*'],
    ...(cfg.bin ? { bin: cfg.bin } : {}),
    scripts: {
      build: 'tsup && tsc -b',
      typecheck: 'tsc -b',
      test: 'vitest run',
      lint: 'eslint src',
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

  const entries = [
    "'src/index.ts'",
    ...Object.values(cfg.subpaths ?? {}).map((e) => `'${e}'`),
  ];

  // Without a config of its own, a package running `vitest run` from its own
  // directory finds the *root* config and inherits its `projects` globs — which
  // are relative to the root, match nothing from inside `packages/x`, and fail
  // with "No projects were found". So `pnpm --filter @ghostai/x test` was broken
  // everywhere, which is why the build plan noticed it for `protocol` alone: it
  // is the package a contributor is most likely to run on its own.
  //
  // The `name` is the second half. It is what `vitest --project <name>` selects
  // and what labels a line of output in a run that spans twelve packages.
  const vitest = `import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '${name}',
    include: ['src/**/*.test.ts'],
  },
});
`;

  const tsup = `import { defineConfig } from 'tsup';

export default defineConfig({
  entry: [${entries.join(', ')}],
  format: ['esm'],
  target: 'node22',
  // tsc -b writes its declarations and .tsbuildinfo into this same dist, so
  // cleaning here would delete them and leave tsc believing they still exist.
  // Removing dist by hand is what forces a full rebuild of both tools.
  clean: false,
  dts: false, // tsc -b emits declarations; rollup-plugin-dts is the slow path
  sourcemap: true,${
    cfg.external === undefined
      ? ''
      : `
  // tsup bundles anything it can resolve that is not a declared dependency, and
  // a test framework resolvable from the workspace root is exactly that: without
  // this, half a megabyte of ${cfg.external.join(', ')} ends up inside dist/.
  external: [${cfg.external.map((name) => `'${name}'`).join(', ')}],`
  }
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
