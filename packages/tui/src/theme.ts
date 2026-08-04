/**
 * Colour, as six named roles rather than six colour names.
 *
 * The CLI has had the shape of this all along — `render.ts` declares
 * `type Palette = ReturnType<typeof pc.createColors>` and takes `colors` as an
 * injected boolean so that `pc.createColors(false)` hands back the same
 * interface with identity formatters. That is what lets a test assert on text
 * instead of on escape sequences, and it is why `--no-color` is one flag rather
 * than a branch at every call site. This generalises it and nothing more.
 *
 * The one rule worth stating out loud: **colour is never the only signal.** A
 * selected row is marked by a leading glyph, and `theme.cursor` only makes the
 * mark easier to find. Under `NO_COLOR` every formatter here is the identity
 * function, and a menu whose selection was indicated by colour alone would
 * become unusable rather than merely plainer — which is also what makes
 * `PLAIN_THEME` a meaningful thing to test against.
 */

import pc from 'picocolors';

export type Style = (text: string) => string;
export type Palette = ReturnType<typeof pc.createColors>;

export interface Theme {
  /** An ordinary row. */
  readonly text: Style;
  /** Secondary information: hints, counts, the footer. */
  readonly dim: Style;
  /** The row the cursor is on. */
  readonly cursor: Style;
  /** The span of a label the filter matched. */
  readonly match: Style;
  /** A heading. */
  readonly title: Style;
  /** Something the operator should notice. */
  readonly warn: Style;
}

const identity: Style = (text) => text;

/** Every role is the identity function. What a pipe and every test get. */
export const PLAIN_THEME: Theme = {
  text: identity,
  dim: identity,
  cursor: identity,
  match: identity,
  title: identity,
  warn: identity,
};

/**
 * The roles, over a palette.
 *
 * `cursor` is cyan rather than an inverse video block: inverse spans the padded
 * column width, so a row's highlight would be as wide as the longest label
 * rather than as wide as the label — which reads as a ragged rectangle. The
 * glyph carries the position; the colour only has to draw the eye to it.
 */
export function themeFrom(palette: Palette): Theme {
  return {
    text: palette.reset,
    dim: palette.dim,
    cursor: palette.cyan,
    match: palette.yellow,
    title: palette.bold,
    warn: palette.yellow,
  };
}

/**
 * The roles for a given colour decision.
 *
 * `undefined` keeps picocolors' own detection, which already honours `NO_COLOR`,
 * `FORCE_COLOR` and whether the stream is a TTY — so a caller that has no
 * opinion should pass nothing rather than guess.
 */
export function themeFor(colors: boolean | undefined): Theme {
  return themeFrom(pc.createColors(colors));
}
