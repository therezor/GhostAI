/**
 * How wide a string is on a terminal, and how to cut one to fit.
 *
 * `String.length` is code units, which is wrong three separate ways for
 * anything a menu draws: an ANSI escape occupies several units and no columns,
 * a CJK label occupies one unit per two columns, and an emoji occupies two or
 * four units for two columns. The CLI's existing `clip()` counts code units and
 * gets away with it because it only ever trims prose that is about to be printed
 * on a line of its own.
 *
 * A menu cannot get away with it. Every erase in `screen.ts` is "move the cursor
 * up N lines", and a line that *wraps* because it was one column too wide
 * occupies two rows instead of one — so the erase stops one row short and leaves
 * a fragment of the menu behind in the scrollback, permanently. Truncation to a
 * measured width is the invariant that keeps a region of N lines N rows tall,
 * which is why this module exists at all and why it is worth more than a
 * `slice`.
 *
 * The measurement is deliberately a table rather than a dependency. `wcwidth`
 * and its descendants are the classic answer; the ranges below are the same
 * data, and they are ~40 lines against a package that would be the only runtime
 * dependency this package has beyond colours.
 */

/**
 * Written as an escape, never as the byte. A literal `0x1b` in a source file is
 * invisible in an editor and makes the file unsearchable with the tools
 * everyone reaches for first.
 */
const ESC = '\u001b';
const BEL = '\u0007';

/**
 * CSI sequences (colour, cursor movement), OSC strings (window title,
 * hyperlinks) and the two-byte forms.
 *
 * Built with `new RegExp` rather than written as a literal so the escape byte
 * enters through a named constant. Kept private: it carries the `g` flag, and a
 * shared global regex has a mutable `lastIndex` that turns `.test()` into a
 * coin flip on alternate calls.
 */
const ANSI_PATTERN = new RegExp(
  [
    // CSI: colour, cursor movement, erase — anything `ESC [ … final`.
    `${ESC}\\[[\\d;:?]*[ -/]*[@-~]`,
    // OSC: a window title or a hyperlink, terminated by BEL or by ST.
    `${ESC}\\][^${ESC}${BEL}]*(?:${BEL}|${ESC}\\\\)`,
    // Fe: the two-byte forms, `ESC D` through `ESC _`.
    `${ESC}[@-Z\\\\-_]`,
    // Fp: the private two-byte forms, which is where DECSC and DECRC live —
    // `ESC 7` and `ESC 8`, the save and restore the status bar is built on.
    // Without this they measure as one visible column each, and every width
    // computed over a line carrying them comes out two too wide.
    `${ESC}[0-?]`,
  ].join('|'),
  'gu',
);

const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** Marks and formats that render on top of, or between, other characters. */
const ZERO_WIDTH = /^[\p{Mn}\p{Me}\p{Cf}]/u;

/** U+FE0F, which forces emoji presentation onto a character that has both. */
const EMOJI_PRESENTATION = String.fromCharCode(0xfe0f);

/**
 * Code points that occupy two columns.
 *
 * Two populations, and they are here together because a terminal treats them
 * identically. The first is East Asian Wide and Fullwidth — Unicode gives them a
 * property, but JavaScript's `\p{…}` escapes cover only binary properties,
 * general categories and scripts, so `East_Asian_Width=Wide` is not expressible
 * and the ranges have to be written out. The second is the emoji whose *default*
 * presentation is emoji even without U+FE0F, which is likewise not a property
 * JavaScript exposes.
 */
