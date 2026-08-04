/**
 * Bytes from a terminal → keys.
 *
 * Node has `readline.emitKeypressEvents` and it is deliberately not used here:
 * it is coupled to a readline `Interface`, and the whole point of this package
 * is a menu that runs *while readline is suspended*. What is left is a decoder,
 * and three decisions shape it.
 *
 * **`parseKeys` is the primary form, not `parseKey`.** stdin does not deliver
 * one key per chunk. Holding an arrow key, or pasting, arrives as
 * `"\x1b[B\x1b[B\r"` in a single `data` event, and a decoder that returns the
 * first key silently drops the rest — which reads as "the menu skipped a row"
 * rather than as a bug in the parser.
 *
 * **Both cursor encodings are decoded.** A terminal in DECCKM (application
 * cursor keys) sends `\x1bOA` where the normal mode sends `\x1b[A`, and plenty
 * send the former by default. Handling only CSI is the single most likely cause
 * of "the arrow keys do nothing on my machine", and it costs four lines to
 * avoid.
 *
 * **A chunk is decoded whole, with no timer.** Node's own reader keeps an
 * `escapeCodeTimeout` so a sequence split across two reads can be reassembled.
 * That state machine is not worth its weight here: a terminal emits a cursor
 * sequence in one `write`, and the worst case if one is ever split is a single
 * dropped keypress in a menu the operator can reopen. A lone trailing `\x1b` is
 * Escape, which is what a user pressing Escape actually sends.
 */

/** The keys a menu can act on. Everything else decodes as `unknown`. */
export type KeyName =
  | 'char'
  | 'enter'
  | 'escape'
  | 'tab'
  | 'backspace'
  | 'delete'
  | 'up'
  | 'down'
  | 'left'
  | 'right'
  | 'home'
  | 'end'
  | 'pageUp'
  | 'pageDown'
  | 'unknown';

export interface Key {
  readonly name: KeyName;
  /**
   * The character for `name: 'char'`, empty for everything else.
   *
   * For a control byte this is the letter it was typed with — `\x03` decodes as
   * `{name: 'char', char: 'c', ctrl: true}` — so a caller matches Ctrl-C the
   * same way it matches `c`.
   */
  readonly char: string;
  readonly ctrl: boolean;
  readonly shift: boolean;
  /** Alt/Option, which a terminal sends as an `\x1b` prefix. */
  readonly meta: boolean;
  /** Exactly the bytes this key was decoded from. */
  readonly sequence: string;
}

/**
 * Written as an escape, never as the byte.
 *
 * A literal 0x1b in a source file is invisible in an editor and makes the file
 * unsearchable with the tools everyone reaches for first — a lesson this
 * repository has already learned once, with NUL.
 */
const ESC = '\u001b';

function key(name: KeyName, sequence: string, extra: Partial<Key> = {}): Key {
  return {
    name,
    char: '',
    ctrl: false,
    shift: false,
    meta: false,
    ...extra,
    sequence,
  };
}

/**
 * The `1 + bitmask` a terminal puts in a CSI sequence's second parameter.
 *
 * `\x1b[1;5A` is Ctrl-Up: `5` is `1 + 4`, and 4 is the control bit. Absent or
 * `1` means no modifier at all.
 */
function modifiers(parameter: string | undefined): Partial<Key> {
  const value = Number.parseInt(parameter ?? '', 10);
  if (!Number.isFinite(value) || value < 2) return {};
  const bits = value - 1;
  return {
    shift: (bits & 1) !== 0,
    meta: (bits & 2) !== 0,
    ctrl: (bits & 4) !== 0,
  };
}

/** The letter forms both encodings share: `\x1b[A` and `\x1bOA`. */
const FINAL_NAMES: Readonly<Record<string, KeyName>> = {
  A: 'up',
  B: 'down',
  C: 'right',
  D: 'left',
  F: 'end',
  H: 'home',
};

/** The `\x1b[<n>~` family, keyed by the numeric parameter. */
const TILDE_NAMES: Readonly<Record<string, KeyName>> = {
  '1': 'home',
  '3': 'delete',
  '4': 'end',
  '5': 'pageUp',
  '6': 'pageDown',
  '7': 'home',
  '8': 'end',
};

/** A CSI final byte, `@`–`~`. */
function isFinalByte(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return code >= 0x40 && code <= 0x7e;
}

interface Decoded {
  readonly key: Key;
  /** How many code units of the input this key consumed. */
  readonly length: number;
}

