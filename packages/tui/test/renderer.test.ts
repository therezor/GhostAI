import { CURSOR_MARKER, type Component } from '#src/component.js';
import { createRenderer } from '#src/renderer.js';
import { fakeOutput } from '#testkit/terminal.js';
import { describe, expect, it } from 'vitest';

const ESC = String.fromCharCode(27);
/** `\x1b[<n>A` and friends, built without a control character in the source. */
const move = (letter: string): RegExp =>
  new RegExp(`${ESC}\\[(\\d+)${letter}`, 'g');

const ups = (text: string): number[] =>
  [...text.matchAll(move('A'))].map((match) => Number(match[1]));
const downs = (text: string): number[] =>
  [...text.matchAll(move('B'))].map((match) => Number(match[1]));

/** A component that always draws the same rows. */
function fixed(lines: readonly string[]): Component {
  return { render: () => lines };
}

/** A component whose rows the test can change between renders. */
function mutable(initial: readonly string[]): {
  component: Component;
  set(lines: readonly string[]): void;
} {
  let lines = initial;
  return {
    component: { render: () => lines },
    set(next): void {
      lines = next;
    },
  };
}

describe('the first frame', () => {
  it('prints its rows and claims no more of the screen than it used', () => {
    const out = fakeOutput({ columns: 20, rows: 10 });
    const renderer = createRenderer({ output: out });
    renderer.setRoot(fixed(['one', 'two', 'three']));
    renderer.render();

    expect(out.text).toContain('one\r\ntwo\r\nthree');
    // Nothing is erased on the way in, unless the caller asked for it. This is
    // the library's default and it is the right one: a renderer drawing four
    // rows of a picker under a shell prompt has no business erasing what the
    // shell printed. `clearOnFirstFrame` is how a caller that owns the window
    // says otherwise — see below.
    expect(out.text).not.toContain(`${ESC}[2J`);
  });

  it('takes the screen when the caller asked for it, and not the history', () => {
    const out = fakeOutput({ columns: 20, rows: 10 });
    const renderer = createRenderer({ output: out, clearOnFirstFrame: true });
    renderer.setRoot(fixed(['one', 'two', 'three']));
    renderer.render();

    expect(out.text).toContain(`${ESC}[2J`);
    expect(out.text).toContain(`${ESC}[H`);
    // `3J` erases the scrollback *buffer*, and a resize sends it because a
    // rewrap can strand fragments of this renderer's own frame up there. On the
    // first frame there is nothing of ours to strand, so all it would erase is
    // the operator's shell history.
    expect(out.text).not.toContain(`${ESC}[3J`);
  });

  it('clears once, not on every frame after it', () => {
    const out = fakeOutput({ columns: 20, rows: 10 });
    const renderer = createRenderer({ output: out, clearOnFirstFrame: true });
    const view = mutable(['one', 'two', 'three']);
    renderer.setRoot(view.component);
    renderer.render();

    out.reset();
    view.set(['one', 'two', 'THREE']);
    renderer.render();

    expect(out.text).not.toContain(`${ESC}[2J`);
    expect(out.text).toContain('THREE');
    expect(renderer.fullRedraws).toBe(1);
  });

  it('puts the terminal cursor where the marker was', () => {
    const out = fakeOutput({ columns: 20, rows: 10 });
    const renderer = createRenderer({ output: out });
    renderer.setRoot(fixed(['head', `› ab${CURSOR_MARKER}`, 'foot']));
    renderer.render();

    // Up from the last row it wrote to the editor row, then along to the caret.
    expect(ups(out.text)).toEqual([1]);
    expect(out.text).toContain(`\r${ESC}[4C`);
    expect(out.text).not.toContain(CURSOR_MARKER);
  });
});

describe('a frame that changed', () => {
  it('rewrites only the rows that differ', () => {
    const out = fakeOutput({ columns: 20, rows: 10 });
    const renderer = createRenderer({ output: out });
    const view = mutable(['one', 'two', 'three']);
    renderer.setRoot(view.component);
    renderer.render();

    out.reset();
    view.set(['one', 'two', 'CHANGED']);
    renderer.render();

    expect(out.text).toContain('CHANGED');
    // The rows above it are not touched, which is what makes a keystroke cost
    // the editor row rather than the length of the conversation.
    expect(out.text).not.toContain('one');
    expect(out.text).not.toContain('two');
  });

  it('stops at the last row that differs, not at the bottom of the frame', () => {
    // A spinner changes one row ten times a second. Running to the bottom would
    // repaint the rules and the status bar with it — six rows of traffic for a
    // one-row change, which is what flicker is made of.
    const out = fakeOutput({ columns: 20, rows: 10 });
    const renderer = createRenderer({ output: out });
    const view = mutable(['spin', 'rule', 'editor', 'status']);
    renderer.setRoot(view.component);
    renderer.render();

    out.reset();
    view.set(['SPUN', 'rule', 'editor', 'status']);
    renderer.render();

    expect(out.text).toContain('SPUN');
    expect(out.text).not.toContain('rule');
    expect(out.text).not.toContain('status');
  });

  it('erases the rows a shorter frame no longer has', () => {
    const out = fakeOutput({ columns: 20, rows: 10 });
    const renderer = createRenderer({ output: out });
    const view = mutable(['one', 'two', 'three']);
    renderer.setRoot(view.component);
    renderer.render();

    out.reset();
    view.set(['one']);
    renderer.render();

    expect(out.text).toContain(`${ESC}[0J`);
  });

  it('makes the rows a grown frame needs instead of moving onto ones that exist', () => {
    // The case every turn hits: the transcript gains rows while the frame is
    // already filling the screen. `CUD` past the bottom row does nothing at
    // all — only a newline scrolls — so reaching for the new rows that way
    // writes them over the last old one.
    const out = fakeOutput({ columns: 20, rows: 5 });
    const renderer = createRenderer({ output: out });
    const view = mutable(['one', 'two', 'three', 'four', 'five']);
    renderer.setRoot(view.component);
    renderer.render();

    out.reset();
    view.set(['one', 'two', 'three', 'four', 'five', 'six', 'seven']);
    renderer.render();

    expect(out.text).toContain('six');
    expect(out.text).toContain('seven');
    expect(out.text).not.toContain(`${ESC}[1B`);
    // And the last old row is still the last old row, not overwritten by the
    // first new one.
    expect(out.text).not.toContain('five');
  });

  it('writes nothing but a cursor move when nothing changed', () => {
    const out = fakeOutput({ columns: 20, rows: 10 });
    const renderer = createRenderer({ output: out });
    renderer.setRoot(fixed(['one', 'two']));
    renderer.render();

    out.reset();
    renderer.render();

    expect(out.text).not.toContain('one');
    expect(out.text).not.toContain('two');
  });
});

