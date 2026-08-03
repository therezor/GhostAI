/**
 * The half of the translation gate that `i18next-parser` cannot see.
 *
 * The parser walks `t()` calls and writes the keys it finds. That proves the
 * bundles are in step with the *translated* copy, and says nothing at all about
 * copy that was never wrapped — a hardcoded string is not a key it missed, it is
 * a string it had no reason to look at. The two gates catch opposite failures
 * and neither substitutes for the other:
 *
 *  - `pnpm i18n:check` — a key used in the source but missing from the bundle.
 *  - this file — a sentence in the source that never became a key.
 *
 * A source sweep rather than an ESLint rule, for the reason the token gates give:
 * this has to hold across JSX children and JSX attributes at once, and the rule
 * is about *English prose appearing anywhere*, which is a property of the file
 * rather than of a node an AST rule is handed.
 *
 * It is deliberately conservative. Two or more consecutive word characters, and
 * at least two words, so `{'·'}`, a lone `%`, a `<td>{count}</td>` and an
 * identifier like `qwen3:8b` do not trip it. What it is aimed at is the thing
 * that actually regresses: someone adds a panel with `<h2>Scheduled jobs</h2>`
 * six months from now and nothing anywhere notices.
 */

import { describe, expect, it } from 'vitest';

import { collectSources } from '../tokens/run-gates.js';

const sources = collectSources().filter(({ file }) => file.endsWith('.tsx'));

/**
 * Files that are allowed to hold English, each for a stated reason.
 *
 * Stated as decisions rather than omissions — an allowlist nobody can explain
 * becomes the place strings go to avoid the gate.
 */
const ALLOWED: readonly { readonly file: string; readonly why: string }[] = [
  {
    file: 'src/routes/tokens.tsx',
    why: 'The design-system style guide. A developer-only surface, and its copy names tokens and CSS values rather than addressing a user.',
  },
];

const ALLOWED_FILES = new Set(ALLOWED.map((entry) => entry.file));

/** Two words of prose or more — see the note above on why the bar is here. */
const PROSE = /[A-Za-z]{2,}(?:['’-]?[A-Za-z]+)*(?:\s+[A-Za-z]{2,}[^<>{}"]*)/;

/** JSX text between tags: `>Some words<`, but not `>{expression}<`. */
const JSX_TEXT = />\s*([A-Z][^<>{}]*?)\s*</g;

/**
 * A JSX expression container, flattened to a placeholder before the sweep runs.
 *
 * `JSX_TEXT` forbids braces in the text it captures, which is what keeps it from
 * running across a block of code — and it also meant a sentence with a value in
 * it was invisible. Twenty-two of them were: every "Could not load the agent:
 * {error.message}", every "There is no workspace called “{id}”." A whole class
 * of copy, and the class that shows up on the worst day the user has.
 *
 * Flattening rather than allowing braces through. Widening the character class
 * was the obvious fix and it is wrong: `[^<>]` will happily run from a `>` in
 * `a.enabled) - Number(b)` to a `<` three statements later and report the code
 * in between as untranslated prose. Replacing the innermost `{…}` with a marker
 * leaves the *text* whole and still refuses to cross a real brace, so a sentence
 * matches and a block of code does not.
 */
const EXPRESSION = /\{[^{}]*\}/g;

/**
 * The attributes that carry copy rather than configuration.
 *
 * `hint` was missing from this list for as long as it has existed, and fifteen
 * sentences shipped untranslated behind the omission — the paragraph under a
 * switch explaining what turning the workspace jail off actually does, what a
 * blank provider name falls back to, why the current password is asked for
 * again. It is a first-class prop on `TextField`, `SwitchRow` and `SelectField`
 * and reads as prose to the person in front of it, so it belongs here with the
 * rest. The gate only checks what it is told to check, which makes the contents
 * of this list the whole of the rule.
 */
const COPY_ATTRIBUTES = /\b(?:aria-label|placeholder|title|alt|description|label|hint)="([^"]+)"/g;

function offendersIn(file: string, rawSource: string): string[] {
  const found: string[] = [];
  const source = rawSource.replace(EXPRESSION, '…');

  for (const [, text] of source.matchAll(JSX_TEXT)) {
    if (text !== undefined && PROSE.test(text)) found.push(`${file}: >${text}<`);
  }
  for (const [, text] of source.matchAll(COPY_ATTRIBUTES)) {
    if (text !== undefined && PROSE.test(text)) found.push(`${file}: "${text}"`);
  }

  return found;
}

describe('user-facing copy', () => {
  it('goes through the translation layer rather than sitting in the source', () => {
    const offenders = sources
      .filter(({ file }) => !ALLOWED_FILES.has(file) && !file.includes('.test.'))
      .flatMap(({ file, source }) => offendersIn(file, source));

    expect(offenders).toEqual([]);
  });

  it('keeps the allowlist honest', () => {
    // An entry that no longer names a real file is an exemption nobody is
    // watching — and the next person reads it as permission rather than as a
    // stale line. Both halves matter: a file that stopped needing the exemption
    // should lose it.
    for (const { file } of ALLOWED) {
      expect(
        sources.some((entry) => entry.file === file),
        `${file} is not a source file`,
      ).toBe(true);
      expect(
        offendersIn(file, sources.find((entry) => entry.file === file)?.source ?? '').length,
        `${file} no longer holds untranslated copy — drop it from the allowlist`,
      ).toBeGreaterThan(0);
    }
  });
});
