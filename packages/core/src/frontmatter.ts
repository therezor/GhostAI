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
 *   document    := fence entry* fence body
 *   fence       := "---" EOL
 *   entry       := field | nest
 *   field       := key ":" value EOL
 *   nest        := key ":" EOL (indent key ":" value EOL)+
 *   key         := [A-Za-z][A-Za-z0-9_-]*
 *   value       := any text, optionally wrapped in one pair of quotes
 * ```
 *
 * Anything else inside the fence — a list, a deeper mapping, a stray line — is
 * skipped rather than refused. A skill is loaded on the strength of the two
 * fields it must have (`skills.ts` enforces that), and failing the whole file
 * because someone left a `tags:` list in it would refuse a skill over a field
 * nobody reads.
 *
 * ## One level of nesting, flattened to a dotted key
 *
 * ```yaml
 * metadata:
 *   type: user
 * ```
 *
 * yields `{'metadata': '', 'metadata.type': 'user'}`. The return type is still
 * `Record<string, string>`, so no caller learns about a tree — `memory.ts` asks
 * for `fields['metadata.type']` and reads as the thing that is in the file.
 *
 * **This is eight lines bought to close a hazard, not a feature anybody asked
 * for.** Before it, every line was trimmed before being matched, so an indented
 * `type: user` was stored as a *top-level* `type` — and a nested `name:` under
 * any key silently overwrote the real one, in a skill as much as in a memory.
 * The grammar block above used to claim a nested mapping was "skipped", which
 * was false. Depending on the hoist would have made a latent bug load-bearing:
 * nobody could then fix the shadowing without breaking memory.
 *
 * Only one level, and only under a key whose own value is empty. That is the
 * whole of what the memory format needs, and every step past it is a step
 * towards the YAML parser this file exists not to be.
 *
 * ## Why it lives in `@ghostai/core`
 *
 * It started in `@ghostai/agent` beside `skills.ts`, its only caller. The
 * `memory` tool is the second, and it is in `@ghostai/tools`, which depends on
 * core and not on agent. One parser at the bottom of the graph beats two copies
 * of the same thirty lines drifting apart.
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
  // The key an indented line hangs off: the last one at column zero whose own
  // value was empty. Cleared by anything else, so an indented line under
  // `name: Deploy` is a stray rather than `name.something`.
  let parent: string | undefined;

  for (const line of lines.slice(1, close)) {
    const field = parseField(line);
    if (field === undefined) {
      parent = undefined;
      continue;
    }

    const indented = /^\s/.test(line);
    if (indented) {
      if (parent !== undefined) fields[`${parent}.${field.key}`] = field.value;
      continue;
    }

    // Last wins, which is the only rule that does not need explaining when a
    // key appears twice.
    fields[field.key] = field.value;
    parent = field.value === '' ? field.key : undefined;
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
