import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'agent',
    include: ['src/**/*.test.ts'],
  },
});
