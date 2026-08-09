/**
 * A terminal toolkit that has never heard of an agent.
 *
 * This package knows four things: how to turn bytes from a terminal into keys,
 * how wide a string is when a terminal draws it, how to hold a line somebody is
 * typing, and how to keep a frame of rows on screen and correct. It knows
 * nothing about sessions, models, configuration or translation — every string
 * that reaches it is prose the caller has already translated, which is why
 * `SelectItem.label` is a `string` and not a key.
 *
 * That boundary is not a convention. `package.json` here declares no
 * `@ghostwire/*` dependency at all, so an import of one does not resolve: the
 * layering is a fact about the package graph rather than a rule a reviewer has
 * to remember.
 *
 * The shape is `@earendil-works/pi`'s: components render rows for a width, and
 * one renderer owns the whole frame and redraws it whole when the window
 * changes size. `renderer.ts` says why that last part is the only thing that
 * works.
 */

export { isCtrl, parseKey, parseKeys } from './keys.js';
export type { Key, KeyName } from './keys.js';

export {
  dropLastGrapheme,
  fitToWidth,
  justify,
  nextBoundary,
  padToWidth,
  previousBoundary,
  rule,
  stripAnsi,
  truncateStartToWidth,
  truncateToWidth,
  visibleWidth,
  wrapToWidth,
} from './text.js';

export { CURSOR_MARKER } from './component.js';
export type { Component } from './component.js';

export { createRenderer } from './renderer.js';
export type { RendererOptions } from './renderer.js';

export { createEditor } from './editor.js';
export type { Editor } from './editor.js';

export { createTranscript } from './transcript.js';
export type { Transcript } from './transcript.js';

export { PLAIN_THEME, themeFor, themeFrom } from './theme.js';
export type { Palette, Style, Theme } from './theme.js';

export { SelectList } from './select-list.js';
export type { SelectItem } from './select-list.js';

export {
  SPINNER_FRAMES,
  SPINNER_INTERVAL_MS,
  spinnerFrame,
} from './spinner.js';

export { columnsOf, openKeyboard, rowsOf } from './terminal.js';
export type { TerminalInput, TerminalOutput } from './terminal.js';

export { CHROME_ROWS, DEFAULT_MAX_ROWS, createSelect } from './select.js';
export type { Select, SelectLabels } from './select.js';
