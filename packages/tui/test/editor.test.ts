import { CURSOR_MARKER } from '#src/component.js';
import { createEditor, type Editor } from '#src/editor.js';
import { parseKey } from '#src/keys.js';
import { PLAIN_THEME } from '#src/theme.js';
import { describe, expect, it } from 'vitest';

const ESC = String.fromCharCode(27);

function editor(): Editor {
  return createEditor({ theme: PLAIN_THEME });
}

/** The bytes a terminal would send, decoded the way the real loop decodes them. */
function press(subject: Editor, bytes: string): void {
  const key = parseKey(bytes);
  if (key !== undefined) subject.handleKey(key);
}

function type(subject: Editor, text: string): void {
  for (const char of text) press(subject, char);
}

/** Where the caret is, in columns, on the row it sits on. */
function caret(subject: Editor, width = 40): number {
  for (const row of subject.render(width)) {
    const at = row.indexOf(CURSOR_MARKER);
    if (at >= 0) return at;
  }
  throw new Error('the editor drew no caret');
}

describe('typing', () => {
  it('shows what was typed, with the caret after it', () => {
    const subject = editor();
    type(subject, 'hello');

    expect(subject.text).toBe('hello');
    expect(caret(subject)).toBe('› hello'.length);
  });

  it('inserts at the caret rather than at the end', () => {
    const subject = editor();
    type(subject, 'helo');
    press(subject, `${ESC}[D`);
    type(subject, 'l');

    expect(subject.text).toBe('hello');
  });

  it('deletes what a person can see, not what a code point is', () => {
    const subject = editor();
    type(subject, 'ab');
    subject.handleKey({
      name: 'char',
      char: '👩‍👩‍👧',
      ctrl: false,
      shift: false,
      meta: false,
      sequence: '👩‍👩‍👧',
    });
    press(subject, String.fromCharCode(127));

    expect(subject.text).toBe('ab');
  });
});

describe('moving', () => {
  it('steps over a whole grapheme cluster', () => {
    const subject = editor();
    subject.setText('a👩‍👩‍👧b');
    press(subject, `${ESC}[D`);
    press(subject, `${ESC}[D`);

    // Two steps left from the end lands before the family, not inside it.
    press(subject, String.fromCharCode(127));
    expect(subject.text).toBe('👩‍👩‍👧b');
  });

  it('honours the shell bindings for the ends of the line', () => {
    const subject = editor();
    type(subject, 'hello');
    press(subject, String.fromCharCode(1)); // ctrl-a
    expect(caret(subject)).toBe('› '.length);

    press(subject, String.fromCharCode(5)); // ctrl-e
    expect(caret(subject)).toBe('› hello'.length);
  });
});

describe('word movement', () => {
  it('steps a word at a time when the terminal says the key was modified', () => {
    const subject = editor();
    subject.setText('one two three');
    subject.handleKey({
      name: 'left',
      char: '',
      ctrl: false,
      shift: false,
      meta: true,
      sequence: '',
    });
    press(subject, String.fromCharCode(11)); // ctrl-k

    expect(subject.text).toBe('one two ');
  });

  it('honours ctrl-b and ctrl-f, which survive terminals that mangle arrows', () => {
    const subject = editor();
    type(subject, 'hello');
    press(subject, String.fromCharCode(2)); // ctrl-b
    press(subject, String.fromCharCode(2));
    expect(caret(subject)).toBe('› hel'.length);

    press(subject, String.fromCharCode(6)); // ctrl-f
    expect(caret(subject)).toBe('› hell'.length);
  });
});

describe('killing', () => {
  it('ctrl-u drops what is behind the caret and ctrl-k what is ahead', () => {
    const subject = editor();
    type(subject, 'hello world');
    press(subject, String.fromCharCode(1));
    press(subject, String.fromCharCode(11)); // ctrl-k
    expect(subject.text).toBe('');

    type(subject, 'hello world');
    press(subject, String.fromCharCode(21)); // ctrl-u
    expect(subject.text).toBe('');
  });

  it('ctrl-w takes one word', () => {
    const subject = editor();
    type(subject, 'hello brave world');
    press(subject, String.fromCharCode(23));

    expect(subject.text).toBe('hello brave ');
  });
});

describe('what a keystroke asks for', () => {
  it('submits the line and clears it', () => {
    const subject = editor();
    type(subject, 'hello');
    const outcome = subject.handleKey(parseKey('\r')!);

    expect(outcome).toEqual({ kind: 'submit', text: 'hello' });
    expect(subject.text).toBe('');
  });

  it('reads Ctrl-C as an interrupt and Ctrl-D on an empty line as end of input', () => {
    const subject = editor();
    expect(subject.handleKey(parseKey(String.fromCharCode(3))!)).toEqual({
      kind: 'interrupt',
    });
    expect(subject.handleKey(parseKey(String.fromCharCode(4))!)).toEqual({
      kind: 'eof',
    });
  });

  it('reads Ctrl-D with a line in progress as forward delete', () => {
    // Which is what a shell does, and the reason end-of-input is spelled "an
    // empty line" rather than "the key".
    const subject = editor();
    subject.setText('hello');
    press(subject, String.fromCharCode(1));
    const outcome = subject.handleKey(parseKey(String.fromCharCode(4))!);

    expect(outcome.kind).toBe('none');
    expect(subject.text).toBe('ello');
  });
});

describe('history', () => {
  it('walks back through what was submitted, and forward to the draft', () => {
    const subject = editor();
    subject.remember('first');
    subject.remember('second');
    type(subject, 'half writ');

    press(subject, `${ESC}[A`);
    expect(subject.text).toBe('second');
    press(subject, `${ESC}[A`);
    expect(subject.text).toBe('first');
    press(subject, `${ESC}[B`);
    expect(subject.text).toBe('second');
    press(subject, `${ESC}[B`);
    expect(subject.text).toBe('half writ');
  });

  it('does not keep the same line twice in a row', () => {
    const subject = editor();
    subject.remember('again');
    subject.remember('again');

    press(subject, `${ESC}[A`);
    press(subject, `${ESC}[A`);
    expect(subject.text).toBe('again');
  });
});

describe('drawing', () => {
  it('wraps a long line rather than cutting it, and indents the fold', () => {
    const subject = editor();
    subject.setText('one two three four five six seven');
    const rows = subject.render(16);

    expect(rows.length).toBeGreaterThan(1);
    expect(rows[0]).toContain('› one');
    expect(rows[1]?.startsWith('  ')).toBe(true);
    expect(rows.join(' ')).toContain('seven');
  });

  it('folds at the window edge, not fifteen columns short of it', () => {
    // The caret marker is an APC string, and an APC string the width table did
    // not know about measured as its own payload — so the line folded fifteen
    // columns early, and where it folded moved as the caret moved.
    const withCaret = editor();
    withCaret.setText('abcdefghij klmnopqrst uvwxyzabcd');
    const parked = editor();
    parked.setText('abcdefghij klmnopqrst uvwxyzabcd');
    parked.handleKey({
      name: 'home',
      char: '',
      ctrl: false,
      shift: false,
      meta: false,
      sequence: '',
    });

    expect(withCaret.render(24)).toHaveLength(2);
    expect(parked.render(24)).toHaveLength(2);
  });

  it('draws a placeholder, with the caret on it, when nothing is typed', () => {
    const subject = createEditor({
      theme: PLAIN_THEME,
      placeholder: 'ask something',
    });

    expect(subject.render(40)[0]).toContain('ask something');
  });
});
