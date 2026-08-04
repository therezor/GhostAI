import { describe, expect, it } from 'vitest';

import { openBottomBar } from '#src/bottom-bar.js';
import { stripAnsi, visibleWidth } from '#src/text.js';
import { fakeOutput, type FakeOutput } from '#testkit/terminal.js';

const ESC = String.fromCharCode(27);
const CSI = `${ESC}[`;
const SAVE = `${ESC}7`;
const RESTORE = `${ESC}8`;
const ERASE_BELOW = `${CSI}0J`;

function bar(output: FakeOutput) {
  return openBottomBar({ output });
}

describe('painting', () => {
  it('steps one row below the cursor and draws there', () => {
    // Relative, not absolute. Addressing the bottom rows of the screen is what
    // painted over the prompt: a reservation guarantees rows below the
    // *cursor*, and the prompt writes its own lines into them first.
    const output = fakeOutput();
    const status = bar(output);

    status.paint(['one', 'two']);

    expect(stripAnsi(output.text)).toBe('\none\ntwo');
    status.close();
  });

  it('never addresses a row by number, so it cannot land on the transcript', () => {
    const output = fakeOutput();
    const status = bar(output);
    status.paint(['one', 'two']);
    expect(output.text).not.toMatch(/\[\d+;1H/u);
    status.close();
  });

  it('leaves the cursor exactly where it found it', () => {
    const output = fakeOutput();
    const status = bar(output);

    status.paint(['one']);

    expect(output.text.indexOf(SAVE)).toBeLessThan(output.text.indexOf('one'));
    expect(output.text.indexOf(RESTORE)).toBeGreaterThan(
      output.text.indexOf('one'),
    );
    status.close();
  });

  it('erases the old bar before writing the new one', () => {
    // A repaint that shrank would otherwise leave its last row behind, and
    // readline's own refresh does not reach past what it drew itself.
    const output = fakeOutput();
    const status = bar(output);

    status.paint(['one', 'two']);
    output.reset();
    status.paint(['one']);

    expect(output.text).toContain(ERASE_BELOW);
    expect(stripAnsi(output.text)).toBe('\none');
    status.close();
  });

  it('writes no trailing newline, so the last row cannot scroll the screen', () => {
    // A scroll would move the screen under the saved cursor position, and the
    // restore would put the cursor a row out for the rest of the session.
    const output = fakeOutput();
    const status = bar(output);

    status.paint(['one', 'two', 'three']);

    expect(stripAnsi(output.text).endsWith('three')).toBe(true);
    status.close();
  });

  it('truncates every row to the window width rather than letting one wrap', () => {
    const output = fakeOutput({ columns: 12 });
    const status = bar(output);

    status.paint(['a-status-row-far-wider-than-twelve']);

    for (const line of stripAnsi(output.text).split('\n')) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(12);
    }
    status.close();
  });

  it('treats an empty paint as an erase', () => {
    const output = fakeOutput();
    const status = bar(output);
    status.paint(['one']);
    output.reset();

    status.paint([]);

    expect(output.text).toContain(ERASE_BELOW);
    expect(stripAnsi(output.text)).toBe('');
    status.close();
  });
});

describe('reserving', () => {
  it('pushes the transcript up by the height it was given', () => {
    // At the bottom of the screen this scrolls, which is the point: everything
    // below the cursor afterwards is blank, so nothing the bar writes lands on
    // the transcript and nothing it writes can scroll.
    const output = fakeOutput();
    const status = bar(output);

    status.reserve(3);

    expect(output.text).toBe(`\n\n\n${CSI}3A`);
    status.close();
  });

  it('does nothing for a height of nothing', () => {
    const output = fakeOutput();
    const status = bar(output);
    status.reserve(0);
    expect(output.text).toBe('');
    status.close();
  });
});

describe('clearing', () => {
  it('erases from where the cursor already is, without stepping down', () => {
    // On Return readline has written `\r\n` and the cursor is on the bar's
    // first row. Stepping down again would leave that row behind, and the
    // turn's output would print underneath a stale rule.
    const output = fakeOutput();
    const status = bar(output);
    status.paint(['one', 'two']);
    output.reset();

    status.clear();

    expect(output.text).toContain(ERASE_BELOW);
    expect(stripAnsi(output.text)).toBe('');
    status.close();
  });

  it('does not erase a bar it never painted', () => {
    const output = fakeOutput();
    const status = bar(output);
    status.clear();
    expect(output.text).toBe('');
    status.close();
  });
});

describe('a terminal that will not say how tall it is', () => {
  it('still gets a bar, because drawing under the cursor needs no height', () => {
    // A pty allocated by `script(1)` reports neither dimension. Addressing rows
    // absolutely had to refuse those outright; drawing relative to the cursor
    // only needs the width, and falls back for that.
    const output = fakeOutput();
    output.rows = 0;
    output.columns = 0;
    const status = bar(output);

    expect(status.available).toBe(true);
    status.paint(['one']);

    expect(stripAnsi(output.text)).toBe('\none');
    status.close();
  });
});

describe('closing', () => {
  it('erases what it drew', () => {
    const output = fakeOutput();
    const status = bar(output);
    status.paint(['one']);
    output.reset();

    status.close();

    expect(output.text).toContain(ERASE_BELOW);
  });

  it('writes nothing more once closed, however many times it is called', () => {
    const output = fakeOutput();
    const status = bar(output);
    status.paint(['one']);
    status.close();
    output.reset();

    status.close();
    status.paint(['two']);
    status.reserve(2);

    expect(output.text).toBe('');
    expect(status.available).toBe(false);
  });
});
