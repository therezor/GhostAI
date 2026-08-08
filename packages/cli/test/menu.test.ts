import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';

import type { TerminalInput, TerminalOutput } from '@ghostbot/tui';

import { createMenu, menuAvailable, NO_MENU } from '#src/menu.js';

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

describe('createMenu', () => {
  it('hands the request to whoever owns the frame, and answers what it says', async () => {
    // A menu is rows in the frame now, not a region of its own — so this file
    // knows only that a menu can be shown and eventually answers. Where those
    // rows go is the caller's, because only it knows what else is on screen.
    const seen: string[] = [];
    const menu = createMenu({
      open: <T>(request: {
        items: ReadonlyArray<{ value: T; label: string }>;
      }): Promise<T | undefined> => {
        seen.push(...request.items.map((item) => item.label));
        return Promise.resolve(request.items[1]?.value);
      },
    });

    expect(menu.available).toBe(true);
    expect(
      await menu.choose({
        items: [
          { value: 'a', label: 'Default' },
          { value: 'b', label: 'Research' },
        ],
        labels: { title: 't', empty: 'e', footer: 'f' },
      }),
    ).toBe('b');
    expect(seen).toEqual(['Default', 'Research']);
  });

  it('passes a cancelled menu straight back', () => {
    const menu = createMenu({ open: () => Promise.resolve(undefined) });

    return expect(
      menu.choose({
        items: [{ value: 'a', label: 'a' }],
        labels: { title: 't', empty: 'e', footer: 'f' },
      }),
    ).resolves.toBeUndefined();
  });
});
