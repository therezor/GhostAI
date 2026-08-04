import { describe, expect, it } from 'vitest';

import {
  columnsOf,
  openScreen,
  rowsOf,
  type InputHandover,
  type TerminalOutput,
} from '#src/screen.js';
import { stripAnsi, visibleWidth } from '#src/text.js';
import { fakeInput, fakeOutput, flush } from '#testkit/terminal.js';

const ESC = String.fromCharCode(27);
const CSI = `${ESC}[`;
const ERASE_BELOW = `${CSI}0J`;
const SYNC_ON = `${CSI}?2026h`;
const SYNC_OFF = `${CSI}?2026l`;

/** How many times a substring appears — cheaper to read than a regex count. */
function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

describe('painting', () => {
  it('writes the lines and moves no cursor on the first frame', () => {
    // There is nothing on screen yet to erase, so a cursor-up here would climb
    // into the transcript above and overwrite it.
    const output = fakeOutput();
    const screen = openScreen({ input: fakeInput(), output });

    screen.paint(['one', 'two', 'three']);

    expect(output.text).toContain('one\ntwo\nthree');
    expect(output.text).not.toContain(`${CSI}1A`);
    expect(output.text).not.toContain(`${CSI}2A`);
    screen.close();
  });

  it('climbs exactly height-minus-one rows to repaint', () => {
    // After painting N lines the cursor sits at the end of the last one, so
    // getting back to the first is N-1. Off by one either way and the menu
    // either eats a line of transcript or leaves one of itself behind.
    const output = fakeOutput();
    const screen = openScreen({ input: fakeInput(), output });

    screen.paint(['one', 'two', 'three']);
    output.reset();
    screen.paint(['one', 'two', 'four']);

    expect(output.text).toContain(`${CSI}2A`);
    expect(occurrences(output.text, 'A')).toBe(1);
    screen.close();
  });

  it('erases without climbing when only one line is on screen', () => {
    const output = fakeOutput();
    const screen = openScreen({ input: fakeInput(), output });

    screen.paint(['only']);
    output.reset();
    screen.paint(['only again']);

    expect(output.text).not.toContain('A');
    expect(output.text).toContain(`\r${ERASE_BELOW}`);
    screen.close();
  });

  it('treats a paint after a clear as a first paint again', () => {
    const output = fakeOutput();
    const screen = openScreen({ input: fakeInput(), output });

    screen.paint(['one', 'two']);
    screen.clear();
    output.reset();
    screen.paint(['one', 'two']);

    expect(output.text).not.toContain(`${CSI}1A`);
    screen.close();
  });

  it('truncates a line to the window width rather than letting it wrap', () => {
    // The invariant everything else rests on: a wrapped line occupies two rows,
    // so the cursor-up stops a row short and the leftover stays in the
    // scrollback for good.
    const output = fakeOutput({ columns: 10 });
    const screen = openScreen({ input: fakeInput(), output });

    screen.paint(['a-line-far-longer-than-ten-columns']);

    const drawn = stripAnsi(output.text).replaceAll('\r', '').split('\n');
    for (const line of drawn) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(10);
    }
    screen.close();
  });

  it('brackets a repaint in synchronized output, and does not when asked not to', () => {
    const on = fakeOutput();
    const withSync = openScreen({ input: fakeInput(), output: on });
    withSync.paint(['x']);
    expect(on.text.startsWith(SYNC_ON)).toBe(true);
    expect(on.text.endsWith(SYNC_OFF)).toBe(true);
    withSync.close();

    const off = fakeOutput();
    const without = openScreen({
      input: fakeInput(),
      output: off,
      synchronized: false,
    });
    without.paint(['x']);
    expect(off.text).not.toContain(SYNC_ON);
    expect(off.text).not.toContain(SYNC_OFF);
    without.close();
  });
});

describe('size', () => {
  it('reads the stream, and falls back for a pipe that reports none', () => {
    const output = fakeOutput({ columns: 100, rows: 30 });
    const sized = openScreen({ input: fakeInput(), output });
    expect(sized.columns).toBe(100);
    expect(sized.rows).toBe(30);
    sized.close();

    const blind = fakeOutput();
    (blind as unknown as { columns: number | undefined }).columns = undefined;
    (blind as unknown as { rows: number | undefined }).rows = undefined;
    const fallback = openScreen({
      input: fakeInput(),
      output: blind,
      columns: 72,
      rows: 12,
    });
    expect(fallback.columns).toBe(72);
    expect(fallback.rows).toBe(12);
    fallback.close();
  });

  it('reports the new size after a resize, and tells whoever asked', () => {
    const output = fakeOutput({ columns: 40, rows: 20 });
    const screen = openScreen({ input: fakeInput(), output });
    let seen = 0;
    screen.onResize(() => {
      seen += 1;
    });

    output.resizeTo(60, 10);

    expect(seen).toBe(1);
    expect(screen.columns).toBe(60);
    expect(screen.rows).toBe(10);
    screen.close();
  });
});

