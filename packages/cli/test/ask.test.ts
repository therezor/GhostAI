/**
 * The prompts, driven through a pair of streams rather than a terminal.
 *
 * `chooseMany` is what this file is really for — the other three moved here
 * unchanged from `init.ts` and are covered by `init.test.ts` driving the whole
 * wizard. What is asserted here is the parsing: every separator somebody's
 * fingers might produce, and the re-ask that stops a misspelt name from
 * silently installing three things when four were asked for.
 */

import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline/promises';

import { afterEach, describe, expect, it } from 'vitest';

import { createAsk, type Ask } from '#src/ask.js';
import { translationsFor } from '#src/i18n.js';

const t = translationsFor({ locale: 'en' }).t;

const OPTIONS = ['coder (Coder)  coding', 'lead (Team lead)', 'nano (Nano)'];

let closers: Array<() => void> = [];

afterEach(() => {
  for (const close of closers) close();
  closers = [];
});

/**
 * An `Ask` that answers with `lines`, and the text it wrote out.
 *
 * Reactively, not all at once, for the reason `init.test.ts` documents:
 * readline in terminal mode reads input as keypresses, so a buffer written
 * before the question is asked delivers its first line and swallows the rest.
 * A re-ask needs the second line to survive, which is most of what this file
 * is about.
 */
function asking(...lines: readonly string[]): {
  ask: Ask;
  written: () => string;
} {
  const input = new PassThrough() as PassThrough & { isTTY?: boolean };
  input.isTTY = true;
  const output = new PassThrough();

  let written = '';
  let sinceAnswer = '';
  let next = 0;
  output.on('data', (chunk: Buffer) => {
    const text = chunk.toString();
    written += text;
    sinceAnswer += text;
    // A prompt is a line ending in `": "`, once the cursor escapes readline
    // emits around it are taken out.
    // eslint-disable-next-line no-control-regex -- the escapes are the subject
    const plain = sinceAnswer.replace(/\[[0-9;]*[A-Za-z]/g, '');
    if (!plain.endsWith(': ') || next >= lines.length) return;
    const answer = lines[next];
    next += 1;
    sinceAnswer = '';
    setImmediate(() => input.write(`${answer ?? ''}\n`));
  });

  const rl = createInterface({ input, output, terminal: true });
  closers.push(() => {
    rl.close();
  });

  return { ask: createAsk(rl, output, false, t), written: () => written };
}

describe('chooseMany', () => {
  it('takes numbers separated by spaces or commas, or both', async () => {
    for (const answer of ['1 3', '1,3', '1, 3', ' 1  ,3 ']) {
      const { ask } = asking(answer);
      expect(await ask.chooseMany('Which?', OPTIONS)).toEqual([0, 2]);
    }
  });

  it('takes names, matched by prefix exactly as `choose` does', async () => {
    const { ask } = asking('nano coder');

    // Sorted by index, not by the order they were typed: the caller uses this
    // to order installs, and "as typed" would make `install b a` and
    // `install a b` two different runs.
    expect(await ask.chooseMany('Which?', OPTIONS)).toEqual([0, 2]);
  });

  it('takes `all`, which is what somebody wanting the lot types first', async () => {
    const { ask } = asking('all');

    expect(await ask.chooseMany('Which?', OPTIONS)).toEqual([0, 1, 2]);
  });

  it('takes an empty line as none, which is how the question is declined', async () => {
    const { ask } = asking('');

    expect(await ask.chooseMany('Which?', OPTIONS)).toEqual([]);
  });

  it('names a repeat once', async () => {
    const { ask } = asking('1 1 coder');

    expect(await ask.chooseMany('Which?', OPTIONS)).toEqual([0]);
  });

  it('re-asks rather than dropping what it could not read', async () => {
    // Selecting three things and getting two because one was misspelt is
    // invisible until much later, when the agent that was supposed to exist
    // does not.
    const { ask, written } = asking('1 ghost 3', '1 3');

    expect(await ask.chooseMany('Which?', OPTIONS)).toEqual([0, 2]);
    expect(written()).toContain('“ghost” is not one of these');
  });

  it('refuses a number outside the list', async () => {
    const { ask, written } = asking('9', '2');

    expect(await ask.chooseMany('Which?', OPTIONS)).toEqual([1]);
    expect(written()).toContain('“9” is not one of these');
  });

  it('annotates a row without making the annotation typeable', async () => {
    // `[installed]` is a mark, not part of the name — matching on it would let
    // one word select every installed agent at once.
    const { ask, written } = asking('installed', '2');

    expect(
      await ask.chooseMany('Which?', OPTIONS, ['[installed]', '', '']),
    ).toEqual([1]);
    expect(written()).toContain('[installed]');
    expect(written()).toContain('is not one of these');
  });
});