const WIDE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f], // Hangul Jamo, initial consonants
  [0x231a, 0x231b], // ⌚⌛
  [0x23e9, 0x23ec],
  [0x23f0, 0x23f0],
  [0x23f3, 0x23f3],
  [0x25fd, 0x25fe],
  [0x2614, 0x2615],
  [0x2648, 0x2653], // the zodiac
  [0x267f, 0x267f],
  [0x2693, 0x2693],
  [0x26a1, 0x26a1],
  [0x26aa, 0x26ab],
  [0x26bd, 0x26be],
  [0x26c4, 0x26c5],
  [0x26ce, 0x26ce],
  [0x26d4, 0x26d4],
  [0x26ea, 0x26ea],
  [0x26f2, 0x26f3],
  [0x26f5, 0x26f5],
  [0x26fa, 0x26fa],
  [0x26fd, 0x26fd],
  [0x2705, 0x2705], // ✅
  [0x270a, 0x270b],
  [0x2728, 0x2728], // ✨
  [0x274c, 0x274c], // ❌
  [0x274e, 0x274e],
  [0x2753, 0x2755],
  [0x2757, 0x2757],
  [0x2795, 0x2797],
  [0x27b0, 0x27b0],
  [0x27bf, 0x27bf],
  [0x2b1b, 0x2b1c],
  [0x2b50, 0x2b50], // ⭐
  [0x2b55, 0x2b55],
  [0x2e80, 0x303e], // CJK radicals through CJK symbols
  [0x3041, 0x33ff], // kana, Hangul compatibility jamo, CJK compatibility
  [0x3400, 0x4dbf], // CJK unified ideographs extension A
  [0x4e00, 0x9fff], // CJK unified ideographs
  [0xa000, 0xa4cf], // Yi
  [0xa960, 0xa97f], // Hangul jamo extended-A
  [0xac00, 0xd7a3], // Hangul syllables
  [0xf900, 0xfaff], // CJK compatibility ideographs
  [0xfe10, 0xfe19], // vertical forms
  [0xfe30, 0xfe6f], // CJK compatibility forms, small form variants
  [0xff00, 0xff60], // fullwidth forms
  [0xffe0, 0xffe6], // fullwidth signs
  [0x1b000, 0x1b001],
  [0x1f200, 0x1f251],
  [0x1f300, 0x1f64f], // the bulk of emoji
  [0x1f680, 0x1f6ff],
  [0x1f900, 0x1f9ff],
  [0x1fa70, 0x1faff],
  [0x20000, 0x3fffd], // CJK unified ideographs extensions B onward
];

function isWide(point: number): boolean {
  for (const [start, end] of WIDE_RANGES) {
    if (point < start) return false;
    if (point <= end) return true;
  }
  return false;
}

/** One grapheme cluster's columns: 0, 1 or 2. */
function clusterWidth(cluster: string): number {
  // The variation selector wins outright: it is the whole reason a character
  // that would otherwise be one column is drawn as an emoji.
  if (cluster.includes(EMOJI_PRESENTATION)) return 2;
  if (ZERO_WIDTH.test(cluster)) return 0;
  return isWide(cluster.codePointAt(0) ?? 0) ? 2 : 1;
}

interface Segment {
  /** An escape sequence, which costs no columns and must survive a cut. */
  readonly ansi: boolean;
  readonly text: string;
}

/**
 * A string split into escape sequences and the runs of text between them.
 *
 * Segmenting the raw string into graphemes would be wrong: `\x1b[31m` is not
 * five characters the user can see, and the segmenter has no way to know that.
 */
function segments(text: string): readonly Segment[] {
  const out: Segment[] = [];
  let at = 0;

  for (const match of text.matchAll(ANSI_PATTERN)) {
    const start = match.index;
    if (start > at) out.push({ ansi: false, text: text.slice(at, start) });
    out.push({ ansi: true, text: match[0] });
    at = start + match[0].length;
  }
  if (at < text.length) out.push({ ansi: false, text: text.slice(at) });

  return out;
}

/** The text with every escape sequence removed. */
export function stripAnsi(text: string): string {
  return text.replaceAll(ANSI_PATTERN, '');
}

/** How many terminal columns the string occupies. */
export function visibleWidth(text: string): number {
  let width = 0;
  for (const segment of segments(text)) {
    if (segment.ansi) continue;
    for (const { segment: cluster } of GRAPHEMES.segment(segment.text)) {
      width += clusterWidth(cluster);
    }
  }
  return width;
}

