import { describe, expect, it } from 'vitest';

import { openBottomBar } from '#src/bottom-bar.js';
import { stripAnsi, visibleWidth } from '#src/text.js';
import { fakeOutput, type FakeOutput } from '#testkit/terminal.js';

const ESC = String.fromCharCode(27);
const CSI = `${ESC}[`;
const SAVE = `${ESC}7`;
const RESTORE = `${ESC}8`;
const ERASE_BELOW = `${CSI}0J`;

/**
 * The row a `CUP` in the output addressed, or undefined if there was none.
 *
 * The escape byte is deliberately left out of the pattern: `no-control-regex`
 * flags a literal one, and the `[n;1H` tail is unambiguous enough for a test
 * asserting on a handful of bytes this file just watched being written.
 */
function addressedRow(text: string): number | undefined {
  const match = /\[(\d+);1H/u.exec(text);
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

function bar(output: FakeOutput) {
  return openBottomBar({ output });
}

describe('painting', () => {
  it('addresses the bottom rows absolutely, so nothing it writes can scroll', () => {
    // A scroll would move the screen under the saved cursor position, and the
    // restore would then put the cursor on the wrong row for good.
    const output = fakeOutput({ rows: 24 });
    const status = bar(output);

    status.paint(['one', 'two']);

    expect(addressedRow(output.text)).toBe(23);
    expect(output.text).not.toContain('\n');
    status.close();
  });

  it('leaves the cursor exactly where it found it', () => {
    const output = fakeOutput();
    const status = bar(output);

    status.paint(['one']);

    // Saved before anything is drawn and restored after — the frame's
    // synchronized-output wrapper is the only thing outside the pair.
    expect(output.text.indexOf(SAVE)).toBeLessThan(
      output.text.indexOf(RESTORE),
    );
    expect(output.text.indexOf(RESTORE)).toBeGreaterThan(
      output.text.indexOf('one'),
    );
    status.close();
  });

  it('erases the old bar before writing the new one', () => {
    // readline's own refresh clears from the prompt row down, which is where the
    // bar is — but a repaint that shrank would otherwise leave its last row.
    const output = fakeOutput();
    const status = bar(output);

    status.paint(['one', 'two']);
    output.reset();
    status.paint(['one']);

    expect(output.text).toContain(ERASE_BELOW);
    status.close();
  });

  it('truncates every row to the window width rather than letting one wrap', () => {
    const output = fakeOutput({ columns: 12 });
    const status = bar(output);

    status.paint(['a-status-row-far-wider-than-twelve']);

    const drawn = stripAnsi(output.text).replaceAll('\r', '');
    for (const line of drawn.split('\n')) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(12);
    }
    status.close();
  });

  it('keeps the last rows when handed more than the window can hold', () => {
    const output = fakeOutput({ rows: 3 });
    const status = bar(output);

    status.paint(['a', 'b', 'c', 'd', 'e']);

    expect(stripAnsi(output.text)).toContain('e');
    status.close();
  });

  it('treats an empty paint as an erase', () => {
    const output = fakeOutput();
    const status = bar(output);
    status.paint(['one']);
    output.reset();

    status.paint([]);

    expect(output.text).toContain(ERASE_BELOW);
    status.close();
  });
});

describe('reserving', () => {
  it('pushes the transcript up by the height it was given', () => {
    // At the bottom of the screen this scrolls once, which is the point: the
    // prompt drawn next then has the bar's rows beneath it.
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

describe('a terminal that will not say how tall it is', () => {
  it('gets no bar at all, rather than one painted into the transcript', () => {
    // Guessing 24 rows and addressing row 22 on a window of 60 would write the
    // status into the middle of the conversation.
    const output = fakeOutput();
    output.rows = 0;
    const status = bar(output);

    expect(status.available).toBe(false);
    status.reserve(2);
    status.paint(['one']);

    expect(output.text).toBe('');
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
  });

  it('does not erase a bar it never painted', () => {
    const output = fakeOutput();
    const status = bar(output);
    status.clear();
    expect(output.text).toBe('');
    status.close();
  });
});
