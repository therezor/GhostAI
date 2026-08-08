import { defineConfig } from 'tsup';

/**
 * Unlike every package here, this one is built to be *installed*.
 *
 * `tsc -b` alone emits declarations — the base config sets
 * `emitDeclarationOnly` — which is all `examples/loopback-channel` needs,
 * because its only consumer is vitest and vitest reads TypeScript. An extension
 * is different: its manifest names `dist/index.js` and the host imports that
 * file, so something has to produce it.
 *
 * Bundled, and that is the shape every extension should ship. The approval
 * digest walks the whole install directory, and the file-count cap that keeps
 * that walk bounded is what makes shipping an unbundled dependency tree fail
 * loudly instead of slowly. `zod` is bundled in for the same reason: an
 * extension directory is not an npm project, and nothing resolves a bare
 * specifier from it at load time.
 */
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node22',
  noExternal: [/.*/],
  clean: false,
  dts: false,
  sourcemap: false,
  // Not optional, and the reason every package here sets it: tsup rewrites
  // `node:sqlite` to `sqlite`, a compatibility shim for node versions older
  // than 14.18 that turns a builtin into a missing package. `node:sqlite` has
  // no unprefixed form, so the rewrite is unloadable — and the failure lands at
  // `import()` time, which for an extension means a `failed` row after the
  // operator has already approved it.
  removeNodeProtocol: false,
  // The other half of bundling into ESM, and the one that is not obvious until
  // it fails at `import()` time. Reaching `defineTool` pulls in
  // `@ghostbot/core`, which pulls in `pino`, which is CommonJS and calls
  // `require('node:os')` at module scope. An ESM bundle has no `require`, so
  // esbuild emits a stub that throws "Dynamic require of ... is not supported".
  // This gives it a real one.
  banner: {
    js: [
      "import { createRequire as __ghostaiCreateRequire } from 'node:module';",
      'const require = __ghostaiCreateRequire(import.meta.url);',
    ].join('\n'),
  },
});
