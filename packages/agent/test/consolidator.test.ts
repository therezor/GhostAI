import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  SessionStore,
  appendMemory,
  assistantMessage,
  userMessage,
  writeMemory,
  type Clock,
} from '@ghostai/core';

import type { ChatProvider, ChatResult } from '@ghostai/providers';
import { afterEach, describe, expect, it } from 'vitest';

import { MemoryConsolidator } from '#src/consolidator.js';
import { manualClock } from '#testkit/clock.js';

const roots: string[] = [];
const stores: SessionStore[] = [];

afterEach(() => {
  while (stores.length > 0) stores.pop()?.close();
  while (roots.length > 0) {
    rmSync(roots.pop() ?? '', { recursive: true, force: true });
  }
});

function workspace(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ghostai-fold-')));
  roots.push(root);
  return root;
}

/**
 * A provider that answers every request with the same text and records them.
 *
 * The scripted provider in `#testkit/provider.js` drives the *loop*, which
 * streams; this path calls `chat` once and never streams, so a four-line double
 * is the honest fixture.
 */
interface Call {
  readonly model: string;
  readonly content: string;
}

function answering(
  text: string,
): ChatProvider & { readonly calls: readonly Call[] } {
  const calls: Call[] = [];
  return {
    id: 'double',
    spec: {
      id: 'double',
      displayName: 'Double',
      wire: 'openai-chat',
      keywords: [],
    },
    calls,
    async chat(request): Promise<ChatResult> {
      const last = request.messages.at(-1);
      calls.push({
        model: request.model,
        content: last === undefined ? '' : JSON.stringify(last),
      });
      return {
        model: request.model,
        message: assistantMessage(text),
        finishReason: 'stop',
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      };
    },
    stream() {
      throw new Error('compression never streams');
    },
    async listModels() {
      return [];
    },
    async close() {
      // Nothing to release: this double holds no socket.
    },
  };
}

/** A provider that fails, for the ordering contract. */
function failing(): ChatProvider {
  const base = answering('unused');
  return {
    ...base,
    async chat(): Promise<ChatResult> {
      throw new Error('provider is down');
    },
  };
}

interface Fixture {
  readonly store: SessionStore;
  readonly root: string;
  readonly clock: Clock;
}

/** A session holding `turns` exchanges, each large enough to be worth folding. */
function fixture(turns = 20): Fixture {
  const store = new SessionStore({ file: ':memory:' });
  stores.push(store);
  store.ensureSession('session-1');

  for (let index = 0; index < turns; index += 1) {
    store.append(
      'session-1',
      userMessage(`q${String(index)} `.padEnd(400, 'x')),
    );
    store.append(
      'session-1',
      assistantMessage(`a${String(index)} `.padEnd(400, 'y')),
    );
  }

  return {
    store,
    root: workspace(),
    clock: manualClock(Date.parse('2026-08-05T09:00:00Z')),
  };
}

function consolidator(
  fixed: Fixture,
  provider: ChatProvider,
  overrides: Partial<{
    model: string;
    compactThresholdTokens: number;
    contextWindowTokens: number;
  }> = {},
): MemoryConsolidator {
  return new MemoryConsolidator({
    store: fixed.store,
    provider,
    model: overrides.model ?? 'the-model',
    contextWindowTokens: overrides.contextWindowTokens ?? 2_000,
    maxPromptTokens: 2_000,
    compactThresholdTokens: overrides.compactThresholdTokens ?? 100_000,
    clock: fixed.clock,
  });
}

function memory(root: string): string {
  return readFileSync(join(root, 'memory', 'memory.md'), 'utf8');
}

