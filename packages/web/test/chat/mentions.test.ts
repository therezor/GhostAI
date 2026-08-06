/**
 * The `@` autocomplete's half of the mention grammar.
 *
 * `parseMentions` answers "what mentions are in this finished message"; this
 * answers "is the caret inside one that is still being typed". The cases that
 * matter are the ones where the naive version says yes and should not: an email
 * address, a mention the caret has already moved past, and a namespace that is
 * not one.
 */

import { describe, expect, it } from 'vitest';

import {
  applyMention,
  mentionAtCaret,
  mentionSuggestions,
} from '@/chat/mentions.js';

const at = (text: string): ReturnType<typeof mentionAtCaret> =>
  mentionAtCaret(text, text.length);

/** Sorted by name, as `GET /api/skills` answers. */
const SKILLS = [
  { name: 'code-review', description: 'Review a diff.' },
  { name: 'deploy', description: 'Ship a release.' },
];

describe('mentionAtCaret', () => {
  it('finds a namespace being typed', () => {
    expect(at('scope this to @k')).toMatchObject({
      start: 14,
      kind: undefined,
      query: 'k',
    });
  });

  it('finds a value being typed once the colon is in', () => {
    expect(at('@mcp:noti')).toMatchObject({ kind: 'mcp', query: 'noti' });
  });

  it('is nothing when the caret has moved past the mention', () => {
    // A space ends the mention. Completing one the user has finished typing is
    // a popover that appears over the next word.
    expect(at('@mcp:notion and then')).toBeUndefined();
  });

  it('is nothing for an email address', () => {
    expect(at('write to alice@example')).toBeUndefined();
    expect(at('alice@mcp:x')).toBeUndefined();
  });

  it('starts after an opening bracket, which is still a word boundary', () => {
    expect(at('(@sk')).toMatchObject({ start: 1, query: 'sk' });
  });

  it('is nothing for a namespace that does not exist', () => {
    expect(at('@nope:value')).toBeUndefined();
  });

  it('reads the caret rather than the end of the text', () => {
    const text = '@mcp:notion trailing words';

    expect(mentionAtCaret(text, 7)).toMatchObject({
      kind: 'mcp',
      query: 'no',
      end: 7,
    });
  });
});

describe('mentionSuggestions', () => {
  it('offers the namespaces that match what has been typed', () => {
    const query = at('@');
    expect(query).toBeDefined();
    expect(
      mentionSuggestions(query!).map((suggestion) => suggestion.insert),
    ).toEqual(['@mcp:', '@skill:']);

    const narrowed = at('@sk');
    expect(
      mentionSuggestions(narrowed!).map((suggestion) => suggestion.insert),
    ).toEqual(['@skill:']);
  });

  it('offers nothing for a namespace whose value nothing reads', () => {
    // `@mcp:` is not honoured yet, so a menu here would complete to something
    // the turn ignores — which reads as broken where an absent menu reads as
    // absent.
    expect(mentionSuggestions(at('@mcp:git')!)).toEqual([]);
  });

  it('offers the workspace’s skills, because naming one does something', () => {
    // The asymmetry with the two above is the whole point: `@skill:deploy`
    // sends that sheet with the message, so the completion leads somewhere.
    const suggestions = mentionSuggestions(at('@skill:')!, SKILLS);

    expect(suggestions.map((suggestion) => suggestion.label)).toEqual([
      '@skill:code-review',
      '@skill:deploy',
    ]);
    expect(suggestions[0]?.hint).toBe('Review a diff.');
  });

  it('narrows the skills to what has been typed, case-insensitively', () => {
    expect(
      mentionSuggestions(at('@skill:DEP')!, SKILLS).map((s) => s.label),
    ).toEqual(['@skill:deploy']);
  });

  it('closes the mention with a trailing space', () => {
    // Otherwise the next word runs into the name and becomes part of it.
    expect(mentionSuggestions(at('@skill:dep')!, SKILLS)[0]?.insert).toBe(
      '@skill:deploy ',
    );
  });

  it('offers nothing while the catalogue is still being fetched', () => {
    // An empty list is "no popover", not "no results" — so a workspace with
    // plenty of skills never flashes an empty menu on the way to its answer.
    expect(mentionSuggestions(at('@skill:')!)).toEqual([]);
  });
});

describe('applyMention', () => {
  it('replaces the typed run and leaves the caret after it', () => {
    const text = 'scope to @m and continue';
    const query = mentionAtCaret(text, 11);
    expect(query).toBeDefined();

    const applied = applyMention(text, query!, mentionSuggestions(query!)[0]!);

    expect(applied.text).toBe('scope to @mcp: and continue');
    expect(applied.caret).toBe(14);
  });
});
