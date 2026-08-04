import { PassThrough } from 'node:stream';
import { PLAIN_THEME, type InputHandover } from '@ghostai/tui';
import { describe, expect, it } from 'vitest';

import {
  createGeneration,
  NO_GENERATION,
  type Generation,
} from '#src/generation.js';
import { translations } from '#src/i18n.js';

const { t } = translations('en');
const ESC = String.fromCharCode(27);
const ENTER = '\r';
const CTRL_C = String.fromCharCode(3);
const BACKSPACE = String.fromCharCode(127);

interface Harness {
  readonly generation: Generation;
  readonly input: PassThrough;
  /** Every footer the bar was asked to draw, newest last. */
  readonly footers: string[][];
  /** Everything written into the transcript above the footer. */
  readonly written: string[];
  readonly released: () => number;
  readonly interrupts: () => number;
  /** Advances the spinner by one frame, the way the real interval would. */
  readonly tick: () => void;
  readonly sink: () => ((text: string) => void) | undefined;
}

function harness(): Harness {
  const input = new PassThrough();
  const footers: string[][] = [];
  const written: string[] = [];
  let released = 0;
  let interrupts = 0;
  let ticker: (() => void) | undefined;
  let sink: ((text: string) => void) | undefined;

  const generation = createGeneration({
    input,
    bar: {
      writeAbove: (text, lines) => {
        written.push(text);
        footers.push([...lines]);
      },
      repaint: (lines) => {
        footers.push([...lines]);
      },
      clear: () => {
        /* nothing is on screen to erase in a bar made of arrays */
      },
    },
    suspend: (): InputHandover => ({
      release: () => {
        released += 1;
      },
    }),
    inputRule: () => '────',
    status: () => ['────', 'Default   default', '1.0%/66k  ollama/qwen3'],
    setSink: (next) => {
      sink = next;
    },
    interrupt: () => {
      interrupts += 1;
    },
    theme: PLAIN_THEME,
    t,
    ticker: (advance) => {
      ticker = advance;
      return () => {
        ticker = undefined;
      };
    },
  });

  return {
    generation,
    input,
    footers,
    written,
    released: () => released,
    interrupts: () => interrupts,
    tick: () => {
      ticker?.();
    },
    sink: () => sink,
  };
}