/** `\x1b[0m` — closes every SGR attribute at once. */
const RESET = `${ESC}[0m`;

/** Whether a sequence turns styling on rather than off. */
function opensStyle(sequence: string): boolean {
  if (!sequence.startsWith(`${ESC}[`) || !sequence.endsWith('m')) return false;
  const parameters = sequence.slice(2, -1);
  return parameters !== '' && parameters !== '0';
}

/**
 * The string cut to at most `max` columns, ellipsis included in the budget.
 *
 * Two things this does that a `slice` cannot. Escape sequences are copied
 * through at no cost, so a cut never lands in the middle of one and prints
 * `[31` as text. And if the cut happens while an SGR attribute is open, a reset
 * is appended — otherwise the colour of the truncated row bleeds down the rest
 * of the menu and out into the transcript below it.
 */
export function truncateToWidth(
  text: string,
  max: number,
  ellipsis: string = '…',
): string {
  if (max <= 0) return '';
  if (visibleWidth(text) <= max) return text;

  // The ellipsis has to fit as well, or the result is one column over budget —
  // which is exactly the wrap that breaks the erase arithmetic.
  const mark = visibleWidth(ellipsis) <= max ? ellipsis : '';
  const budget = max - visibleWidth(mark);

  let out = '';
  let width = 0;
  let styled = false;

  for (const segment of segments(text)) {
    if (segment.ansi) {
      out += segment.text;
      styled = opensStyle(segment.text);
      continue;
    }
    for (const { segment: cluster } of GRAPHEMES.segment(segment.text)) {
      const cost = clusterWidth(cluster);
      if (width + cost > budget) {
        return `${out}${mark}${styled ? RESET : ''}`;
      }
      out += cluster;
      width += cost;
    }
  }

  return `${out}${mark}${styled ? RESET : ''}`;
}

/** The string padded with spaces to `width` columns. Never truncates. */
export function padToWidth(text: string, width: number): string {
  const short = width - visibleWidth(text);
  return short > 0 ? text + ' '.repeat(short) : text;
}

/** Exactly `width` columns: truncated if long, padded if short. */
export function fitToWidth(text: string, width: number): string {
  return padToWidth(truncateToWidth(text, width), width);
}

/**
 * Two strings on one line, pushed to opposite ends.
 *
 * The layout a status row wants, and the reason it lives here rather than in a
 * caller: the gap has to be measured in *columns*, so a right-hand side
 * containing colour, a CJK label or an ellipsis lands in the right place. A
 * `padEnd` would count code units and put it somewhere else.
 *
 * When the two cannot both fit, the right-hand side wins whole and the left is
 * truncated to what is left. A status bar's right end is the model and the
 * context budget; those are the fields that change, and a bar that dropped them
 * to keep a workspace name would be showing the part nobody is watching.
 */
export function justify(left: string, right: string, width: number): string {
  if (width <= 0) return '';

  const rightWidth = visibleWidth(right);
  if (rightWidth >= width) return truncateToWidth(right, width);

  // One column of breathing space, so the two never touch.
  const room = width - rightWidth - 1;
  const cut = truncateToWidth(left, room);
  const gap = width - visibleWidth(cut) - rightWidth;
  return `${cut}${' '.repeat(Math.max(1, gap))}${right}`;
}

/** A horizontal rule exactly `width` columns wide. */
export function rule(width: number, char: string = '\u2500'): string {
  return width <= 0 ? '' : char.repeat(width);
}

/**
 * The text with its last grapheme cluster removed. What Backspace should do.
 *
 * `text.slice(0, -1)` takes a UTF-16 code unit, which cuts an emoji in half;
 * spreading takes a code point, which strips one component of a family and
 * leaves the rest. A person pressing Backspace means "the thing I can see", and
 * that is a cluster — the same unit `visibleWidth` measures in.
 */
export function dropLastGrapheme(text: string): string {
  let last = 0;
  for (const { index } of GRAPHEMES.segment(text)) last = index;
  return text.slice(0, last);
}
