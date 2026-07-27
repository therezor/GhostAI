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
  writeFileSync(path, await prettier.format(contents, { ...config, filepath: path }));
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
    out = out.replace(new RegExp(`^(\\s*)"${key}":`, 'm'), `\n${comment}\n$1"${key}":`);
  }
  return out;
}

/** @type {Record<string, { description: string; deps?: Record<string,string>; devDeps?: Record<string,string>; internal?: string[]; bin?: Record<string,string>; compilerOptions?: Record<string, unknown>; tsconfigNotes?: Record<string,string> }>} */
const PACKAGES = {
  protocol: {
    description: 'Zod schemas and derived types shared by every GhostAI package.',
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
    description: 'Canonical message types, session store, message bus, logger, clock.',
    internal: ['protocol'],
    deps: { pino: '^9.5.0', zod: '^4.0.0' },
  },
  security: {
    description: 'Credential vault, workspace jail, SSRF-guarded fetch, exec argv guard.',
    internal: ['protocol', 'core'],
    deps: { undici: '^7.2.0' },
  },
  providers: {
    description: 'LLM provider registry, wire adapters, and resilience decorator.',
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
  },
  agent: {
    description: 'The agent loop, subagent manager, and context contributors.',
    internal: ['protocol', 'core', 'security', 'providers', 'tools'],
    // Tests only — the tests here define tools with `defineTool`. Nothing in
    // this package's runtime graph imports zod.
    devDeps: { zod: '^4.0.0' },
  },
  runtime: {
    description: 'The shared composition root: config in, a running agent out.',
    internal: ['protocol', 'core', 'security', 'providers', 'tools', 'agent'],
    // Tests only — one test registers a tool with `defineTool` to prove a
    // reconfigure does not drop it. Nothing in the runtime graph imports zod.
    devDeps: { zod: '^4.0.0' },
  },
  server: {
    description: 'Fastify app, boot policy, authentication, and the session hub.',
    // `agent` is a dependency of the *transport*, never the other way round: the
    // hub drives `AgentLoop.run()` and forwards its events, and the loop has no
    // idea a socket exists. The layering lint rule and pnpm's isolated
    // node_modules together keep that arrow pointing one way.
    internal: ['protocol', 'core', 'security', 'agent'],
    // `zod` is a runtime dependency here, unlike in `agent` and `runtime`: the
    // route helper calls `z.toJSONSchema` to generate the OpenAPI document and
    // `safeParse` to validate every request body.
    deps: {
      '@fastify/cookie': '^11.0.0',
      '@fastify/rate-limit': '^10.2.0',
      '@fastify/swagger': '^9.4.0',
      '@node-rs/argon2': '^2.0.0',
      fastify: '^5.2.0',
      zod: '^4.0.0',
    },
  },
  cli: {
    description: 'GhostAI command line interface.',
    internal: ['protocol', 'core', 'security', 'providers', 'tools', 'agent', 'runtime'],
    deps: { commander: '^13.0.0', picocolors: '^1.1.0' },
    bin: { ghost: './dist/index.js' },
  },
};

for (const [name, cfg] of Object.entries(PACKAGES)) {
  const dir = join(ROOT, 'packages', name);
  mkdirSync(join(dir, 'src'), { recursive: true });

  const dependencies = { ...(cfg.deps ?? {}) };
  for (const dep of cfg.internal ?? []) dependencies[`@ghostai/${dep}`] = 'workspace:*';

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
    references: (cfg.internal ?? []).map((dep) => ({ path: `../${dep}` })),
  };

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
  console.log(`generated packages/${name}`);
}