/** Lets the stream deliver what was just typed. */
async function typed(input: PassThrough, data: string): Promise<void> {
  input.write(data);
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

/** A body that stays pending until it is told to finish. */
function pending(): { body: () => Promise<string>; finish: () => void } {
  let done: (value: string) => void = () => {
    /* replaced by the executor, which runs before this can be called */
  };
  const promise = new Promise<string>((resolve) => {
    done = resolve;
  });
  return {
    body: () => promise,
    finish: () => {
      done('done');
    },
  };
}

describe('the frame while a turn runs', () => {
  it('draws the editor and the status under the streaming answer', async () => {
    const test = harness();
    const turn = pending();
    const run = test.generation.run(turn.body);

    const footer = test.footers.at(-1);
    expect(footer).toContain('› ');
    expect(footer).toContain('Default   default');
    // Two rules: one above the editor and one under it, the same frame the
    // idle prompt has.
    expect(footer?.filter((line) => line === '────')).toHaveLength(2);

    turn.finish();
    await run;
  });

  it('shows the indicator until the first output, and not after', async () => {
    // "Has it started" is the question it answers. Once the answer itself is
    // arriving, the answer is the better sign.
    const test = harness();
    const turn = pending();
    const run = test.generation.run(turn.body);

    expect(test.footers.at(-1)?.[0]).toContain('generating…');

    test.sink()?.('the parser is');
    expect(test.footers.at(-1)?.[0]).not.toContain('generating…');

    turn.finish();
    await run;
  });

  it('animates the indicator without a clock of its own', async () => {
    const test = harness();
    const turn = pending();
    const run = test.generation.run(turn.body);

    const first = test.footers.at(-1)?.[0];
    test.tick();
    expect(test.footers.at(-1)?.[0]).not.toBe(first);

    turn.finish();
    await run;
  });

  it('routes the turn output through the footer rather than straight out', async () => {
    const test = harness();
    const turn = pending();
    const run = test.generation.run(turn.body);

    expect(test.sink()).toBeDefined();
    test.sink()?.('an answer');
    expect(test.written).toEqual(['an answer']);

    turn.finish();
    await run;
    // And handed back afterwards, so a prompt writes to the terminal directly.
    expect(test.sink()).toBeUndefined();
  });
});

describe('typing while it runs', () => {
  it('shows what is typed in the editor', async () => {
    const test = harness();
    const turn = pending();
    const run = test.generation.run(turn.body);

    await typed(test.input, 'and the lexer');

    expect(test.footers.at(-1)).toContain('› and the lexer');
    turn.finish();
    await run;
  });

  it('deletes what a person can see on Backspace', async () => {
    const test = harness();
    const turn = pending();
    const run = test.generation.run(turn.body);

    await typed(test.input, 'ab🚀');
    await typed(test.input, BACKSPACE);

    expect(test.footers.at(-1)).toContain('› ab');
    turn.finish();
    await run;
  });

  it('queues a submitted message, and runs it as the next turn', async () => {
    const test = harness();
    const turn = pending();
    const run = test.generation.run(turn.body);

    await typed(test.input, `and the lexer${ENTER}`);
    // Cleared from the editor the moment it is queued, so the operator can see
    // it was taken.
    expect(test.footers.at(-1)).toContain('› ');

    turn.finish();
    await run;
    expect(test.generation.takeQueued()).toBe('and the lexer');
    // Taken once, not every time it is asked.
    expect(test.generation.takeQueued()).toBeUndefined();
  });

  it('ignores an empty submission rather than queueing a blank turn', async () => {
    const test = harness();
    const turn = pending();
    const run = test.generation.run(turn.body);

    await typed(test.input, `   ${ENTER}`);

    turn.finish();
    await run;
    expect(test.generation.takeQueued()).toBeUndefined();
  });

  it('hands a half-written message back rather than throwing it away', async () => {
    // The prompt that opens next is readline's, so it goes back as text for the
    // editor to be pre-filled with.
    const test = harness();
    const turn = pending();
    const run = test.generation.run(turn.body);

    await typed(test.input, 'half writ');

    turn.finish();
    await run;
    expect(test.generation.takePartial()).toBe('half writ');
    expect(test.generation.takePartial()).toBeUndefined();
  });

  it('interrupts the turn on Ctrl-C, which raw mode delivers as a byte', async () => {
    // The terminal stops turning it into SIGINT, and readline — which would
    // otherwise have raised one — is suspended for the duration.
    const test = harness();
    const turn = pending();
    const run = test.generation.run(turn.body);

    await typed(test.input, CTRL_C);

    expect(test.interrupts()).toBe(1);
    turn.finish();
    await run;
  });

  it('ignores a key it has no meaning for', async () => {
    const test = harness();
    const turn = pending();
    const run = test.generation.run(turn.body);

    await typed(test.input, `${ESC}[A`);

    expect(test.footers.at(-1)).toContain('› ');
    turn.finish();
    await run;
  });
});

describe('giving everything back', () => {
  it('returns stdin and the sink when the turn ends', async () => {
    const test = harness();
    const turn = pending();
    const run = test.generation.run(turn.body);
    turn.finish();
    await run;

    expect(test.released()).toBe(1);
    expect(test.sink()).toBeUndefined();
    expect(test.input.listenerCount('data')).toBe(0);
  });

  it('returns them when the turn throws, too', async () => {
    const test = harness();
    await expect(
      test.generation.run(() => Promise.reject(new Error('boom'))),
    ).rejects.toThrow('boom');

    expect(test.released()).toBe(1);
    expect(test.sink()).toBeUndefined();
  });
});

describe('NO_GENERATION', () => {
  it('runs the body and holds nothing', async () => {
    // What a pipe and `--json` get, by construction rather than by an `if`.
    expect(await NO_GENERATION.run(() => Promise.resolve(7))).toBe(7);
    expect(NO_GENERATION.takeQueued()).toBeUndefined();
    expect(NO_GENERATION.takePartial()).toBeUndefined();
  });
});