/** `\x1b[…` — the encoding a terminal uses outside DECCKM. */
function decodeCsi(data: string, start: number): Decoded {
  let at = start + 2;
  while (at < data.length && !isFinalByte(data[at] ?? '')) at += 1;

  // An unterminated CSI is a truncated read. Treat the escape alone as Escape
  // and let the rest decode as ordinary characters, which is noisy but never
  // swallows the remainder of the chunk.
  if (at >= data.length) {
    return { key: key('escape', ESC), length: 1 };
  }

  const final = data[at] ?? '';
  const sequence = data.slice(start, at + 1);
  const parameters = data.slice(start + 2, at).split(';');
  const extra = modifiers(parameters[1]);

  // CSI Z is Shift-Tab on every terminal, and carries no modifier parameter.
  if (final === 'Z') {
    return {
      key: key('tab', sequence, { shift: true }),
      length: sequence.length,
    };
  }

  const byFinal = FINAL_NAMES[final];
  if (byFinal !== undefined) {
    return { key: key(byFinal, sequence, extra), length: sequence.length };
  }

  if (final === '~') {
    const byNumber = TILDE_NAMES[parameters[0] ?? ''];
    if (byNumber !== undefined) {
      return { key: key(byNumber, sequence, extra), length: sequence.length };
    }
  }

  return { key: key('unknown', sequence), length: sequence.length };
}

/** `\x1bO…` — SS3, what DECCKM sends for the cursor keys. */
function decodeSs3(data: string, start: number): Decoded {
  const final = data[start + 2];
  if (final === undefined) return { key: key('escape', ESC), length: 1 };

  const sequence = data.slice(start, start + 3);
  const byFinal = FINAL_NAMES[final];
  return {
    key: key(byFinal ?? 'unknown', sequence),
    length: sequence.length,
  };
}

/** A control byte, or a printable character. */
function decodePlain(data: string, start: number): Decoded {
  const char = data[start] ?? '';
  const code = char.codePointAt(0) ?? 0;

  if (char === '\r' || char === '\n') {
    return { key: key('enter', char), length: 1 };
  }
  if (char === '\t') return { key: key('tab', char), length: 1 };
  if (char === '\u007f' || char === '\b') {
    return { key: key('backspace', char), length: 1 };
  }

  // 0x01–0x1a are Ctrl-A through Ctrl-Z. Enter, Tab and Backspace are in that
  // range too (Ctrl-M, Ctrl-I, Ctrl-H) and are named above, because a caller
  // wanting "the user pressed Return" should not have to know it is Ctrl-M.
  if (code >= 1 && code <= 26) {
    return {
      key: key('char', char, {
        char: String.fromCharCode(code + 96),
        ctrl: true,
      }),
      length: 1,
    };
  }

  if (code < 0x20) return { key: key('unknown', char), length: 1 };

  // Astral characters are two code units; taking one would emit half a
  // surrogate pair into the filter.
  const point = data.codePointAt(start) ?? 0;
  const text = String.fromCodePoint(point);
  return { key: key('char', text, { char: text }), length: text.length };
}

/**
 * Every key in one chunk of terminal input.
 *
 * Never throws and never returns a partial key: anything it cannot name comes
 * back as `unknown` with `sequence` intact, so a caller can log what a terminal
 * actually sent without the decoder having to know about it first.
 */
export function parseKeys(data: string): readonly Key[] {
  const keys: Key[] = [];
  let at = 0;

  while (at < data.length) {
    const char = data[at];
    if (char !== ESC) {
      const plain = decodePlain(data, at);
      keys.push(plain.key);
      at += plain.length;
      continue;
    }

    const next = data[at + 1];
    if (next === '[') {
      const csi = decodeCsi(data, at);
      keys.push(csi.key);
      at += csi.length;
      continue;
    }
    if (next === 'O') {
      const ss3 = decodeSs3(data, at);
      keys.push(ss3.key);
      at += ss3.length;
      continue;
    }
    if (next === undefined) {
      keys.push(key('escape', ESC));
      at += 1;
      continue;
    }

    // `\x1b` then anything else is Alt held with that key.
    const alt = decodePlain(data, at + 1);
    keys.push({
      ...alt.key,
      meta: true,
      sequence: ESC + alt.key.sequence,
    });
    at += 1 + alt.length;
  }

  return keys;
}

/** The first key in `data`, for a caller that knows there is only one. */
export function parseKey(data: string): Key | undefined {
  return parseKeys(data)[0];
}

/**
 * Whether a key is a particular Ctrl-letter.
 *
 * Ctrl-M, Ctrl-I and Ctrl-H are named `enter`, `tab` and `backspace` instead, so
 * this answers `false` for those three — which is the useful answer: a menu
 * binding Ctrl-H to something is a menu that eats Backspace.
 */
export function isCtrl(input: Key, letter: string): boolean {
  return (
    input.ctrl && input.name === 'char' && input.char === letter.toLowerCase()
  );
}
