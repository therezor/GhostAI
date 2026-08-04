import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'tui',
    include: ['test/**/*.test.ts'],
  },
});