describe('MemoryConsolidator', () => {
  it('writes the summary and advances the marker', async () => {
    const fixed = fixture();
    const result = await consolidator(
      fixed,
      answering('- A durable fact.'),
    ).compress({
      sessionKey: 'session-1',
      workspaceRoot: fixed.root,
    });

    expect(result.folded).toBeGreaterThan(0);
    expect(memory(fixed.root)).toContain('- A durable fact.');
    expect(fixed.store.getSession('session-1')?.lastConsolidatedSeq).toBe(
      result.cut,
    );
  });

  it('leaves both untouched when the provider fails', async () => {
    // The ordering contract, asserted rather than commented. The marker must
    // never move past messages nothing represents.
    const fixed = fixture();

    await expect(
      consolidator(fixed, failing()).compress({
        sessionKey: 'session-1',
        workspaceRoot: fixed.root,
      }),
    ).rejects.toThrow('provider is down');

    expect(fixed.store.getSession('session-1')?.lastConsolidatedSeq).toBe(0);
    expect(() => memory(fixed.root)).toThrow();
  });

  it('does nothing for a session that does not exist', async () => {
    const fixed = fixture();
    const result = await consolidator(fixed, answering('x')).compress({
      sessionKey: 'never-spoken-to',
      workspaceRoot: fixed.root,
    });

    expect(result.folded).toBe(0);
  });

  it('folds only what is new on a second run', async () => {
    const fixed = fixture();
    const provider = answering('- A fact.');
    const fold = consolidator(fixed, provider);

    const first = await fold.compress({
      sessionKey: 'session-1',
      workspaceRoot: fixed.root,
    });
    const second = await fold.compress({
      sessionKey: 'session-1',
      workspaceRoot: fixed.root,
    });

    // Everything foldable went in the first pass, so the second has no span.
    expect(first.folded).toBeGreaterThan(0);
    expect(second.folded).toBe(0);
    expect(fixed.store.getSession('session-1')?.lastConsolidatedSeq).toBe(
      first.cut,
    );
  });

  it('leaves the operator’s prose above the first heading byte-identical', async () => {
    // The whole reason the file has a shape. Compaction rewrites sections and
    // must not reach the preamble.
    const fixed = fixture();
    await writeMemory(fixed.root, 'Always deploy with `make release`.\n');

    await consolidator(fixed, answering('- A fact.'), {
      compactThresholdTokens: 0,
    }).compress({ sessionKey: 'session-1', workspaceRoot: fixed.root });

    expect(memory(fixed.root)).toContain('Always deploy with `make release`.');
  });

  it('merges the notes when they pass the threshold', async () => {
    const fixed = fixture();
    const provider = answering('- A fact.');

    const result = await consolidator(fixed, provider, {
      compactThresholdTokens: 0,
    }).compress({ sessionKey: 'session-1', workspaceRoot: fixed.root });

    // Two calls: one to summarise the span, one to merge the notes.
    expect(result.compacted).toBe(true);
    expect(provider.calls).toHaveLength(2);
  });

  it('makes one call when the notes are under the threshold', async () => {
    const fixed = fixture();
    const provider = answering('- A fact.');

    const result = await consolidator(fixed, provider).compress({
      sessionKey: 'session-1',
      workspaceRoot: fixed.root,
    });

    expect(result.compacted).toBe(false);
    expect(provider.calls).toHaveLength(1);
  });

  it('summarises on the model it was given', async () => {
    // `consolidationModel` reaches the request, so a cheaper model is actually
    // the one billed.
    const fixed = fixture();
    const provider = answering('- A fact.');

    await consolidator(fixed, provider, { model: 'cheap-model' }).compress({
      sessionKey: 'session-1',
      workspaceRoot: fixed.root,
    });

    expect(provider.calls[0]?.model).toBe('cheap-model');
  });

  it('serialises two compressions started together', async () => {
    // Without the lock both read the same marker and fold the same span twice.
    const fixed = fixture();
    const fold = consolidator(fixed, answering('- A fact.'));

    const [first, second] = await Promise.all([
      fold.compress({ sessionKey: 'session-1', workspaceRoot: fixed.root }),
      fold.compress({ sessionKey: 'session-1', workspaceRoot: fixed.root }),
    ]);

    // The second saw the marker the first advanced, so it found nothing left.
    expect(first.folded).toBeGreaterThan(0);
    expect(second.folded).toBe(0);
  });

  it('does not lose a note appended while it is compressing', async () => {
    // The lock lives in `@ghostai/core`, shared with `appendMemory`, precisely
    // so these two cannot interleave. If the consolidator held its own, this
    // append would be read before the rewrite and overwritten by it.
    const fixed = fixture();
    const fold = consolidator(fixed, answering('- Folded.'));

    await Promise.all([
      fold.compress({ sessionKey: 'session-1', workspaceRoot: fixed.root }),
      appendMemory(fixed.root, '- Appended.', '2026-08-05T09:00:00Z'),
    ]);

    expect(memory(fixed.root)).toContain('- Folded.');
    expect(memory(fixed.root)).toContain('- Appended.');
  });

  it('keeps serving after a failure rather than wedging the workspace', async () => {
    // A rejected chain must not reject everything queued behind it.
    const fixed = fixture();
    const broken = consolidator(fixed, failing());

    await expect(
      broken.compress({ sessionKey: 'session-1', workspaceRoot: fixed.root }),
    ).rejects.toThrow();

    const working = consolidator(fixed, answering('- A fact.'));
    await expect(
      working.compress({ sessionKey: 'session-1', workspaceRoot: fixed.root }),
    ).resolves.toMatchObject({ compacted: false });
  });
});
