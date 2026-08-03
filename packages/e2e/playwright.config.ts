import { defineConfig, devices } from '@playwright/test';

import { VIEWPORT } from './src/viewport.js';

/**
 * Two projects, one suite.
 *
 * The colour scheme is a project rather than a parameter inside a handful of
 * specs, so *every* assertion runs twice — once in each theme. That is the only
 * arrangement in which "this component only works in dark" is a failing test
 * rather than something someone notices in review: a light-mode bug that lives
 * in a screen no light-mode spec happened to visit is a light-mode bug that
 * ships. Reviewing only in dark is how a light theme ships broken.
 *
 * There is no `webServer`. The harness boots the whole stack in-process, per
 * test, on a port the OS picks — see `src/harness/server.ts` for why that is
 * worth the milliseconds. A shared external server would put every spec's
 * settings saves and sessions in one another's way, and the approval matrix in
 * particular is a setting two specs want opposite answers from.
 */
export default defineConfig({
  testDir: './test',
  fullyParallel: true,
  // A `.only` left in a spec silently reduces CI to that one test.
  forbidOnly: process.env['CI'] === 'true',
  retries: process.env['CI'] === 'true' ? 1 : 0,
  reporter: process.env['CI'] === 'true' ? [['github'], ['list']] : [['list']],
  outputDir: './artifacts/output',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  use: {
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    // Every locator in this suite matches on English text, and the browser's
    // `Accept-Language` is what the pre-paint script resolves from when nobody
    // has chosen yet. Left to the runner, the suite would pass on CI and fail on
    // a laptop set to German — so it is pinned here rather than discovered.
    // Both projects inherit it; a per-project `use` merges over this one.
    locale: 'en-US',
  },
  projects: [
    // The viewport is set *after* the device spread in each project, not once
    // at the top: `devices['Desktop Chrome']` carries a viewport of its own,
    // and a top-level `use.viewport` loses to it. The size matters — the shell
    // has a breakpoint at `md`, and one that straddled it would make "is the
    // sidebar inline or in a drawer" depend on the runner's defaults.
    {
      name: 'dark',
      use: { ...devices['Desktop Chrome'], colorScheme: 'dark', viewport: VIEWPORT },
    },
    {
      name: 'light',
      use: { ...devices['Desktop Chrome'], colorScheme: 'light', viewport: VIEWPORT },
    },
  ],
});
