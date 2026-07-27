import { defineConfig } from 'vitest/config';

/**
 * Per-package coverage gates. `security` carries the strictest bar: the SSRF
 * guard, exec argv guard, workspace jail and tool-output nonce wrapping are
 * the code where an untested branch is a vulnerability, not just a bug.
 */
const THRESHOLDS: Record<string, { lines: number; branches: number }> = {
  security: { lines: 95, branches: 95 },
  core: { lines: 90, branches: 85 },
  agent: { lines: 85, branches: 80 },
  runtime: { lines: 85, branches: 80 },
  providers: { lines: 80, branches: 75 },
  tools: { lines: 80, branches: 75 },
  mcp: { lines: 80, branches: 75 },
};

const DEFAULT_THRESHOLD = { lines: 70, branches: 65 };

export default defineConfig({
  test: {
    projects: ['packages/*'],
    passWithNoTests: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html'],
      include: ['packages/*/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/index.ts', '**/*.d.ts'],
      thresholds: Object.fromEntries(
        Object.entries(THRESHOLDS).map(([pkg, t]) => [
          `packages/${pkg}/src/**`,
          { ...t, functions: t.lines, statements: t.lines },
        ]),
      ),
    },
  },
});

export { THRESHOLDS, DEFAULT_THRESHOLD };
