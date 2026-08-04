/**
 * A terminal toolkit that has never heard of an agent.
 *
 * This package knows three things: how to turn bytes from a terminal into keys,
 * how wide a string is when a terminal draws it, and how to keep a block of
 * lines repainting in place without disturbing the scrollback above it. It knows
 * nothing about sessions, models, configuration or translation — every string
 * that reaches it is prose the caller has already translated, which is why
 * `SelectItem.label` is a `string` and not a key.
 *
 * That boundary is not a convention. `package.json` here declares no
 * `@ghostai/*` dependency at all, so an import of one does not resolve: the
 * layering is a fact about the package graph rather than a rule a reviewer has
 * to remember. The counterpart lives in `packages/cli/src/menu.ts`, which is the
 * only file in the CLI that knows both this package and `node:readline`.
 */

export { isCtrl, parseKey, parseKeys } from './keys.js';
export type { Key, KeyName } from './keys.js';

export {
  fitToWidth,
  justify,
  padToWidth,
  rule,
  stripAnsi,
  truncateToWidth,
  visibleWidth,
} from './text.js';

export { PLAIN_THEME, themeFor, themeFrom } from './theme.js';
export type { Palette, Style, Theme } from './theme.js';

export { SelectList } from './select-list.js';
export type { SelectItem, SelectListOptions } from './select-list.js';

export { openBottomBar } from './bottom-bar.js';
export type { BottomBar, BottomBarOptions } from './bottom-bar.js';

export { columnsOf, openScreen, rowsOf } from './screen.js';
export type {
  InputHandover,
  Screen,
  ScreenOptions,
  TerminalInput,
  TerminalOutput,
} from './screen.js';

export { select } from './select.js';
export type { SelectLabels, SelectOptions } from './select.js';
