import { describe, expect, it } from 'vitest';

import { openScreen, type Screen } from '#src/screen.js';
import { select, type SelectLabels } from '#src/select.js';
import type { SelectItem } from '#src/select-list.js';
import {
  fakeInput,
  fakeOutput,
  flush,
  type FakeInput,
  type FakeOutput,
} from '#testkit/terminal.js';

const ESC = String.fromCharCode(27);
const CSI = `${ESC}[`;
const DOWN = `${CSI}B`;
const UP = `${CSI}A`;
const ENTER = '\r';
const CTRL_C = String.fromCharCode(3);
const CTRL_D = String.fromCharCode(4);
const CTRL_U = String.fromCharCode(21);
const BACKSPACE = String.fromCharCode(127);

const LABELS: SelectLabels = {
  title: 'Pick one',
  empty: 'nothing matches',
  footer: 'enter choose · esc cancel',
};

function items(...values: string[]): Array<SelectItem<string>> {
  return values.map((value) => ({ value, label: value }));
}

interface Harness {
  readonly input: FakeInput;
  readonly output: FakeOutput;
  readonly screen: Screen;
}

function harness(size: { columns?: number; rows?: number } = {}): Harness {
  const input = fakeInput();
  const output = fakeOutput(size);
  return { input, output, screen: openScreen({ input, output }) };
}

/**
 * Types the keys, then resolves what the menu answered.
 *
 * The keys are written one at a time with a flush between, because that is what
 * a person does; `parseKeys` handles them arriving together as well, and
 * `keys.test.ts` is where that is asserted.
 */
async function answer(
  test: Harness,
  pending: Promise<string | undefined>,
  ...keys: string[]
): Promise<string | undefined> {
  for (const key of keys) {
    test.input.type(key);
    await flush();
  }
  return await pending;
}

describe('choosing', () => {
  it('resolves the row the cursor was on', async () => {
    const test = harness();
    const pending = select({
      screen: test.screen,
      items: items('first', 'second', 'third'),
      labels: LABELS,
    });

    expect(await answer(test, pending, DOWN, ENTER)).toBe('second');
    test.screen.close();
  });

  it('resolves the first row when Enter comes straight away', async () => {
    const test = harness();
    const pending = select({
      screen: test.screen,
      items: items('first', 'second'),
      labels: LABELS,
    });

    expect(await answer(test, pending, ENTER)).toBe('first');
    test.screen.close();
  });

  it('starts on the row the caller asked for', async () => {
    const test = harness();
    const pending = select({
      screen: test.screen,
      items: items('a', 'b', 'c'),
      labels: LABELS,
      index: 2,
    });

    expect(await answer(test, pending, ENTER)).toBe('c');
    test.screen.close();
  });

  it('moves with Ctrl-P and Ctrl-N as well as the arrows', async () => {
    // Plain control bytes, and therefore the only movement keys that survive a
    // terminal whose cursor sequences arrive in a form nothing recognises.
    const test = harness();
    const pending = select({
      screen: test.screen,
      items: items('a', 'b', 'c'),
      labels: LABELS,
    });

    const chosen = await answer(
      test,
      pending,
      String.fromCharCode(14),
      String.fromCharCode(14),
      String.fromCharCode(16),
      ENTER,
    );
    expect(chosen).toBe('b');
    test.screen.close();
  });

  it('wraps upward from the first row', async () => {
    const test = harness();
    const pending = select({
      screen: test.screen,
      items: items('a', 'b', 'c'),
      labels: LABELS,
    });

    expect(await answer(test, pending, UP, ENTER)).toBe('c');
    test.screen.close();
  });

  it('ignores Enter on a disabled row rather than choosing it', async () => {
    const test = harness();
    const pending = select<string>({
      screen: test.screen,
      items: [
        { value: 'a', label: 'a' },
        { value: 'b', label: 'b', disabled: true },
      ],
      labels: LABELS,
    });

    // Down steps over the disabled row and wraps back to `a`, so Enter answers
    // `a` — the disabled row is never reachable and never chosen.
    expect(await answer(test, pending, DOWN, ENTER)).toBe('a');
    test.screen.close();
  });
});

