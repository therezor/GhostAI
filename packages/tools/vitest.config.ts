import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'tools',
    include: ['src/**/*.test.ts'],
  },
});
