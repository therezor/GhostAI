/**
 * Token estimation.
 *
 * Two functions, because there are two genuinely different questions:
 *
 *  - **"Roughly how big is this?"** — the degradation ladder deciding how many
 *    turns to drop after a context-length rejection. It runs on the failure
 *    path, needs no precision, and must not make the failure path slower than
 *    the success path. That is `estimateTokens`, a character heuristic.
 *  - **"Exactly how big is this?"** — the memory package's consolidation budget,
 *    where being wrong by 15% means either wasting a third of the window or
 *    overflowing it. That is `loadTokenCounter`, and it is `async` on purpose.
 *
 * `gpt-tokenizer` carries its merge ranks as data: importing it costs ~40 ms and
 * ~50 MB of resident memory. Paying that at module load would charge every
 * consumer of this package — the CLI, the scheduler, a channel — for a table
 * most of them never consult. So it is imported dynamically, once, on first use.
 *
 * The counts are approximate for any model that is not OpenAI's, and
 * deliberately so. A per-provider tokenizer would mean shipping several
 * megabytes of vocabulary per provider to improve an estimate that exists to
 * decide *whether* to truncate, not exactly where.
 */

/** Counts tokens in a string. Exact for OpenAI models, close for the rest. */
export type TokenCounter = (text: string) => number;

/**
 * Average characters per token across English prose, code and JSON.
 *
 * Prose runs closer to 4.5 and minified JSON closer to 3, so 4 sits between them
 * and errs slightly high on prose — the safe direction when the number is used
 * to decide how much history to drop.
 */
const CHARS_PER_TOKEN = 4;

/** A byte-free estimate: no tables, no allocation, safe in a hot path. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

let counter: Promise<TokenCounter> | null = null;

/**
 * The exact counter, loaded once and cached.
 *
 * The cache holds the *promise*, not the result, so concurrent callers during
 * the first load share one import rather than racing to start several.
 */
export async function loadTokenCounter(): Promise<TokenCounter> {
  counter ??= import('gpt-tokenizer').then((module) => (text: string) => module.countTokens(text));
  return await counter;
}
