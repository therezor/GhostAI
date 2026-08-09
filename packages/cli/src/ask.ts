/**
 * Asking a question on a terminal, without a prompt library.
 *
 * Lifted out of `init.ts` when `preset.ts` needed the same four helpers. The
 * argument `init.ts` made for hand-rolling them still holds and is the reason
 * this file exists rather than a dependency: `chat.ts` already drives
 * `node:readline/promises` with an `AbortSignal`, and a package whose whole
 * point is that `ghostai --help` loads almost nothing does not buy a prompt
 * library for a numbered list.
 *
 * Everything takes its streams as arguments, so a test drives it without a
 * terminal — and everything is bound to **one** readline interface, which is
 * the constraint that shaped the seam. Two interfaces on one stdin fight over
 * keypresses, so a command that already holds one passes its own `Ask` down
 * rather than letting the code below open a second.
 */

import type { Interface } from 'node:readline/promises';

import pc from 'picocolors';

import type { CliT } from './i18n.js';

/** An `Ask` with the reader behind it, which the caller has to close. */
export interface OpenAsk {
  readonly ask: Ask;
  readonly close: () => void;
}

/**
 * One reader for a whole command, rather than one per question.
 *
 * The reader this replaced was opened and closed around a single `confirm`,
 * which worked because `ghost install` asked exactly one question. A command
 * that asks two — which agents, then whether to approve their boxes — cannot
 * do that: node keeps the process alive while a readline interface is open, so
 * a reader per question either leaks one or closes stdin under the next
 * question. Hence a lifetime the caller owns, and a `close` it must run in a
 * `finally`.
 *
 * `node:readline/promises` is imported dynamically for the reason `program.ts`
 * imports everything dynamically: `ghostai --help` must not pay for it.
 */
export async function openAsk(
  input: NodeJS.ReadableStream & { isTTY?: boolean },
  out: NodeJS.WritableStream,
  colors: boolean | undefined,
  t: CliT,
): Promise<OpenAsk> {
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input, output: out, terminal: true });
  return {
    ask: createAsk(rl, out, colors, t),
    close: () => {
      rl.close();
    },
  };
}

/** The prompts, bound to one readline interface and one colour setting. */
export interface Ask {
  /** A free-text answer, with `fallback` used for an empty line. */
  text(question: string, fallback?: string): Promise<string>;
  /** Reads without echoing, so a key does not land in the scrollback. */
  secret(question: string): Promise<string>;
  /** A numbered list. Returns the chosen index. */
  choose(
    question: string,
    options: readonly string[],
    fallbackIndex?: number,
  ): Promise<number>;
  /** A numbered list, any number of them. Returns the chosen indices, sorted. */
  chooseMany(
    question: string,
    options: readonly string[],
    marks?: readonly string[],
  ): Promise<readonly number[]>;
  confirm(question: string, fallback: boolean): Promise<boolean>;
}

