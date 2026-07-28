import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

/**
 * Deliberately not `vite.config.ts`: nothing here needs the React
 * plugins, and loading them would put a CSS compile in front of a test that
 * reads `tokens.css` as text. The `@/` alias is duplicated from there for the
 * same reason — it is resolution, not bundling, and both configs need it.
 *
 * `jsdom` everywhere rather than per file. The token gates and the contrast
 * assertion are file readers that do not need a DOM, but they still run on
 * node, so a jsdom environment costs them a few hundred milliseconds and buys
 * one rule instead of a docblock on two thirds of the suite — and a component
 * test that forgot the docblock fails with `document is not defined`, which
 * reads like a bug in the component.
 */
export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: {
    name: 'web',
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['./src/test/setup.ts'],
  },
});
