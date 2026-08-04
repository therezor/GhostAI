import { describe, expect, it } from 'vitest';

import { isCtrl, parseKey, parseKeys, type KeyName } from '#src/keys.js';

/**
 * Built rather than typed, so no source file in this package carries a literal
 * `0x1b` — one is invisible in an editor and unsearchable with the tools
 * everyone tries first.
 */
const ESC = String.fromCharCode(27);
const CSI = `${ESC}[`;
const DEL = String.fromCharCode(127);

/** The name alone, for the cases where the modifiers are not the point. */
function nameOf(data: string): KeyName | undefined {
  return parseKey(data)?.name;
}

describe('parseKeys', () => {
  it('decodes the cursor keys in both encodings, because a terminal in DECCKM sends the other one', () => {
    // This is the single most likely cause of "the arrow keys do nothing on my
    // machine": plenty of terminals send SS3 for the cursor keys by default,
    // and a decoder that only knows CSI silently ignores every one of them.
    expect(nameOf(`${CSI}A`)).toBe('up');
    expect(nameOf(`${ESC}OA`)).toBe('up');
    expect(nameOf(`${CSI}B`)).toBe('down');
    expect(nameOf(`${ESC}OB`)).toBe('down');
    expect(nameOf(`${CSI}C`)).toBe('right');
    expect(nameOf(`${ESC}OC`)).toBe('right');
    expect(nameOf(`${CSI}D`)).toBe('left');
    expect(nameOf(`${ESC}OD`)).toBe('left');
  });

  it('decodes Home and End in all three forms terminals use for them', () => {
    expect(nameOf(`${CSI}H`)).toBe('home');
    expect(nameOf(`${ESC}OH`)).toBe('home');
    expect(nameOf(`${CSI}1~`)).toBe('home');
    expect(nameOf(`${CSI}F`)).toBe('end');
    expect(nameOf(`${ESC}OF`)).toBe('end');
    expect(nameOf(`${CSI}4~`)).toBe('end');
  });

  it('decodes the tilde family', () => {
    expect(nameOf(`${CSI}3~`)).toBe('delete');
    expect(nameOf(`${CSI}5~`)).toBe('pageUp');
    expect(nameOf(`${CSI}6~`)).toBe('pageDown');
  });

  it('reads the modifier parameter as the 1-plus-bitmask a terminal writes', () => {
    // `\x1b[1;5A` is Ctrl-Up: 5 is 1 + 4, and 4 is the control bit.
    expect(parseKey(`${CSI}1;5A`)).toMatchObject({ name: 'up', ctrl: true });
    expect(parseKey(`${CSI}1;2A`)).toMatchObject({ name: 'up', shift: true });
    expect(parseKey(`${CSI}1;3A`)).toMatchObject({ name: 'up', meta: true });
    // A parameter of 1 means "no modifiers", not "shift".
    expect(parseKey(`${CSI}1;1A`)).toMatchObject({
      name: 'up',
      ctrl: false,
      shift: false,
      meta: false,
    });
  });

  it('decodes CSI Z as Shift-Tab, which carries no modifier parameter of its own', () => {
    expect(parseKey(`${CSI}Z`)).toMatchObject({ name: 'tab', shift: true });
  });

  it('names Enter, Tab and Backspace rather than the control letters they are', () => {
    // A caller asking "did the user press Return" should not have to know that
    // Return is Ctrl-M.
    expect(nameOf('\r')).toBe('enter');
    expect(nameOf('\n')).toBe('enter');
    expect(nameOf('\t')).toBe('tab');
    expect(nameOf(DEL)).toBe('backspace');
    expect(nameOf('\b')).toBe('backspace');
  });

  it('decodes a control byte as the letter it was typed with', () => {
    // So a caller matches Ctrl-C the same way it matches `c`, rather than
    // against a byte value.
    expect(parseKey(String.fromCharCode(3))).toMatchObject({
      name: 'char',
      char: 'c',
      ctrl: true,
    });
    expect(parseKey(String.fromCharCode(21))).toMatchObject({
      char: 'u',
      ctrl: true,
    });
  });

  it('decodes an ordinary character', () => {
    expect(parseKey('a')).toMatchObject({ name: 'char', char: 'a' });
    expect(parseKey('A')).toMatchObject({ name: 'char', char: 'A' });
  });

  it('keeps an astral character whole, rather than emitting half a surrogate pair', () => {
    const rocket = '🚀';
    expect(rocket.length).toBe(2);
    const keys = parseKeys(rocket);
    expect(keys).toHaveLength(1);
    expect(keys[0]?.char).toBe(rocket);
  });

  it('decodes every key in one chunk, because stdin does not deliver them one at a time', () => {
    // Holding an arrow key, or pasting, arrives as a single `data` event. A
    // decoder that returned the first key would look like a menu skipping rows.
    const keys = parseKeys(`${CSI}B${CSI}B\r`);
    expect(keys.map((key) => key.name)).toEqual(['down', 'down', 'enter']);
  });

  it('decodes an escape followed by a character as Alt held with it', () => {
    expect(parseKey(`${ESC}b`)).toMatchObject({
      name: 'char',
      char: 'b',
      meta: true,
    });
  });

  it('decodes a lone escape as Escape, which is what pressing it sends', () => {
    expect(parseKey(ESC)).toMatchObject({ name: 'escape' });
    expect(parseKeys(ESC)).toHaveLength(1);
  });

  it('names an unrecognised sequence rather than dropping it, and keeps the bytes', () => {
    const key = parseKey(`${CSI}200~`);
    expect(key?.name).toBe('unknown');
    expect(key?.sequence).toBe(`${CSI}200~`);
  });

  it('recovers the rest of the chunk when a CSI sequence is never terminated', () => {
    // A truncated read is noisy either way; what matters is that the remaining
    // bytes are still decoded rather than swallowed with the broken sequence.
    const keys = parseKeys(`${CSI}12`);
    expect(keys[0]?.name).toBe('escape');
    expect(keys.map((key) => key.char).join('')).toContain('12');
  });

  it('returns nothing for an empty chunk', () => {
    expect(parseKeys('')).toEqual([]);
    expect(parseKey('')).toBeUndefined();
  });
});

describe('isCtrl', () => {
  it('matches a control letter case-insensitively', () => {
    const key = parseKey(String.fromCharCode(7));
    expect(key).toBeDefined();
    expect(isCtrl(key!, 'g')).toBe(true);
    expect(isCtrl(key!, 'G')).toBe(true);
    expect(isCtrl(key!, 'h')).toBe(false);
  });

  it('answers false for Tab, Enter and Backspace', () => {
    // They are Ctrl-I, Ctrl-M and Ctrl-H on the wire. A menu that bound Ctrl-H
    // to something would otherwise be a menu that eats Backspace.
    for (const [data, letter] of [
      ['\t', 'i'],
      ['\r', 'm'],
      ['\b', 'h'],
    ] as const) {
      const key = parseKey(data);
      expect(key).toBeDefined();
      expect(isCtrl(key!, letter)).toBe(false);
    }
  });

  it('answers false for an ordinary character', () => {
    const key = parseKey('c');
    expect(isCtrl(key!, 'c')).toBe(false);
  });
});