describe('a window that changed size', () => {
  // The bug this whole design exists for. A terminal rewraps its own screen
  // before the process is told anything, so the rows a program drew are no
  // longer where it left them — some of them above the cursor, where no erase
  // can reach. Patching is not available; reprinting is.
  it('prints the whole frame again rather than patching it', () => {
    const out = fakeOutput({ columns: 40, rows: 10 });
    const renderer = createRenderer({ output: out });
    renderer.setRoot({
      render: (width) => ['head', '-'.repeat(width), 'foot'],
    });
    renderer.render();
    const before = renderer.fullRedraws;

    out.reset();
    out.resizeTo(20, 10);
    renderer.render();

    expect(renderer.fullRedraws).toBe(before + 1);
    expect(out.text).toContain(`${ESC}[2J${ESC}[H`);
    expect(out.text).toContain('head');
    expect(out.text).toContain('foot');
    expect(out.text).toContain('-'.repeat(20));
  });

  it('drops the scrollback, because the reflow may have put a fragment there', () => {
    // A narrowing can push the top of the old frame out of the viewport, and
    // erasing only what is on screen leaves that fragment above the new frame —
    // one copy per resize. Nothing the program can ask says whether it
    // happened, so the erase has to assume it did.
    const out = fakeOutput({ columns: 40, rows: 24 });
    const renderer = createRenderer({ output: out });
    renderer.setRoot(fixed(['head', 'foot']));
    renderer.render();

    out.reset();
    out.resizeTo(20, 24);
    renderer.render();

    expect(out.text).toContain(`${ESC}[3J`);
  });

  it('moves by the same amount at every width, in both directions', () => {
    // The property the old footer could not hold. A frame whose height is a
    // function of the window width makes every cursor move a guess; asserting
    // the number would only pin today's arithmetic, so what is asserted is that
    // the number does not move.
    const out = fakeOutput({ columns: 120, rows: 30 });
    const renderer = createRenderer({ output: out });
    renderer.setRoot({
      render: (width) => [
        'transcript',
        '-'.repeat(width),
        `› typing${CURSOR_MARKER}`,
        '='.repeat(width),
      ],
    });
    renderer.render();

    const moves: number[] = [];
    for (const width of [80, 120, 60, 120, 40]) {
      out.reset();
      out.resizeTo(width, 30);
      renderer.render();
      moves.push(...ups(out.text), ...downs(out.text));
    }

    expect(new Set(moves).size).toBe(1);
  });
});

describe('when it draws', () => {
  it('coalesces a burst of requests into one frame', async () => {
    // A streaming turn asks for a render per token. Drawing each one would be
    // one frame per word arriving.
    const out = fakeOutput({ columns: 20, rows: 10 });
    const renderer = createRenderer({ output: out });
    const view = mutable(['one']);
    renderer.setRoot(view.component);
    renderer.render();

    out.reset();
    view.set(['two']);
    renderer.requestRender();
    renderer.requestRender();
    renderer.requestRender();
    await Promise.resolve();

    expect(out.text.split('two')).toHaveLength(2);
  });

  it('sends the cursor mode only when it actually changes', () => {
    // A spinner repaints ten times a second, and a terminal taking DECTCEM on
    // every frame is doing ten times the work for no change.
    const out = fakeOutput({ columns: 20, rows: 10 });
    const renderer = createRenderer({ output: out });
    renderer.setRoot(fixed(['one']));
    renderer.render();

    out.reset();
    renderer.setCursorVisible(true);
    expect(out.text).toBe('');

    renderer.setCursorVisible(false);
    renderer.setCursorVisible(false);
    expect(out.text).toBe(`${ESC}[?25l`);
  });
});

describe('giving the terminal back', () => {
  it('shows the cursor and leaves it below the frame', () => {
    const out = fakeOutput({ columns: 20, rows: 10 });
    const renderer = createRenderer({ output: out });
    renderer.setRoot(fixed(['one', 'two']));
    renderer.render();

    out.reset();
    renderer.stop();

    expect(out.text).toContain(`${ESC}[?25h`);
    expect(out.text.endsWith('\r\n' + `${ESC}[?25h`)).toBe(true);
  });

  it('draws nothing once stopped, however often it is asked', () => {
    const out = fakeOutput({ columns: 20, rows: 10 });
    const renderer = createRenderer({ output: out });
    renderer.setRoot(fixed(['one']));
    renderer.render();
    renderer.stop();

    out.reset();
    renderer.stop();
    renderer.render();

    expect(out.text).toBe('');
  });
});