describe('filtering', () => {
  it('narrows as the operator types, and chooses from what is left', async () => {
    const test = harness();
    const pending = select({
      screen: test.screen,
      items: items('reviewer', 'scout', 'archivist'),
      labels: LABELS,
    });

    expect(await answer(test, pending, 's', 'c', ENTER)).toBe('scout');
    test.screen.close();
  });

  it('widens again on Backspace', async () => {
    const test = harness();
    const pending = select({
      screen: test.screen,
      items: items('alpha', 'beta'),
      labels: LABELS,
    });

    expect(await answer(test, pending, 'b', BACKSPACE, ENTER)).toBe('alpha');
    test.screen.close();
  });

  it('clears the whole filter on Ctrl-U', async () => {
    const test = harness();
    const pending = select({
      screen: test.screen,
      items: items('alpha', 'beta'),
      labels: LABELS,
    });

    expect(await answer(test, pending, 'b', 'e', CTRL_U, ENTER)).toBe('alpha');
    test.screen.close();
  });

  it('says so when nothing matches, and answers nothing if Enter follows', async () => {
    const test = harness();
    const pending = select({
      screen: test.screen,
      items: items('alpha', 'beta'),
      labels: LABELS,
    });

    test.input.type('zzz');
    await flush();
    expect(test.output.text).toContain('nothing matches');

    expect(await answer(test, pending, ENTER)).toBeUndefined();
    test.screen.close();
  });
});

describe('abandoning', () => {
  it('answers nothing on Escape', async () => {
    const test = harness();
    const pending = select({
      screen: test.screen,
      items: items('a'),
      labels: LABELS,
    });

    expect(await answer(test, pending, ESC)).toBeUndefined();
    test.screen.close();
  });

  it('answers nothing on Ctrl-C, which raw mode delivers as a byte rather than a signal', async () => {
    // The terminal stops translating 0x03 into SIGINT in raw mode, so a menu
    // that did not read the byte itself would be one Ctrl-C could not close.
    const test = harness();
    const pending = select({
      screen: test.screen,
      items: items('a'),
      labels: LABELS,
    });

    expect(await answer(test, pending, CTRL_C)).toBeUndefined();
    test.screen.close();
  });

  it('answers nothing on Ctrl-D', async () => {
    const test = harness();
    const pending = select({
      screen: test.screen,
      items: items('a'),
      labels: LABELS,
    });

    expect(await answer(test, pending, CTRL_D)).toBeUndefined();
    test.screen.close();
  });

  it('answers nothing when the signal aborts while it is open', async () => {
    const test = harness();
    const controller = new AbortController();
    const pending = select({
      screen: test.screen,
      items: items('a'),
      labels: LABELS,
      signal: controller.signal,
    });

    controller.abort();
    expect(await pending).toBeUndefined();
    test.screen.close();
  });

  it('answers nothing, and draws nothing at all, for a signal that already aborted', async () => {
    const test = harness();
    const controller = new AbortController();
    controller.abort();

    const chosen = await select({
      screen: test.screen,
      items: items('a'),
      labels: LABELS,
      signal: controller.signal,
    });

    expect(chosen).toBeUndefined();
    expect(test.output.text).toBe('');
    test.screen.close();
  });

  it('takes the first answer and ignores the keys after it', async () => {
    const test = harness();
    const pending = select({
      screen: test.screen,
      items: items('a', 'b'),
      labels: LABELS,
    });

    expect(await answer(test, pending, ENTER, DOWN, ENTER)).toBe('a');
    test.screen.close();
  });
});

describe('the region it leaves behind', () => {
  it('erases itself before it resolves, on every path', async () => {
    for (const last of [ENTER, ESC, CTRL_C]) {
      const test = harness();
      const pending = select({
        screen: test.screen,
        items: items('a'),
        labels: LABELS,
      });
      await answer(test, pending, last);

      // The final bytes are an erase, not a row: a menu still painted when its
      // promise settles is one the next prompt draws on top of.
      expect(test.output.text.endsWith(`${CSI}0J${CSI}?2026l`)).toBe(true);
      test.screen.close();
    }
  });

  it('draws the title and the footer around the rows', async () => {
    const test = harness();
    const pending = select({
      screen: test.screen,
      items: items('a'),
      labels: LABELS,
    });
    await flush();

    expect(test.output.text).toContain('Pick one');
    expect(test.output.text).toContain('esc cancel');

    await answer(test, pending, ESC);
    test.screen.close();
  });

  it('never draws more rows than the window can hold', async () => {
    // A menu taller than the window scrolls, and a menu that scrolled has moved
    // the ground the cursor-up is measured against.
    const test = harness({ rows: 8 });
    const pending = select({
      screen: test.screen,
      items: items('a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'),
      labels: LABELS,
      maxRows: 10,
    });
    await flush();

    const painted = test.output.text.split('\n').length;
    expect(painted).toBeLessThanOrEqual(8);

    await answer(test, pending, ESC);
    test.screen.close();
  });

  it('redraws when the window is resized under it', async () => {
    const test = harness({ rows: 20 });
    const pending = select({
      screen: test.screen,
      items: items('a', 'b', 'c'),
      labels: LABELS,
    });
    await flush();
    test.output.reset();

    test.output.resizeTo(30, 9);

    expect(test.output.text).not.toBe('');
    await answer(test, pending, ESC);
    test.screen.close();
  });
});
