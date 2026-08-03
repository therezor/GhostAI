import { describe, expect, it } from 'vitest';

import { MENTION_KINDS, isMentionKind, parseMentions } from '#src/mentions.js';

describe('parseMentions', () => {
  it('returns empty buckets for text with no mentions', () => {
    const result = parseMentions('just a normal message');
    expect(result).toEqual({ kb: [], mcp: [], skill: [], all: [] });
  });

  it('handles an empty string', () => {
    expect(parseMentions('').all).toEqual([]);
  });

  describe('unquoted form', () => {
    it('extracts each kind', () => {
      const result = parseMentions('@kb:docs @mcp:notion @skill:git');
      expect(result.kb).toEqual(['docs']);
      expect(result.mcp).toEqual(['notion']);
      expect(result.skill).toEqual(['git']);
    });

    it('stops at whitespace', () => {
      expect(parseMentions('@kb:docs and more text').kb).toEqual(['docs']);
    });

    it('accepts names with internal punctuation', () => {
      expect(parseMentions('@kb:my-docs_v2.1').kb).toEqual(['my-docs_v2.1']);
    });

    it('trims trailing sentence punctuation', () => {
      expect(parseMentions('see @kb:docs.').kb).toEqual(['docs']);
      expect(parseMentions('see @kb:docs, please').kb).toEqual(['docs']);
      expect(parseMentions('(@kb:docs)').kb).toEqual(['docs']);
      expect(parseMentions('@kb:docs?!').kb).toEqual(['docs']);
    });

    it('yields no mention when the value is only punctuation', () => {
      expect(parseMentions('@kb:...').all).toEqual([]);
    });
  });

  describe('quoted form', () => {
    it('captures values containing spaces', () => {
      expect(parseMentions('@kb:"My Project Docs"').kb).toEqual(['My Project Docs']);
    });

    it('preserves punctuation inside quotes', () => {
      expect(parseMentions('@kb:"docs."').kb).toEqual(['docs.']);
    });

    it('treats an empty quoted value as no mention', () => {
      // A quoted-then-bare alternation falls through to the bare branch here
      // and captures the literal `""` as a knowledge-base name.
      expect(parseMentions('@kb:""').all).toEqual([]);
    });

    it('does not let a quoted value run past its closing quote', () => {
      const result = parseMentions('@kb:"a b" trailing');
      expect(result.kb).toEqual(['a b']);
    });
  });

  describe('adjacent forms', () => {
    it('parses two mentions separated only by whitespace', () => {
      expect(parseMentions('@kb:a @kb:b').kb).toEqual(['a', 'b']);
    });

    it('parses mentions jammed together with no separator', () => {
      // A bare value excludes `@`, so the second mention is not swallowed.
      const result = parseMentions('@kb:a@skill:b');
      expect(result.kb).toEqual(['a']);
      expect(result.skill).toEqual(['b']);
    });

    it('parses a quoted mention immediately followed by another', () => {
      const result = parseMentions('@kb:"a b"@mcp:c');
      expect(result.kb).toEqual(['a b']);
      expect(result.mcp).toEqual(['c']);
    });

    it('parses mentions adjacent to surrounding prose', () => {
      const result = parseMentions('use@kb:docs now');
      expect(result.kb).toEqual(['docs']);
    });
  });

  describe('de-duplication', () => {
    it('de-duplicates per kind, keeping first-seen order', () => {
      expect(parseMentions('@kb:b @kb:a @kb:b').kb).toEqual(['b', 'a']);
    });

    it('keeps every occurrence in `all`', () => {
      expect(parseMentions('@kb:b @kb:b').all).toHaveLength(2);
    });

    it('keeps identical values in different namespaces separate', () => {
      const result = parseMentions('@kb:x @mcp:x');
      expect(result.kb).toEqual(['x']);
      expect(result.mcp).toEqual(['x']);
    });
  });

  describe('spans', () => {
    it('reports the span of the whole mention', () => {
      const text = 'hi @kb:docs';
      const [mention] = parseMentions(text).all;
      expect(mention).toBeDefined();
      expect(text.slice(mention!.start, mention!.end)).toBe('@kb:docs');
    });

    it('excludes trimmed punctuation from the span', () => {
      const text = 'hi @kb:docs.';
      const [mention] = parseMentions(text).all;
      expect(text.slice(mention!.start, mention!.end)).toBe('@kb:docs');
    });

    it('includes the quotes in a quoted span', () => {
      const text = 'hi @kb:"a b" x';
      const [mention] = parseMentions(text).all;
      expect(text.slice(mention!.start, mention!.end)).toBe('@kb:"a b"');
    });

    it('reports spans in source order across kinds', () => {
      const result = parseMentions('@skill:z @kb:a');
      expect(result.all.map((m) => m.kind)).toEqual(['skill', 'kb']);
      expect(result.all[0]!.start).toBeLessThan(result.all[1]!.start);
    });
  });

  describe('non-mentions', () => {
    it('ignores namespaces outside the grammar', () => {
      expect(parseMentions('@app:slack @foo:bar').all).toEqual([]);
    });

    it('ignores a bare @ and a namespace with no value', () => {
      expect(parseMentions('@ @kb: @kb').all).toEqual([]);
    });

    it('does not match inside an email address', () => {
      expect(parseMentions('mail me at roman@example.com').all).toEqual([]);
    });

    it('is case-sensitive on the namespace', () => {
      expect(parseMentions('@KB:docs').all).toEqual([]);
    });

    it('does not treat a multi-line message as a barrier', () => {
      expect(parseMentions('line one\n@kb:docs\nline three').kb).toEqual(['docs']);
    });
  });

  it('does not modify the source text', () => {
    // The model sees exactly what the user typed; callers use spans to strip.
    const text = 'check @kb:"My Docs" for that';
    parseMentions(text);
    expect(text).toBe('check @kb:"My Docs" for that');
  });

  it('is not affected by regex lastIndex across calls', () => {
    const first = parseMentions('@kb:a');
    const second = parseMentions('@kb:a');
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
