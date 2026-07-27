import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/testkit/index.ts'],
  format: ['esm'],
  target: 'node22',
  // tsc -b writes its declarations and .tsbuildinfo into this same dist, so
  // cleaning here would delete them and leave tsc believing they still exist.
  // Removing dist by hand is what forces a full rebuild of both tools.
  clean: false,
  dts: false, // tsc -b emits declarations; rollup-plugin-dts is the slow path
  sourcemap: true,
  // tsup bundles anything it can resolve that is not a declared dependency, and
  // a test framework resolvable from the workspace root is exactly that: without
  // this, half a megabyte of vitest ends up inside dist/.
  external: ['vitest'],
  // tsup rewrites `node:sqlite` to `sqlite` otherwise — a compatibility shim for
  // node versions older than 14.18 that turns a builtin into a missing package.
  // `node:sqlite` has no unprefixed form at all, so the rewrite is unloadable.
  // The default flips to false in tsup 9; this is only saying so early.
  removeNodeProtocol: false,
});
