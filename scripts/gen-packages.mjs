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

/** @type {Record<string, { description: string; deps?: Record<string,string>; internal?: string[]; bin?: Record<string,string> }>} */
const PACKAGES = {
  protocol: {
    description: 'Zod schemas and derived types shared by every GhostAI package.',
    deps: { zod: '^4.0.0' },
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
    deps: { 'gpt-tokenizer': '^2.8.0' },
  },
  tools: {
    description: 'Tool definition helper, registry, and built-in tools.',
    internal: ['protocol', 'core', 'security'],
    deps: { zod: '^4.0.0' },
  },
  agent: {
    description: 'The agent loop, subagent manager, and context contributors.',
    internal: ['protocol', 'core', 'security', 'providers', 'tools'],
  },
  cli: {
    description: 'GhostAI command line interface.',
    internal: ['protocol', 'core', 'security', 'providers', 'tools', 'agent'],
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
    license: 'Apache-2.0',
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
      build: 'tsup',
      typecheck: 'tsc -b',
      test: 'vitest run',
      lint: 'eslint src',
    },
    dependencies: Object.keys(dependencies).length
      ? Object.fromEntries(Object.entries(dependencies).sort())
      : undefined,
  };

  const tsconfig = {
    extends: '../../tsconfig.base.json',
    compilerOptions: {
      rootDir: './src',
      outDir: './dist',
      tsBuildInfoFile: './dist/.tsbuildinfo',
    },
    include: ['src/**/*'],
    references: (cfg.internal ?? []).map((dep) => ({ path: `../${dep}` })),
  };

  const tsup = `import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node22',
  clean: true,
  dts: false, // tsc -b emits declarations; rollup-plugin-dts is the slow path
  sourcemap: true,
});
`;

  await writeFormatted(join(dir, 'package.json'), JSON.stringify(pkg, null, 2));
  await writeFormatted(join(dir, 'tsconfig.json'), JSON.stringify(tsconfig, null, 2));
  await writeFormatted(join(dir, 'tsup.config.ts'), tsup);
  console.log(`generated packages/${name}`);
}