describe('a stream that reports zero', () => {
  // `output.columns ?? 80` is the obvious spelling and it is wrong: zero is not
  // nullish. `script(1)` allocates a pty with no size and reports exactly that,
  // so a recorded session rendered a header of blank lines and a status line
  // that was one ellipsis. A terminal mid-resize can answer 0 as well.
  const blind = { columns: 0, rows: 0 } as unknown as TerminalOutput;

  it('falls back rather than collapsing every width to nothing', () => {
    expect(columnsOf(blind)).toBe(80);
    expect(rowsOf(blind)).toBe(24);
  });

  it('takes an explicit fallback over the default', () => {
    expect(columnsOf(blind, 100)).toBe(100);
    expect(rowsOf(blind, 12)).toBe(12);
  });

  it('uses a real size when there is one', () => {
    const sized = { columns: 132, rows: 43 } as unknown as TerminalOutput;
    expect(columnsOf(sized)).toBe(132);
    expect(rowsOf(sized)).toBe(43);
  });

  it('is what a screen over such a stream reports too', () => {
    const output = fakeOutput();
    output.columns = 0;
    output.rows = 0;
    const screen = openScreen({ input: fakeInput(), output });

    expect(screen.columns).toBe(80);
    expect(screen.rows).toBe(24);
    screen.close();
  });

  it('prefers a caller-supplied size to the default, but never to a real one', () => {
    const output = fakeOutput();
    output.columns = 0;
    const asked = openScreen({ input: fakeInput(), output, columns: 50 });
    expect(asked.columns).toBe(50);
    asked.close();
  });
});

describe('keys', () => {
  it('decodes what was typed and hands it to every listener', async () => {
    const input = fakeInput();
    const screen = openScreen({ input, output: fakeOutput() });
    const names: string[] = [];
    screen.onKey((key) => names.push(key.name));

    input.type(`${CSI}B\r`);
    await flush();

    expect(names).toEqual(['down', 'enter']);
    screen.close();
  });

  it('stops delivering to a listener that unsubscribed', async () => {
    const input = fakeInput();
    const screen = openScreen({ input, output: fakeOutput() });
    const names: string[] = [];
    const off = screen.onKey((key) => names.push(key.name));

    input.type('a');
    await flush();
    off();
    input.type('b');
    await flush();

    expect(names).toEqual(['char']);
    screen.close();
  });

  it('survives a listener that unsubscribes itself while it is being called', async () => {
    // The dispatch iterates a copy for exactly this: a `select` that resolves on
    // Enter tears down its own handler from inside it.
    const input = fakeInput();
    const screen = openScreen({ input, output: fakeOutput() });
    let seen = 0;
    const off = screen.onKey(() => {
      seen += 1;
      off();
    });

    input.type('ab');
    await flush();

    expect(seen).toBe(1);
    screen.close();
  });
});

describe('raw mode and the handover', () => {
  it('enters raw mode when nobody else has, and leaves it as it found it', () => {
    const input = fakeInput();
    const screen = openScreen({ input, output: fakeOutput() });
    expect(input.rawModeCalls).toEqual([true]);

    screen.close();
    expect(input.rawModeCalls).toEqual([true, false]);
  });

  it('leaves raw mode alone when the caller already set it', () => {
    // readline sets it before a menu ever opens, and toggling it underneath
    // readline is how a shell ends up with no echo after the process exits.
    const input = fakeInput();
    input.setRawMode?.(true);
    input.rawModeCalls.length = 0;

    const screen = openScreen({ input, output: fakeOutput() });
    screen.close();

    expect(input.rawModeCalls).toEqual([]);
  });

  it('never touches raw mode on something that is not a terminal', () => {
    const input = fakeInput({ isTTY: false });
    const screen = openScreen({ input, output: fakeOutput() });
    screen.close();
    expect(input.rawModeCalls).toEqual([]);
  });

  it('takes stdin on open and gives it back exactly once on close', () => {
    let released = 0;
    const handover = (): InputHandover => ({
      release: () => {
        released += 1;
      },
    });

    const screen = openScreen({
      input: fakeInput(),
      output: fakeOutput(),
      handover,
    });
    expect(released).toBe(0);

    screen.close();
    screen.close();
    expect(released).toBe(1);
  });

  it('erases what it drew before it closes', () => {
    const output = fakeOutput();
    const screen = openScreen({ input: fakeInput(), output });
    screen.paint(['one', 'two']);
    output.reset();

    screen.close();

    expect(output.text).toContain(ERASE_BELOW);
  });

  it('writes nothing more once it is closed', () => {
    const output = fakeOutput();
    const screen = openScreen({ input: fakeInput(), output });
    screen.close();
    output.reset();

    screen.paint(['ignored']);
    screen.clear();

    expect(output.text).toBe('');
  });

  it('does not write an erase for a region it never painted', () => {
    const output = fakeOutput();
    const screen = openScreen({ input: fakeInput(), output });
    screen.clear();
    expect(output.text).toBe('');
    screen.close();
  });
});
