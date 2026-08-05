/**
 * What the agent wrote, as Telegram will accept it.
 *
 * Two problems, and they pull in opposite directions. Telegram's MarkdownV2 is
 * not Markdown: eighteen characters are reserved *everywhere*, so an unescaped
 * `.` or `-` — a full stop, a bullet — is a `can't parse entities` 400 that
 * loses the whole message. And a message is capped at 4096 characters, which a
 * `read_file` answer passes without trying.
 *
 * The shape here is a deliberate middle. A full Markdown→MarkdownV2 translation
 * would be a parser, and every gap in it is a lost message; escaping everything
 * is safe but turns the model's code blocks into a wall of backslashes, and
 * code is most of what an agent says worth reading. So the text is split into
 * three kinds of segment — fenced block, inline code, prose — and each is
 * treated as its own thing. Bold and italic survive because they are cheap to
 * recognise; the rest of Markdown renders literally, which is honest rather
 * than broken.
 *
 * The safety net is in the channel, not here: a send that Telegram rejects is
 * retried once with no `parse_mode` at all. That is what makes a bug in this
 * file cost formatting rather than the message, and it is why this can stay
 * small instead of growing a case for every construct.
 */

/** Telegram's own ceiling for one message's text. */
export const MAX_MESSAGE_CHARS = 4096;

/**
 * Reserved in MarkdownV2 outside code, all eighteen of them.
 *
 * From the Bot API docs verbatim. `\` is not in the list and is handled by the
 * replacement itself, since it is what does the escaping.
 */
const RESERVED = /[_*[\]()~`>#+\-=|{}.!\\]/gu;

/** Inside a code span or block, only these two carry meaning. */
const RESERVED_IN_CODE = /[`\\]/gu;

/** One piece of the message, and how it wants to be treated. */
interface Segment {
  readonly kind: 'fence' | 'code' | 'prose';
  readonly text: string;
  /** The info string of a fenced block — `ts` in ```` ```ts ````. */
  readonly language?: string;
}

/** Escapes every reserved character. Safe for anything, ugly for code. */
export function escapeMarkdownV2(text: string): string {
  return text.replace(RESERVED, (character) => `\\${character}`);
}

/**
 * Splits into fenced blocks, inline code and everything else.
 *
 * One pass, no lookbehind, and unterminated markers are prose: a model that
 * opens a fence and stops mid-sentence — which a truncated turn does — must
 * still produce a message rather than a parse error.
 */
function segments(text: string): readonly Segment[] {
  const found: Segment[] = [];
  const pattern = /```([^\n`]*)\n?([\s\S]*?)```|`([^`\n]+)`/gu;
  let index = 0;

  for (const match of text.matchAll(pattern)) {
    const at = match.index;
    if (at > index) {
      found.push({ kind: 'prose', text: text.slice(index, at) });
    }
    const [whole, language, block, inline] = match;
    if (inline === undefined) {
      found.push({
        kind: 'fence',
        text: block ?? '',
        ...(language === undefined || language.trim() === ''
          ? {}
          : { language: language.trim() }),
      });
    } else {
      found.push({ kind: 'code', text: inline });
    }
    index = at + whole.length;
  }

  if (index < text.length) {
    found.push({ kind: 'prose', text: text.slice(index) });
  }
  return found;
}

/**
 * Bold and italic, and nothing else.
 *
 * MarkdownV2 spells bold `*x*` and italic `_x_`, so `**x**` has to be rewritten
 * rather than passed through. Both run *before* escaping and put their markers
 * back afterwards through a placeholder no input can contain — doing it the
 * other way round would escape the markers we are trying to keep.
 *
 * Deliberately not a parser. A stray `**` with no partner is left alone and
 * escaped like any other asterisk, which is what makes this safe on a
 * half-finished sentence.
 */
const BOLD = /\*\*([^\n*]+)\*\*/gu;
const ITALIC = /(?<![\w\\])_([^\n_]+)_(?!\w)/gu;
/**
 * Placeholders, written as escapes rather than as literal bytes.
 *
 * Control characters, because they are the one thing a Telegram message
 * cannot contain, so no input can collide with them. Written as `\u0000`
 * rather than typed, because a raw control byte in a source file is invisible
 * to `grep` and to most editors that will ever open this.
 */
const BOLD_MARK = '\u0000';
const ITALIC_MARK = '\u0001';

function prose(text: string): string {
  const marked = text
    .replace(BOLD, (match, inner: string) => `${BOLD_MARK}${inner}${BOLD_MARK}`)
    .replace(
      ITALIC,
      (match, inner: string) => `${ITALIC_MARK}${inner}${ITALIC_MARK}`,
    );
  return escapeMarkdownV2(marked)
    .replaceAll(BOLD_MARK, '*')
    .replaceAll(ITALIC_MARK, '_');
}

/** The whole message, ready for `parse_mode: 'MarkdownV2'`. */
export function toMarkdownV2(text: string): string {
  return segments(text)
    .map((segment) => {
      if (segment.kind === 'prose') return prose(segment.text);
      const body = segment.text.replace(
        RESERVED_IN_CODE,
        (character) => `\\${character}`,
      );
      if (segment.kind === 'code') return `\`${body}\``;
      const language =
        segment.language === undefined
          ? ''
          : escapeMarkdownV2(segment.language);
      return `\`\`\`${language}\n${body}\`\`\``;
    })
    .join('');
}

/** Whether a line opens or closes a fenced block. */
function fenceDelta(line: string): number {
  return (line.match(/```/gu) ?? []).length;
}

/**
 * Hard-splits one over-long line without cutting an escape in half.
 *
 * A `\` is only ever the first half of a two-character escape here, so a chunk
 * that ended on one would send a dangling backslash and leave the character it
 * was protecting unescaped at the head of the next.
 */
function splitLine(line: string, limit: number): string[] {
  const parts: string[] = [];
  let rest = line;
  while (rest.length > limit) {
    let cut = limit;
    if (rest[cut - 1] === '\\') cut -= 1;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest !== '') parts.push(rest);
  return parts;
}

/**
 * One formatted message, cut into sendable pieces.
 *
 * Cuts on line boundaries, because that is the one place a MarkdownV2 escape
 * cannot straddle. A fenced block that spans a cut is **closed and reopened**,
 * so each piece is valid on its own — without that, piece one is an unclosed
 * fence Telegram rejects and piece two is code rendered as prose.
 *
 * Returns `['']` for empty input rather than `[]`: the caller is sending a
 * message, and an empty list would silently send nothing.
 */
export function chunkMessage(
  text: string,
  limit: number = MAX_MESSAGE_CHARS,
): readonly string[] {
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let current = '';
  let openFence = false;
  /** Reopening costs four characters, so a chunk inside a fence gets less. */
  const room = (): number => limit - (openFence ? 4 : 0);

  const flush = (): void => {
    if (current === '') return;
    chunks.push(openFence ? `${current}\n\`\`\`` : current);
    current = '';
  };

  for (const line of text.split('\n')) {
    for (const piece of splitLine(line, room() - 1)) {
      const separator = current === '' ? '' : '\n';
      if (current.length + separator.length + piece.length > room()) {
        const wasOpen = openFence;
        flush();
        current = wasOpen ? '```' : '';
      }
      current += (current === '' ? '' : '\n') + piece;
    }
    // After the line lands, not before: a chunk that ends *on* the opening
    // fence must still be closed, and one that ends on the closing fence must
    // not be reopened.
    if (fenceDelta(line) % 2 === 1) openFence = !openFence;
  }

  flush();
  return chunks.length === 0 ? [''] : chunks;
}
