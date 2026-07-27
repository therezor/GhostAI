import { defineConfig } from 'vitest/config';

/**
 * Deliberately not `vite.config.ts`: nothing here needs the React or Tailwind
 * plugins, and loading them would put a CSS compile in front of a test that
 * reads `tokens.css` as text.
 *
 * `node` is the default environment because most of these tests are file
 * readers — the token gates, the contrast assertion, the pre-paint script. The
 * two that need a DOM ask for one with a `@vitest-environment jsdom` docblock.
 */
export default defineConfig({
  test: {
    name: 'web',
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
