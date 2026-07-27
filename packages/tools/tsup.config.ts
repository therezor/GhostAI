import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node22',
  clean: true,
  dts: false, // tsc -b emits declarations; rollup-plugin-dts is the slow path
  sourcemap: true,
});
