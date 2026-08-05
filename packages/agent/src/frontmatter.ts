/**
 * The `---` block at the top of a Markdown file.
 *
 * **This is not a YAML parser, and it must not grow into one.** Nothing in this
 * repository parses YAML — there is no `yaml`, `js-yaml` or `gray-matter` in any
 * manifest, and `@ghostai/protocol` states the house position on dependencies
 * outright. What a skill's frontmatter actually holds is a `name` and a
 * `description`: two strings, not a tree. A parser for two strings is thirty
 * lines here; a parser for YAML is a dependency plus every construct it accepts
 * and this file's callers do not handle.
 *
 * So the grammar is deliberately smaller than YAML and stops where YAML would
 * get interesting:
 *
 * ```
 *   document    := fence field* fence body
 *   fence       := "---" EOL
 *   field       := key ":" value EOL
 *   key         := [A-Za-z][A-Za-z0-9_-]*
 *   value       := any text, optionally wrapped in one pair of quotes
 * ```
 *
 * Anything else inside the fence — a list, a nested mapping, a stray line — is
 * skipped rather than refused. A skill is loaded on the strength of the two
 * fields it must have (`skills.ts` enforces that), and failing the whole file
 * because someone left a `tags:` list in it would refuse a skill over a field
 * nobody reads.
 */

/** A parsed document: its frontmatter fields, and everything after the fence. */
export interface Frontmatter {
  readonly fields: Readonly<Record<string, string>>;
  readonly body: string;
}

const FENCE = '---';

/** `key: value`, anchored, with the value running to end of line. */
const FIELD = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/;

/**
 * Splits a document into its frontmatter fields and its body.
 *
 * **Never throws.** A file with no fence, or one whose fence is never closed, is
 * a document with no fields and a body of the whole text. That is the reading
 * that loses nothing: the alternative for an unterminated fence is to swallow
 * the entire skill as frontmatter, which turns a missing line into a silently
 * empty instruction sheet.
 */
export function parseFrontmatter(text: string): Frontmatter {
  // Split on both line endings rather than normalising the text first: a `\r`
  // left on the closing fence is the difference between finding it and reading
  // the whole file as frontmatter.
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== FENCE) return { fields: {}, body: text.trim() };

  const close = lines.findIndex(
    (line, index) => index > 0 && line.trim() === FENCE,
  );
  if (close === -1) return { fields: {}, body: text.trim() };

  const fields: Record<string, string> = {};
  for (const line of lines.slice(1, close)) {
    const field = parseField(line);
    // Last wins, which is the only rule that does not need explaining when a
    // key appears twice.
    if (field !== undefined) fields[field.key] = field.value;
  }

  return {
    fields,
    body: lines
      .slice(close + 1)
      .join('\n')
      .trim(),
  };
}

function parseField(
  line: string,
): { readonly key: string; readonly value: string } | undefined {
  const trimmed = line.trim();
  if (trimmed === '' || trimmed.startsWith('#')) return undefined;

  const match = FIELD.exec(trimmed);
  if (match === null) return undefined;

  // The pattern guarantees both groups; the checks are here because
  // `noUncheckedIndexedAccess` types them as possibly-undefined and a cast
  // would be the worse trade.
  const key = match[1];
  const value = match[2];
  if (key === undefined || value === undefined) return undefined;

  return { key, value: unquote(value.trim()) };
}

/**
 * Strips one matching pair of surrounding quotes.
 *
 * One pair, and only when both ends agree — so `"a"` is `a` while `"a` keeps its
 * quote rather than losing a character to a rule that guessed.
 */
function unquote(value: string): string {
  const first = value[0];
  if (first !== '"' && first !== "'") return value;
  if (value.length < 2 || !value.endsWith(first)) return value;
  return value.slice(1, -1);
}
