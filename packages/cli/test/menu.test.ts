import { createInterface, type Interface } from 'node:readline/promises';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';

import {
  PLAIN_THEME,
  type TerminalInput,
  type TerminalOutput,
} from '@ghostai/tui';

import {
  createMenu,
  menuAvailable,
  suspendReadline,
  NO_MENU,
} from '#src/menu.js';

const ESC = String.fromCharCode(27);
const DOWN = `${ESC}[B`;
const ENTER = '\r';

/** A stdin that claims to be a terminal, which is what readline needs. */
function fakeInput(options: { isTTY?: boolean } = {}): TerminalInput {
  return Object.assign(new PassThrough(), {
    isTTY: options.isTTY ?? true,
    setRawMode(): void {
      /* a PassThrough has no mode to set */
    },
  });
}

function fakeOutput(
  options: { isTTY?: boolean; columns?: number } = {},
): TerminalOutput & { text: string } {
  const stream = new PassThrough();
  let text = '';
  const out = Object.assign(stream, {
    isTTY: options.isTTY ?? true,
    columns: options.columns ?? 40,
    rows: 24,
    write(chunk: unknown): boolean {
      text += String(chunk);
      return true;
    },
  });
  Object.defineProperty(out, 'text', { get: (): string => text });
  return out as unknown as TerminalOutput & { text: string };
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

interface Repl {
  readonly input: TerminalInput & { write(data: string): unknown };
  readonly output: TerminalOutput & { text: string };
  readonly rl: Interface;
}

function repl(): Repl {
  const input = fakeInput();
  const output = fakeOutput();
  const rl = createInterface({ input, output, terminal: true });
  return { input: input as Repl['input'], output, rl };
}

describe('menuAvailable', () => {
  it('says yes for a terminal on both ends', () => {
    expect(
      menuAvailable({
        input: fakeInput(),
        output: fakeOutput(),
        json: false,
        env: {},
      }),
    ).toBe(true);
  });

  it('says no when stdin is a pipe', () => {
    expect(
      menuAvailable({
        input: fakeInput({ isTTY: false }),
        output: fakeOutput(),
        json: false,
        env: {},
      }),
    ).toBe(false);
  });

  it('says no when stdout is a pipe', () => {
    expect(
      menuAvailable({
        input: fakeInput(),
        output: fakeOutput({ isTTY: false }),
        json: false,
        env: {},
      }),
    ).toBe(false);
  });

  it('says no under --json, whose stdout carries one event per line and nothing else', () => {
    expect(
      menuAvailable({
        input: fakeInput(),
        output: fakeOutput(),
        json: true,
        env: {},
      }),
    ).toBe(false);
  });

  it('says no on a dumb terminal, which prints escape sequences as text', () => {
    // Node's own readline makes the same check before it does any cursor work.
    // Emacs' `M-x shell` is the case that actually happens.
    expect(
      menuAvailable({
        input: fakeInput(),
        output: fakeOutput(),
        json: false,
        env: { TERM: 'dumb' },
      }),
    ).toBe(false);
  });

  it('says yes for a terminal that reports no size, which a recorded pty does', () => {
    // Zero is not nullish, so the naive `?? MIN_COLUMNS` refused to draw a menu
    // on a terminal that was perfectly capable of showing one.
    expect(
      menuAvailable({
        input: fakeInput(),
        output: fakeOutput({ columns: 0 }),
        json: false,
        env: {},
      }),
    ).toBe(true);
  });

  it('says no in a window too narrow to hold a label beside a cursor marker', () => {
    expect(
      menuAvailable({
        input: fakeInput(),
        output: fakeOutput({ columns: 8 }),
        json: false,
        env: {},
      }),
    ).toBe(false);
  });
});

describe('NO_MENU', () => {
  it('answers nothing and reports itself unavailable', async () => {
    // What every scripted path gets by construction, rather than by an `if`
    // somebody has to remember to write.
    expect(NO_MENU.available).toBe(false);
    expect(
      await NO_MENU.choose({
        items: [{ value: 'a', label: 'a' }],
        labels: { title: 't', empty: 'e', footer: 'f' },
      }),
    ).toBeUndefined();
  });
});

describe('suspendReadline', () => {
  it('keeps typed bytes out of readline while it is suspended', async () => {
    const { input, rl } = repl();
    const pending = rl.question('> ');
    input.write('par');
    await flush();

    const handover = suspendReadline(rl, input);
    input.resume();
    input.write('xyz');
    await flush();

    // The buffer either took the keys or it did not; there is nothing timing
    // dependent about which.
    expect(rl.line).toBe('par');

    handover.release();
    rl.write(null, { name: 'return' });
    expect(await pending).toBe('par');
    rl.close();
  });

  it('leaves the pending question able to resolve afterwards', async () => {
    const { input, rl } = repl();
    const pending = rl.question('> ');

    suspendReadline(rl, input).release();

    rl.write('after');
    rl.write(null, { name: 'return' });
    expect(await pending).toBe('after');
    rl.close();
  });

  it('restores readline exactly once, however many times it is released', async () => {
    // A `Screen` closed by both its own `finally` and the exit hook would
    // otherwise put the listener back twice and make readline see every
    // keystroke in duplicate.
    const { input, rl } = repl();
    const pending = rl.question('> ');
    const before = input.listenerCount('keypress');

    const handover = suspendReadline(rl, input);
    handover.release();
    handover.release();

    expect(input.listenerCount('keypress')).toBe(before);

    rl.write('x');
    await flush();
    expect(rl.line).toBe('x');

    rl.write(null, { name: 'return' });
    await pending;
    rl.close();
  });
});

describe('what readline does with a resize', () => {
  // The status bar's resize handling is split around this, so it is worth
  // pinning rather than remembering: readline registers exactly one `resize`
  // listener on the output, and it refreshes the line — up over the rows it
  // believes it drew, clear to the end of the display, write it again.
  //
  // The new prompt therefore has to be handed over *before* that listener runs,
  // and the bar redrawn *after* it. Asking readline for a second refresh
  // instead is what made transcript lines disappear: each refresh moves up by a
  // row count measured before the width changed, so two of them clear their way
  // up into the conversation.
  it('registers exactly one listener, which our two can be ordered around', async () => {
    const { input, output, rl } = repl();
    expect(output.listenerCount('resize')).toBe(1);

    const order: string[] = [];
    output.prependListener('resize', () => order.push('before'));
    output.on('resize', () => order.push('after'));

    const pending = rl.question('> ');
    input.write('typed');
    await flush();
    output.emit('resize');
    await flush();

    expect(order).toEqual(['before', 'after']);

    rl.write(null, { name: 'return' });
    await pending;
    rl.close();
  });
});

describe('createMenu', () => {
  it('draws a menu over a live prompt and answers what was chosen', async () => {
    const { input, output, rl } = repl();
    const menu = createMenu({
      input,
      output,
      rl,
      theme: PLAIN_THEME,
      onExit: () => {
        /* the test owns the process; nothing to register on it */
      },
    });

    const pending = rl.question('> ');
    const chosen = menu.choose({
      items: [
        { value: 'first', label: 'first' },
        { value: 'second', label: 'second' },
      ],
      labels: { title: 'Pick', empty: 'none', footer: 'esc cancels' },
    });

    input.write(DOWN);
    await flush();
    input.write(ENTER);
    expect(await chosen).toBe('second');

    // And the prompt is still there, unharmed, with its own buffer intact.
    rl.write('typed after');
    rl.write(null, { name: 'return' });
    expect(await pending).toBe('typed after');
    rl.close();
  });

  it('gives the prompt its stdin back after a cancelled menu too', async () => {
    const { input, output, rl } = repl();
    const menu = createMenu({
      input,
      output,
      rl,
      theme: PLAIN_THEME,
      onExit: () => {
        /* the test owns the process; nothing to register on it */
      },
    });

    const pending = rl.question('> ');
    const chosen = menu.choose({
      items: [{ value: 'a', label: 'a' }],
      labels: { title: 'Pick', empty: 'none', footer: 'esc cancels' },
    });

    input.write(ESC);
    expect(await chosen).toBeUndefined();

    rl.write('still works');
    rl.write(null, { name: 'return' });
    expect(await pending).toBe('still works');
    rl.close();
  });

  it('registers a last-resort restore, because raw mode has no echo to recover with', async () => {
    // A process that dies inside a menu leaves the operator typing `stty sane`
    // blind. `select`'s own `finally` covers every ordinary path; this is the
    // rest.
    const { input, output, rl } = repl();
    let restore: (() => void) | undefined;
    createMenu({
      input,
      output,
      rl,
      theme: PLAIN_THEME,
      onExit: (handler) => {
        restore = handler;
      },
    });

    expect(restore).toBeDefined();
    // Safe with no menu open, which is the state it will usually find.
    expect(() => restore?.()).not.toThrow();
    rl.close();
  });

  it('erases the menu before it hands the prompt back', async () => {
    const { input, output, rl } = repl();
    const menu = createMenu({
      input,
      output,
      rl,
      theme: PLAIN_THEME,
      onExit: () => {
        /* the test owns the process; nothing to register on it */
      },
    });

    const pending = rl.question('> ');
    const chosen = menu.choose({
      items: [{ value: 'a', label: 'a' }],
      labels: { title: 'Pick', empty: 'none', footer: 'esc cancels' },
    });
    input.write(ENTER);
    await chosen;

    // An erase-to-end-of-display is the last thing the menu wrote; a menu still
    // painted when its promise settles is one the next prompt draws on top of.
    expect(output.text).toContain(`${ESC}[0J`);

    rl.write(null, { name: 'return' });
    await pending;
    rl.close();
  });
});
