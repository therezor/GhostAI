import { describe, expect, it } from 'vitest';

import { estimateTokens, loadTokenCounter } from './tokens.js';

describe('estimateTokens', () => {
  it('is proportional to length and never fractional', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
  });

  it('lands within a useful factor of a real tokenizer', async () => {
    // The estimate exists to decide *whether* to truncate, not exactly where,
    // so being in the right ballpark is the whole requirement.
    const count = await loadTokenCounter();
    const prose = 'The quick brown fox jumps over the lazy dog. '.repeat(20);
    const ratio = estimateTokens(prose) / count(prose);
    expect(ratio).toBeGreaterThan(0.5);
    expect(ratio).toBeLessThan(2);
  });
});

describe('loadTokenCounter', () => {
  it('counts tokens exactly', async () => {
    const count = await loadTokenCounter();
    expect(count('hello world')).toBe(2);
    expect(count('')).toBe(0);
  });

  it('loads the tables once, however many callers ask at once', async () => {
    // The cache holds the promise rather than the result, so concurrent first
    // callers share one import instead of racing to start several.
    const [a, b] = await Promise.all([loadTokenCounter(), loadTokenCounter()]);
    expect(a).toBe(b);
  });
});
