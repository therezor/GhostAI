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

describe('mentionAtCaret', () => {
  it('finds a namespace being typed', () => {
    expect(at('scope this to @k')).toMatchObject({
      start: 14,
      kind: undefined,
      query: 'k',
    });
  });

  it('finds a value being typed once the colon is in', () => {
    expect(at('@kb:handb')).toMatchObject({ kind: 'kb', query: 'handb' });
  });

  it('is nothing when the caret has moved past the mention', () => {
    // A space ends the mention. Completing one the user has finished typing is
    // a popover that appears over the next word.
    expect(at('@kb:docs and then')).toBeUndefined();
  });

  it('is nothing for an email address', () => {
    expect(at('write to alice@example')).toBeUndefined();
    expect(at('alice@kb:x')).toBeUndefined();
  });

  it('starts after an opening bracket, which is still a word boundary', () => {
    expect(at('(@sk')).toMatchObject({ start: 1, query: 'sk' });
  });

  it('is nothing for a namespace that does not exist', () => {
    expect(at('@nope:value')).toBeUndefined();
  });

  it('reads the caret rather than the end of the text', () => {
    const text = '@kb:docs trailing words';

    expect(mentionAtCaret(text, 6)).toMatchObject({
      kind: 'kb',
      query: 'do',
      end: 6,
    });
  });
});

describe('mentionSuggestions', () => {
  it('offers the namespaces that match what has been typed', () => {
    const query = at('@');
    expect(query).toBeDefined();
    expect(
      mentionSuggestions(query!).map((suggestion) => suggestion.insert),
    ).toEqual(['@kb:', '@mcp:', '@skill:']);

    const narrowed = at('@sk');
    expect(
      mentionSuggestions(narrowed!).map((suggestion) => suggestion.insert),
    ).toEqual(['@skill:']);
  });

  it('offers nothing once a namespace is chosen', () => {
    // There is no knowledge base, MCP server or skill to list before Phase 3,
    // and a menu that says "no results" for a feature that was never turned on
    // reads as broken rather than as absent.
    expect(mentionSuggestions(at('@kb:doc')!)).toEqual([]);
  });
});

describe('applyMention', () => {
  it('replaces the typed run and leaves the caret after it', () => {
    const text = 'scope to @k and continue';
    const query = mentionAtCaret(text, 11);
    expect(query).toBeDefined();

    const applied = applyMention(text, query!, mentionSuggestions(query!)[0]!);

    expect(applied.text).toBe('scope to @kb: and continue');
    expect(applied.caret).toBe(13);
  });
});
