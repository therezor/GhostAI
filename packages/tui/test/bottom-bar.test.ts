import { describe, expect, it } from 'vitest';

import { openBottomBar } from '#src/bottom-bar.js';
import { stripAnsi, visibleWidth } from '#src/text.js';
import { fakeOutput, type FakeOutput } from '#testkit/terminal.js';

const ESC = String.fromCharCode(27);
const CSI = `${ESC}[`;
const ERASE_BELOW = `${CSI}0J`;

function bar(output: FakeOutput) {
  return openBottomBar({ output });
}

/** What was drawn, with the trailing cursor-return taken off. */
function drawn(output: FakeOutput): string {
  return stripAnsi(output.text).replace(/\r$/u, '');
}

describe('painting', () => {
  it('steps one row below the cursor and draws there', () => {
    // Relative, not absolute. Addressing the bottom rows of the screen is what
    // painted over the prompt: a reservation guarantees rows below the
    // *cursor*, and the prompt writes its own lines into them first.
    const output = fakeOutput();
    const status = bar(output);

    status.paint(['one', 'two'], 0);

    expect(drawn(output)).toBe('\none\ntwo');
    status.close();
  });

  it('never addresses a row by number, so it cannot land on the transcript', () => {
    const output = fakeOutput();
    const status = bar(output);
    status.paint(['one', 'two'], 0);
    expect(output.text).not.toMatch(/\[\d+;1H/u);
    status.close();
  });

  it('comes back by relative motion, so a scroll cannot leave it a row out', () => {
    // A saved position is in screen coordinates, and an input long enough to
    // wrap past what was reserved makes the newline above scroll. Moving up by
    // the rows just written moves with the screen instead.
    const output = fakeOutput();
    const status = bar(output);

    status.paint(['one', 'two'], 7);

    expect(output.text).toContain(`${CSI}2A`);
    expect(output.text).toContain(`\r${CSI}7C`);
    // No DECSC anywhere: that is the sequence this replaced.
    expect(output.text).not.toContain(`${ESC}7\r`);
    status.close();
  });

  it('returns to column zero without a cursor-right when that is where it was', () => {
    const output = fakeOutput();
    const status = bar(output);
    status.paint(['one'], 0);
    expect(output.text).not.toContain('C');
    status.close();
  });

  it('erases the old bar before writing the new one', () => {
    // A repaint that shrank would otherwise leave its last row behind, and
    // readline's own refresh does not reach past what it drew itself.
    const output = fakeOutput();
    const status = bar(output);

    status.paint(['one', 'two'], 0);
    output.reset();
    status.paint(['one'], 0);

    expect(output.text).toContain(ERASE_BELOW);
    expect(drawn(output)).toBe('\none');
    status.close();
  });

  it('writes no trailing newline, so the last row cannot scroll the screen', () => {
    // A scroll would move the screen under the saved cursor position, and the
    // restore would put the cursor a row out for the rest of the session.
    const output = fakeOutput();
    const status = bar(output);

    status.paint(['one', 'two', 'three'], 0);

    expect(drawn(output).endsWith('three')).toBe(true);
    status.close();
  });

  it('truncates every row to the window width rather than letting one wrap', () => {
    const output = fakeOutput({ columns: 12 });
    const status = bar(output);

    status.paint(['a-status-row-far-wider-than-twelve'], 0);

    for (const line of drawn(output).split('\n')) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(12);
    }
    status.close();
  });

  it('treats an empty paint as an erase', () => {
    const output = fakeOutput();
    const status = bar(output);
    status.paint(['one'], 0);
    output.reset();

    status.paint([], 0);

    expect(output.text).toContain(ERASE_BELOW);
    expect(drawn(output)).toBe('');
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
    status.paint(['one', 'two'], 0);
    output.reset();

    status.clear();

    // Column zero first, so the erase takes the whole row rather than the part
    // to the right of wherever the cursor happened to be — two characters of
    // the rule used to survive at the head of the turn's first line.
    expect(output.text).toContain(`\r${ERASE_BELOW}`);
    expect(drawn(output)).toBe('');
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
    status.paint(['one'], 0);

    expect(drawn(output)).toBe('\none');
    status.close();
  });
});

describe('closing', () => {
  it('erases what it drew', () => {
    const output = fakeOutput();
    const status = bar(output);
    status.paint(['one'], 0);
    output.reset();

    status.close();

    expect(output.text).toContain(ERASE_BELOW);
  });

  it('writes nothing more once closed, however many times it is called', () => {
    const output = fakeOutput();
    const status = bar(output);
    status.paint(['one'], 0);
    status.close();
    output.reset();

    status.close();
    status.paint(['two'], 0);
    status.reserve(2);

    expect(output.text).toBe('');
    expect(status.available).toBe(false);
  });
});
