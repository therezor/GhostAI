/**
 * The design-fidelity gate.
 *
 * The brief was a screenshot diff against the product being replaced, in dark,
 * with sub-pixel deviations everywhere except four known ones. Building it
 * turned up a fifth deviation that no tolerance can absorb: the two products
 * draw their icons from different places. The reference uses a webfont's glyph
 * set; the replacement uses an inline SVG set, because a font CDN in a
 * self-hosted product leaks every user's IP and breaks an air-gapped install —
 * which is the same decision that made the offline spec possible. Every button,
 * every sidebar row and every header therefore differs at the pixel level on a
 * screen that is otherwise exactly right, and a threshold over that number
 * reports the same large figure for a correct screen and a broken one.
 *
 * So the gate is split, and each half does the job it can actually do.
 *
 *  - **This file asserts the measurements.** The shell's three dimensions, the
 *    base of the type scale, and the surface and text ramps — read off both
 *    rendered documents the same way, so neither side is being taken from a
 *    stylesheet on trust. These are what "indistinguishable at 1×" means once
 *    you stop being able to subtract two bitmaps, and they are what had
 *    actually drifted.
 *  - **`fidelity/capture.ts` writes the pictures.** Both screens and their
 *    pixel diff, into `artifacts/fidelity/`, for the review the plan also asks
 *    for. `pnpm --filter @ghostai/e2e baseline` is the command. It is not a
 *    threshold, and it does not fail a build.
 *
 * Dark only, because there is no light-mode reference: the product being
 * replaced has one theme. Light is held to the contrast assertion in
 * `@ghostai/web` and the sweep in `a11y.spec.ts`, which is the whole of what
 * can be said about a theme with nothing to compare it to.
 */

import { chromium, type Page } from '@playwright/test';

import { VIEWPORT } from '../viewport.js';
import {
  REFERENCE_LAYOUT,
  REPLACEMENT_LAYOUT,
  readMetrics,
  type Layout,
  type Metrics,
} from '../fidelity/metrics.js';
import { referenceAvailable, serveReference, DEFAULT_ORIGINAL_ROOT } from '../fidelity/original.js';
import { expect, test } from '../fixtures.js';

/**
 * How far each measurement may be from the reference, and why.
 *
 * Zero on the three dimensions *and* on the base font size: a column that is
 * sixteen pixels narrower is not a rounding difference, it is a different
 * layout, and naming those three as tokens was what stopped it happening
 * silently. All four are exact — 272, 56, 860 and 14 — which is why the
 * tolerance is zero rather than "small". A tolerance wide enough to absorb a
 * value that already matches is a tolerance that would absorb a regression too.
 *
 * The channel tolerance is the one documented deviation, stated as a number.
 * The replacement's neutral axis carries a small warm chroma — surfaces and
 * text hold a trace of the accent hue, which is what keeps a gold accent from
 * looking pasted onto a slate UI — so a grey the reference paints as (13,13,13)
 * is painted here as (12,10,8). Five of 255 on the blue channel, and nothing on
 * the perceived lightness: the muted-text luminance below lands within one.
 *
 * Everything else the ramp used to differ on is gone. The surface stops and the
 * text tiers are now the reference's own values converted to OKLCH, with one
 * exception recorded in `tokens.css`: the two lower text stops are lighter,
 * because the originals sit at 4.0:1 and 2.9:1 against the page and this sheet
 * holds every text token to AA.
 */
const TOLERANCE = {
  dimension: 0,
  fontSize: 0,
  /** sRGB, 0–255. The warm neutral axis, and nothing else. */
  channel: 6,
  /** Relative luminance, 0–255. Currently within one. */
  luminance: 3,
} as const;

async function measure(page: Page, layout: Layout): Promise<Metrics> {
  return await page.evaluate(readMetrics, layout);
}

test.describe('fidelity', () => {
  // Not `test.skip(condition)` inside the body: the reference is another
  // checkout beside this one, so its absence is the normal state of a CI
  // machine and of anyone who cloned only this repo. A suite that failed there
  // would be a suite people learn to ignore.
  test.skip(!referenceAvailable(), `no reference build at ${DEFAULT_ORIGINAL_ROOT}`);

  test('matches the product being replaced on every measurement that can be compared', async ({
    app,
  }, testInfo) => {
    // In the body rather than beside the one above: a project name is a
    // per-test fact, and the file-level form has no test to read it from.
    test.skip(testInfo.project.name !== 'dark', 'the reference has one theme');

    const reference = await serveReference();
    const browser = await chromium.launch();
    let expected: Metrics;
    try {
      const page = await browser.newPage({ colorScheme: 'dark', viewport: VIEWPORT });
      await page.goto(reference.url);
      expected = await measure(page, REFERENCE_LAYOUT);
    } finally {
      await browser.close();
      await reference.close();
    }

    // The chat measure is on the composer, which is the one element both
    // products size to the same rule — the transcript's column follows it.
    const actual = await measure(app, REPLACEMENT_LAYOUT);

    for (const [name, mine, theirs] of [
      ['sidebar width', actual.sidebarWidth, expected.sidebarWidth],
      ['header height', actual.headerHeight, expected.headerHeight],
      ['chat measure', actual.chatWidth, expected.chatWidth],
    ] as const) {
      expect.soft(Math.abs(mine - theirs), name).toBeLessThanOrEqual(TOLERANCE.dimension);
    }
    expect
      .soft(Math.abs(actual.baseFontSize - expected.baseFontSize), 'base font size')
      .toBeLessThanOrEqual(TOLERANCE.fontSize);

    for (const [name, mine, theirs] of [
      ['the page surface', actual.surface0, expected.surface0],
      ['the raised surface', actual.surface1, expected.surface1],
      ['body text', actual.foreground, expected.foreground],
    ] as const) {
      const worst = Math.max(...mine.map((value, index) => Math.abs(value - (theirs[index] ?? 0))));
      expect.soft(worst, `${name}: worst channel`).toBeLessThanOrEqual(TOLERANCE.channel);
    }

    expect
      .soft(Math.abs(actual.foregroundMuted - expected.foregroundMuted), 'muted text')
      .toBeLessThanOrEqual(TOLERANCE.luminance);
  });
});
