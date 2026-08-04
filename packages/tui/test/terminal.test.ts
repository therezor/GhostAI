import { openKeyboard, columnsOf, rowsOf } from '#src/terminal.js';
import type { Key } from '#src/keys.js';
import { fakeInput, fakeOutput, flush } from '#testkit/terminal.js';
import { describe, expect, it } from 'vitest';

const ESC = String.fromCharCode(27);

describe('how big the window is', () => {
  it('takes the stream at its word when it reports a size', () => {
    const out = fakeOutput({ columns: 132, rows: 43 });
    expect(columnsOf(out)).toBe(132);
    expect(rowsOf(out)).toBe(43);
  });

  it('falls back when the stream reports zero, which a recorded pty does', () => {
    // Zero is not nullish, so `output.columns ?? 80` reads it as a real answer
    // and every width collapses to nothing. `script(1)` allocates a pty with no
    // size, and a terminal mid-resize can answer 0 as well.
    const out = fakeOutput({ columns: 0, rows: 0 });
    expect(columnsOf(out)).toBe(80);
    expect(rowsOf(out)).toBe(24);
    expect(columnsOf(out, 100)).toBe(100);
  });
});

describe('reading the keyboard', () => {
  it('delivers a decoded key for each keystroke in a chunk', async () => {
    // stdin hands over `\x1b[B\x1b[B\r` as one chunk routinely, and a reader
    // that answered one key per chunk would drop the rest of a paste.
    const input = fakeInput();
    const keyboard = openKeyboard({ input });
    const seen: Key[] = [];
    keyboard.onKey((key) => seen.push(key));

    input.type(`${ESC}[B${ESC}[B\r`);
    await flush();

    expect(seen.map((key) => key.name)).toEqual(['down', 'down', 'enter']);
    keyboard.stop();
  });

  it('lets a handler unsubscribe itself from inside itself', async () => {
    // Which is what closing a menu from its own key handler does.
    const input = fakeInput();
    const keyboard = openKeyboard({ input });
    const seen: string[] = [];
    const off = keyboard.onKey((key) => {
      seen.push(key.name);
      off();
    });

    input.type('ab');
    await flush();

    expect(seen).toEqual(['char']);
    keyboard.stop();
  });

  it('turns raw mode on for a terminal and off again on the way out', () => {
    const input = fakeInput();
    const keyboard = openKeyboard({ input });
    expect(input.rawModeCalls).toEqual([true]);

    keyboard.stop();
    expect(input.rawModeCalls).toEqual([true, false]);
  });

  it('leaves a mode somebody else set exactly where it found it', () => {
    // Toggling raw mode underneath whatever set it is how a terminal ends up
    // with no echo after the process exits.
    const input = fakeInput();
    input.isRaw = true;
    const keyboard = openKeyboard({ input });
    keyboard.stop();

    expect(input.rawModeCalls).toEqual([]);
  });

  it('does not touch the mode of something that is not a terminal', () => {
    const input = fakeInput({ isTTY: false });
    const keyboard = openKeyboard({ input });
    keyboard.stop();

    expect(input.rawModeCalls).toEqual([]);
  });

  it('stops once, however often it is asked', () => {
    const input = fakeInput();
    const keyboard = openKeyboard({ input });
    keyboard.stop();
    keyboard.stop();

    expect(input.rawModeCalls).toEqual([true, false]);
  });

  it('delivers nothing after it has stopped', async () => {
    const input = fakeInput();
    const keyboard = openKeyboard({ input });
    const seen: string[] = [];
    keyboard.onKey((key) => seen.push(key.name));
    keyboard.stop();

    input.type('a');
    await flush();

    expect(seen).toEqual([]);
  });
});
