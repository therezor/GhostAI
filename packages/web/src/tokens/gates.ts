/**
 * The three token gates.
 *
 * They exist because a design system does not fail loudly. Nobody notices the
 * one `#1a1a1a` that stopped following the theme, or the `13px` label that
 * refuses to grow at 200% zoom, until a user reports that half the settings
 * panel is unreadable in light mode. The gates make each of those a failing
 * test at the moment it is written:
 *
 *  1. **No `px` outside `tokens.css`.** Density comes from the type scale, and
 *     the root font size is never overridden — so a `px` literal is a piece of
 *     the UI that has opted out of the user's browser setting. The one
 *     legitimate use, a hairline border, is `--hairline` in the token sheet.
 *  2. **No raw colour outside `tokens.css`.** A hex, `rgb()`, `hsl()` or
 *     `oklch()` in a component is a colour that cannot change with the theme
 *     and was never measured for contrast.
 *  3. **No `--color-accent` in a text, icon or stroke position.** Fill uses
 *     `--color-accent`; text and strokes use `--color-accent-fg`. The two are
 *     identical in dark, so this rule is only load-bearing in light — which is
 *     to say it is invisible in the theme most of the work happens in.
 *
 * They are ordinary functions over source text rather than an ESLint rule or a
 * Stylelint plugin, because the same three rules have to hold in CSS, in TSX
 * class strings and in `index.html`, and no single linter reads all three.
 * `gates.test.ts` runs them over the whole package.
 */

/** One violation, addressed the way an editor addresses it. */
export interface Violation {
  readonly rule: GateRule;
  /** Package-relative, POSIX separators. */
  readonly file: string;
  readonly line: number;
  /** The offending text, for a message that does not require opening the file. */
  readonly match: string;
}

export type GateRule = 'no-px' | 'no-raw-color' | 'accent-position';

/** A file to check: package-relative path and its contents. */
export interface SourceFile {
  readonly file: string;
  readonly source: string;
}

/**
 * The one exempt file. It is exempt from the first two gates only — the third
 * is about *usage*, and `tokens.css` declares `--color-accent` rather than
 * using it, so nothing there needs an exemption.
 */
export const TOKEN_SHEET = 'src/styles/tokens.css';

const PX_LITERAL = /(?<![\w-])\d+(?:\.\d+)?px(?![\w-])/g;

const RAW_COLOR =
  /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})(?![0-9a-zA-Z])|\b(?:rgba?|hsla?|hwb|oklch|oklab|lab|lch|color-mix)\(/g;

/**
 * CSS properties where a colour is a stroke or a glyph rather than a fill.
 * `background-color` is deliberately absent: that is what `--color-accent` is
 * for.
 */
const STROKE_PROPERTIES = [
  'color',
  'caret-color',
  'text-decoration-color',
  'text-emphasis-color',
  '-webkit-text-fill-color',
  'fill',
  'stroke',
  'outline',
  'outline-color',
  'border',
  'border-color',
  'border-top',
  'border-right',
  'border-bottom',
  'border-left',
  'border-top-color',
  'border-right-color',
  'border-bottom-color',
  'border-left-color',
  'border-inline-color',
  'border-block-color',
  'column-rule',
  'column-rule-color',
];

/**
 * `var(--color-accent)` in a stroke declaration. The negative lookahead is what
 * lets `--color-accent-fg` — the correct token — through: it never matches
 * `--color-accent` followed by anything but a closing paren.
 */
const ACCENT_IN_CSS = new RegExp(
  String.raw`(?:^|[;{}])\s*(${STROKE_PROPERTIES.join('|')})\s*:[^;{}]*var\(\s*--color-accent\s*\)`,
  'gm',
);

/**
 * The same rule for Tailwind utilities. `text-accent` compiles to
 * `color: var(--color-accent)`, which is the mistake this exists to catch;
 * `text-accent-fg` is the one to write instead.
 */
const ACCENT_IN_UTILITY =
  /(?<![\w-])(?:text|border|ring|outline|divide|decoration|caret|fill|stroke|placeholder|accent)-accent(?![\w-])/g;

/** All three gates over one file. */
export function checkFile({ file, source }: SourceFile): readonly Violation[] {
  const out: Violation[] = [];
  const exempt = file === TOKEN_SHEET;

  if (!exempt) {
    out.push(...scan(file, source, PX_LITERAL, 'no-px'));
    out.push(...scan(file, source, RAW_COLOR, 'no-raw-color'));
  }

  out.push(...scan(file, source, ACCENT_IN_CSS, 'accent-position'));
  out.push(...scan(file, source, ACCENT_IN_UTILITY, 'accent-position'));

  return out;
}

/** All three gates over a set of files, in file then line order. */
export function checkFiles(files: readonly SourceFile[]): readonly Violation[] {
  return files.flatMap((file) => checkFile(file));
}

/** A violation as a line an editor can jump to. */
export function formatViolation({ rule, file, line, match }: Violation): string {
  return `${file}:${line.toString()}  [${rule}]  ${match.trim()}`;
}

function scan(file: string, source: string, pattern: RegExp, rule: GateRule): readonly Violation[] {
  const out: Violation[] = [];
  const regex = new RegExp(pattern.source, pattern.flags);

  let match: RegExpExecArray | null;
  while ((match = regex.exec(source)) !== null) {
    out.push({ rule, file, line: lineOf(source, match.index), match: match[0] });
    if (match[0] === '') regex.lastIndex += 1; // a zero-width match would not advance
  }

  return out;
}

function lineOf(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i += 1) if (source[i] === '\n') line += 1;
  return line;
}
