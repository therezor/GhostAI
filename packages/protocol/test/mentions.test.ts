import { describe, expect, it } from 'vitest';

import { MENTION_KINDS, isMentionKind, parseMentions } from '#src/mentions.js';

describe('parseMentions', () => {
  it('returns empty buckets for text with no mentions', () => {
    const result = parseMentions('just a normal message');
    expect(result).toEqual({ mcp: [], skill: [], all: [] });
  });

  it('handles an empty string', () => {
    expect(parseMentions('').all).toEqual([]);
  });

  describe('unquoted form', () => {
    it('extracts each kind', () => {
      const result = parseMentions('@mcp:notion @skill:git');
      expect(result.mcp).toEqual(['notion']);
      expect(result.skill).toEqual(['git']);
    });

    it('stops at whitespace', () => {
      expect(parseMentions('@skill:docs and more text').skill).toEqual([
        'docs',
      ]);
    });

    it('accepts names with internal punctuation', () => {
      expect(parseMentions('@skill:my-docs_v2.1').skill).toEqual([
        'my-docs_v2.1',
      ]);
    });

    it('trims trailing sentence punctuation', () => {
      expect(parseMentions('see @skill:docs.').skill).toEqual(['docs']);
      expect(parseMentions('see @skill:docs, please').skill).toEqual(['docs']);
      expect(parseMentions('(@skill:docs)').skill).toEqual(['docs']);
      expect(parseMentions('@skill:docs?!').skill).toEqual(['docs']);
    });

    it('yields no mention when the value is only punctuation', () => {
      expect(parseMentions('@skill:...').all).toEqual([]);
    });
  });

  describe('quoted form', () => {
    it('captures values containing spaces', () => {
      expect(parseMentions('@skill:"My Project Docs"').skill).toEqual([
        'My Project Docs',
      ]);
    });

    it('preserves punctuation inside quotes', () => {
      expect(parseMentions('@skill:"docs."').skill).toEqual(['docs.']);
    });

    it('treats an empty quoted value as no mention', () => {
      // A quoted-then-bare alternation falls through to the bare branch here
      // and captures the literal `""` as a name.
      expect(parseMentions('@skill:""').all).toEqual([]);
    });

    it('does not let a quoted value run past its closing quote', () => {
      const result = parseMentions('@skill:"a b" trailing');
      expect(result.skill).toEqual(['a b']);
    });
  });

  describe('adjacent forms', () => {
    it('parses two mentions separated only by whitespace', () => {
      expect(parseMentions('@skill:a @skill:b').skill).toEqual(['a', 'b']);
    });

    it('parses mentions jammed together with no separator', () => {
      // A bare value excludes `@`, so the second mention is not swallowed.
      const result = parseMentions('@mcp:a@skill:b');
      expect(result.mcp).toEqual(['a']);
      expect(result.skill).toEqual(['b']);
    });

    it('parses a quoted mention immediately followed by another', () => {
      const result = parseMentions('@skill:"a b"@mcp:c');
      expect(result.skill).toEqual(['a b']);
      expect(result.mcp).toEqual(['c']);
    });

    it('parses mentions adjacent to surrounding prose', () => {
      const result = parseMentions('use@skill:docs now');
      expect(result.skill).toEqual(['docs']);
    });
  });

  describe('de-duplication', () => {
    it('de-duplicates per kind, keeping first-seen order', () => {
      expect(parseMentions('@skill:b @skill:a @skill:b').skill).toEqual([
        'b',
        'a',
      ]);
    });

    it('keeps every occurrence in `all`', () => {
      expect(parseMentions('@skill:b @skill:b').all).toHaveLength(2);
    });

    it('keeps identical values in different namespaces separate', () => {
      const result = parseMentions('@skill:x @mcp:x');
      expect(result.skill).toEqual(['x']);
      expect(result.mcp).toEqual(['x']);
    });
  });

  describe('spans', () => {
    it('reports the span of the whole mention', () => {
      const text = 'hi @skill:docs';
      const [mention] = parseMentions(text).all;
      expect(mention).toBeDefined();
      expect(text.slice(mention!.start, mention!.end)).toBe('@skill:docs');
    });

    it('excludes trimmed punctuation from the span', () => {
      const text = 'hi @skill:docs.';
      const [mention] = parseMentions(text).all;
      expect(text.slice(mention!.start, mention!.end)).toBe('@skill:docs');
    });

    it('includes the quotes in a quoted span', () => {
      const text = 'hi @skill:"a b" x';
      const [mention] = parseMentions(text).all;
      expect(text.slice(mention!.start, mention!.end)).toBe('@skill:"a b"');
    });

    it('reports spans in source order across kinds', () => {
      const result = parseMentions('@skill:z @mcp:a');
      expect(result.all.map((m) => m.kind)).toEqual(['skill', 'mcp']);
      expect(result.all[0]!.start).toBeLessThan(result.all[1]!.start);
    });
  });

  describe('non-mentions', () => {
    it('ignores namespaces outside the grammar', () => {
      expect(parseMentions('@app:slack @foo:bar').all).toEqual([]);
    });

    it('ignores a bare @ and a namespace with no value', () => {
      expect(parseMentions('@ @skill: @skill').all).toEqual([]);
    });

    it('does not match inside an email address', () => {
      expect(parseMentions('mail me at roman@example.com').all).toEqual([]);
    });

    it('is case-sensitive on the namespace', () => {
      expect(parseMentions('@SKILL:docs').all).toEqual([]);
    });

    it('does not treat a multi-line message as a barrier', () => {
      expect(parseMentions('line one\n@skill:docs\nline three').skill).toEqual([
        'docs',
      ]);
    });
  });

  it('does not modify the source text', () => {
    // The model sees exactly what the user typed; callers use spans to strip.
    const text = 'check @skill:"My Docs" for that';
    parseMentions(text);
    expect(text).toBe('check @skill:"My Docs" for that');
  });

  it('is not affected by regex lastIndex across calls', () => {
    const first = parseMentions('@skill:a');
    const second = parseMentions('@skill:a');
    expect(second).toEqual(first);
  });
});

describe('isMentionKind', () => {
  it('accepts every declared kind', () => {
    for (const kind of MENTION_KINDS) {
      expect(isMentionKind(kind)).toBe(true);
    }
  });

  it('rejects an unknown namespace', () => {
    expect(isMentionKind('app')).toBe(false);
  });
});