export function createAsk(
  rl: Interface,
  out: NodeJS.WritableStream,
  colors: boolean | undefined,
  t: CliT,
): Ask {
  const c = pc.createColors(colors);

  const text = async (question: string, fallback?: string): Promise<string> => {
    const suffix =
      fallback === undefined || fallback === '' ? '' : c.dim(` [${fallback}]`);
    const answer = (await rl.question(`${question}${suffix}: `)).trim();
    return answer === '' ? (fallback ?? '') : answer;
  };

  return {
    text,

    secret: async (question: string): Promise<string> => {
      // readline has no masked read, and `_writeToOutput` is the documented
      // seam for one — the alternative is a key sitting in the terminal's
      // scrollback for the rest of the session. Swapping the *interface's*
      // writer rather than the stream's matters: readline holds its own
      // reference to the output stream, and replacing `write` underneath it
      // deadlocks the very question being asked.
      const internal = rl as Interface & {
        // The leading underscore is node's, not ours: this is the name on
        // `readline.Interface`, so the guide's rule has nothing to bite on.
        // eslint-disable-next-line @typescript-eslint/naming-convention
        _writeToOutput?: (text: string) => void;
      };
      const original = internal._writeToOutput?.bind(internal);
      let masked = false;

      internal._writeToOutput = (text: string): void => {
        if (!masked) {
          original?.(text);
          return;
        }
        // The prompt itself still has to be drawn, or the line is invisible;
        // only what was typed after it is withheld.
        if (text.includes(question)) original?.(text);
      };

      try {
        const promise = rl.question(`${question}: `);
        masked = true;
        return (await promise).trim();
      } finally {
        masked = false;
        if (original === undefined) delete internal._writeToOutput;
        else internal._writeToOutput = original;
        out.write('\n');
      }
    },

    choose: async (
      question: string,
      options: readonly string[],
      fallbackIndex = 0,
    ): Promise<number> => {
      for (const [index, option] of options.entries()) {
        out.write(`  ${c.dim(String(index + 1).padStart(2))}  ${option}\n`);
      }
      for (;;) {
        const answer = await text(question, String(fallbackIndex + 1));
        const index = Number(answer) - 1;
        if (Number.isInteger(index) && index >= 0 && index < options.length) {
          return index;
        }
        // By name as well as by number: an operator who types `ollama` has
        // answered the question, and refusing it would be pedantry.
        const named = options.findIndex((option) =>
          option.toLowerCase().startsWith(answer.toLowerCase()),
        );
        if (answer !== '' && named >= 0) return named;
        out.write(
          c.yellow(`  ${t('init.enterNumber', { max: options.length })}\n`),
        );
      }
    },

    /**
     * The same numbered list, answered with any number of entries.
     *
     * `choose` with a loop around it was the other option and is worse for the
     * question this exists for: picking six agents out of eight is six prompts
     * and six redraws, and there is no way to see what you have already ticked.
     * One line answers it.
     *
     * Four things it accepts, because a terminal is a place people type from
     * habit and every one of these is somebody's habit:
     *
     *  - numbers, `1 3 5` or `1,3,5` — commas and spaces are the same separator
     *  - names, `coder nano`, matched by prefix exactly as `choose` does
     *  - `all`, which is what somebody who wants the lot will type first
     *  - an empty line for none, which is also how the question is declined
     *
     * A garbled entry re-asks rather than silently dropping. Selecting four of
     * five things and getting three because one was misspelt is the failure
     * worth a second prompt: it is invisible until much later, when the agent
     * that was supposed to exist does not.
     *
     * `marks` annotates a row without joining its label — `[installed]` should
     * not be typeable as a name.
     */
    chooseMany: async (
      question: string,
      options: readonly string[],
      marks: readonly string[] = [],
    ): Promise<readonly number[]> => {
      for (const [index, option] of options.entries()) {
        const mark = marks[index];
        out.write(
          `  ${c.dim(String(index + 1).padStart(2))}  ${option}` +
            `${mark === undefined || mark === '' ? '' : ` ${c.dim(mark)}`}\n`,
        );
      }
      for (;;) {
        const answer = (await text(question)).trim();
        if (answer === '') return [];
        if (answer.toLowerCase() === 'all') {
          return options.map((option, index) => index);
        }

        const chosen = new Set<number>();
        let bad = '';
        for (const token of answer.split(/[\s,]+/).filter((t) => t !== '')) {
          const index = Number(token) - 1;
          if (Number.isInteger(index) && index >= 0 && index < options.length) {
            chosen.add(index);
            continue;
          }
          const named = options.findIndex((option) =>
            option.toLowerCase().startsWith(token.toLowerCase()),
          );
          if (named >= 0) {
            chosen.add(named);
            continue;
          }
          bad = token;
          break;
        }

        if (bad === '') return [...chosen].sort((a, b) => a - b);
        out.write(c.yellow(`  ${t('preset.notAnOption', { name: bad })}\n`));
      }
    },

    /**
     * Yes or no, in the operator's language *and* in English.
     *
     * The literal `y`/`n` this used to test is an English accident: a German
     * operator types `j` for ja, and a prompt that reads `J/n` and then ignores
     * `j` is worse than one that never offered the choice. The localised letters
     * come from the bundle.
     *
     * English stays accepted alongside them rather than being replaced. A
     * terminal is a place people type from muscle memory, `y` is what a decade
     * of other tools trained, and there is no locale where accepting it costs
     * anything — no language's negative begins with `y`, and the localised
     * letter is tested first regardless.
     */
    confirm: async (question: string, fallback: boolean): Promise<boolean> => {
      const hint = fallback
        ? t('prompt.yesNoDefaultYes')
        : t('prompt.yesNoDefaultNo');
      const answer = (await text(question, hint)).toLowerCase();
      const yes = t('prompt.yes').toLowerCase();
      const no = t('prompt.no').toLowerCase();

      if (answer.startsWith(yes) || answer.startsWith('y')) return true;
      if (answer.startsWith(no) || answer.startsWith('n')) return false;
      return fallback;
    },
  };
}
