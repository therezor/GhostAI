import type { AgentLoop } from '@ghostai/agent';
import { describe, expect, it } from 'vitest';

import { LoopCache, MAX_CACHED_LOOPS } from '#src/loop-cache.js';

/** A stand-in: the cache never calls into a loop, it only holds one. */
function fakeLoop(agentId: string): AgentLoop {
  return { agentId } as unknown as AgentLoop;
}

interface Counting {
  readonly cache: LoopCache;
  readonly built: string[];
}

function counting(options: { max?: number; fails?: ReadonlySet<string> } = {}): Counting {
  const built: string[] = [];
  const cache = new LoopCache({
    ...(options.max === undefined ? {} : { max: options.max }),
    create: (agentId) => {
      built.push(agentId);
      if (options.fails?.has(agentId) === true) throw new Error(`cannot build ${agentId}`);
      return fakeLoop(agentId);
    },
  });
  return { cache, built };
}

describe('LoopCache', () => {
  it('builds a loop once and hands back the same one', () => {
    const { cache, built } = counting();

    const first = cache.get('reviewer');
    const second = cache.get('reviewer');

    expect(first).toBe(second);
    expect(built).toEqual(['reviewer']);
  });

  it('gives each agent its own loop', () => {
    const { cache, built } = counting();

    expect(cache.get('reviewer')).not.toBe(cache.get('writer'));
    expect(built).toEqual(['reviewer', 'writer']);
    expect(cache.size).toBe(2);
  });

  it('does not remember a null, so a save that configures the install takes effect', () => {
    let configured = false;
    const cache = new LoopCache({ create: () => (configured ? fakeLoop('default') : null) });

    expect(cache.get('default')).toBeNull();
    configured = true;
    expect(cache.get('default')).not.toBeNull();
  });

  it('does not cache a construction failure', () => {
    // A poisoned entry would return the failure forever rather than retrying.
    const { cache, built } = counting({ fails: new Set(['broken']) });

    expect(() => cache.get('broken')).toThrow(/cannot build broken/);
    expect(() => cache.get('broken')).toThrow(/cannot build broken/);
    expect(built).toEqual(['broken', 'broken']);
    expect(cache.size).toBe(0);
  });

  it('evicts the least recently used once it is full', () => {
    const { cache, built } = counting({ max: 2 });

    cache.get('a');
    cache.get('b');
    cache.get('c');

    expect(cache.size).toBe(2);
    // `a` went, so asking again rebuilds it.
    cache.get('a');
    expect(built).toEqual(['a', 'b', 'c', 'a']);
  });

  it('keeps a loop young by using it', () => {
    const { cache, built } = counting({ max: 2 });

    cache.get('a');
    cache.get('b');
    cache.get('a'); // `a` is now the most recent, so `b` is the victim.
    cache.get('c');

    cache.get('a');
    expect(built).toEqual(['a', 'b', 'c']);
  });

  it('never evicts the default, whatever else is in play', () => {
    // Every unbound session runs on it, so evicting it to make room for an
    // agent used once would guarantee a rebuild on the very next turn.
    const { cache, built } = counting({ max: 2 });

    cache.get('default');
    cache.get('a');
    cache.get('b');
    cache.get('c');

    cache.get('default');
    expect(built).toEqual(['default', 'a', 'b', 'c']);
  });

  it('drops everything on clear', () => {
    const { cache, built } = counting();

    cache.get('reviewer');
    cache.clear();
    cache.get('reviewer');

    expect(cache.size).toBe(1);
    expect(built).toEqual(['reviewer', 'reviewer']);
  });

  it('defaults to a bound sized for what an operator actually does', () => {
    const { cache } = counting();
    for (let index = 0; index < MAX_CACHED_LOOPS + 4; index += 1) {
      cache.get(`agent-${String(index)}`);
    }
    expect(cache.size).toBe(MAX_CACHED_LOOPS);
  });
});
