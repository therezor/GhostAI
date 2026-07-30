/**
 * A model's `args` value, turned into an argv it meant.
 *
 * The schema asks for `string[]` and says so in the field description. Models
 * send a bare string anyway, and often a damaged one — observed verbatim:
 *
 * ```json
 * { "args": "[0] SUFFOLK wildfire 2024 fires reports UK US news updates\"]" }
 * ```
 *
 * That is a model half-serialising an array: an index marker at the front, a
 * stray quote and bracket at the back, and the actual query in the middle.
 * Refusing it is *correct* and it is also a wasted turn — the model reads the
 * validation error, produces a differently-broken string, and a small one does
 * that until the iteration cap. Accepting what it evidently meant costs a few
 * lines here and turns a dead end into a search.
 *
 * The order matters, and each step earns its place:
 *
 *  1. **Already an array** — the contract, and the common case.
 *  2. **A JSON array** — `"[\"--json\", \"query\"]"`. A model that stringified
 *     its argument list correctly should not be punished for the quotes.
 *  3. **A shell-ish string** — split on whitespace, honouring quotes so
 *     `--query "two words"` stays one argument. This is the fallback, and the
 *     one that has to cope with the damaged input above.
 *
 * What it deliberately does **not** do is run a shell or interpret `$`, `|`,
 * `>` or `;`. Those characters survive as literal text in whatever argument
 * they landed in. This turns a string into a list; it never turns one into a
 * pipeline, because the argv contract is what keeps `guardExec`'s allow-list
 * meaningful.
 */

/** Bracket and quote debris from a half-serialised array, at either end. */
const ARRAY_DEBRIS = /^[\s[\]"',]+|[\s[\]"',]+$/g;

/** `[0]`, `[1]:` — an index marker a model prefixed to its own argument. */
const INDEX_MARKER = /^\[\d+\]:?\s*/;

/**
 * Splits on whitespace, keeping quoted runs together.
 *
 * Deliberately simpler than a shell: no escapes, no variable expansion, no
 * operators. A quote opens a run and the next matching quote closes it, which is
 * enough for `--flag "two words"` and cannot express anything else.
 */
function splitArgv(input: string): string[] {
  const argv: string[] = [];
  let current = '';
  let quote: '"' | "'" | undefined;
  let started = false;

  for (const char of input) {
    if (quote !== undefined) {
      if (char === quote) quote = undefined;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      // An empty quoted string is still an argument, so opening a quote counts
      // as having started one even if nothing lands inside it.
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started) argv.push(current);
      current = '';
      started = false;
      continue;
    }
    current += char;
    started = true;
  }
  if (started) argv.push(current);
  return argv;
}

/**
 * Whatever the model sent, as an argv.
 *
 * Never throws and never returns `undefined`: a value this cannot make sense of
 * becomes an empty argv, and whether that is allowed is `requiresArgs`' decision
 * rather than this function's.
 */
export function coerceArgv(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item));
  if (typeof value !== 'string') return [];

  const trimmed = value.trim();
  if (trimmed === '') return [];

  // A properly stringified array, which is a model that got it nearly right.
  if (trimmed.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed.map((item) => String(item));
    } catch {
      // Not JSON — fall through to the damaged-string path, which is what the
      // example in this module's header needs.
    }
  }

  const cleaned = trimmed.replace(INDEX_MARKER, '').replace(ARRAY_DEBRIS, '');
  return splitArgv(cleaned);
}
