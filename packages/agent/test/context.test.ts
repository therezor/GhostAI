import { describe, expect, it } from 'vitest';

import {
  SessionStore,
  assistantMessage,
  toolMessage,
  userMessage,
} from '@ghostai/core';
import type { ToolDefinition } from '@ghostai/protocol';

import { describeContext } from '#src/context.js';

const SESSION = 'web:1';
const PROMPT = 'You are GhostAI, a helpful agent.';
const RUNTIME = '## Live state\n\nCurrent time: whenever';

const TOOLS: readonly ToolDefinition[] = [
  {
    name: 'read_file',
    description: 'Reads a file.',
    risk: 'safe',
    source: 'builtin',
    parameters: {},
  },
];

/** The one method `describeContext` needs, so no jail or provider is built. */
const loop = {
  previewPrompt: () =>
    Promise.resolve({ staticPrompt: PROMPT, runtimeBlock: RUNTIME }),
};

function makeStore(): SessionStore {
  return new SessionStore();
}

describe('describeContext', () => {
  it('reports nothing for a conversation that has not started', async () => {
    const store = makeStore();
    expect(
      await describeContext({
        store,
        loop,
        tools: TOOLS,
        sessionKey: 'nope',
        contextWindowTokens: 1000,
      }),
    ).toBeUndefined();
    store.close();
  });

  it('measures the prompt, the tools and the messages separately', async () => {
    const store = makeStore();
    store.append(SESSION, userMessage('hello'));

    const report = await describeContext({
      store,
      loop,
      tools: TOOLS,
      sessionKey: SESSION,
      contextWindowTokens: 10_000,
    });

    expect(report?.systemPrompt).toBe(PROMPT);
    expect(report?.contextWindowTokens).toBe(10_000);
    for (const section of ['systemPrompt', 'tools', 'messages'] as const) {
      expect(report?.breakdown[section]).toBeGreaterThan(0);
    }
    store.close();
  });

  it('adds up to the total it reports', async () => {
    const store = makeStore();
    store.append(SESSION, userMessage('hello'));

    const report = await describeContext({
      store,
      loop,
      tools: TOOLS,
      sessionKey: SESSION,
      contextWindowTokens: 10_000,
    });
    const { systemPrompt, tools, messages, runtimeBlock } =
      report?.breakdown ?? {
        systemPrompt: 0,
        tools: 0,
        messages: 0,
        runtimeBlock: 0,
      };

    // Every section, including the trailing turn — a total that omitted it would
    // under-report the request by exactly the part billed on every iteration.
    expect(report?.estimatedTokens).toBe(
      systemPrompt + tools + messages + runtimeBlock,
    );
    expect(runtimeBlock).toBeGreaterThan(0);
    store.close();
  });

  it('returns the stored rows, so each window entry keeps its address', async () => {
    const store = makeStore();
    const first = store.append(SESSION, userMessage('hello'));
    const second = store.append(SESSION, assistantMessage('hi'));

    const report = await describeContext({
      store,
      loop,
      tools: TOOLS,
      sessionKey: SESSION,
      contextWindowTokens: 10_000,
    });

    // The identity trick this is built on: every message in the window maps
    // back to the row it came from, ids and seqs intact.
    expect(report?.messages.map((record) => record.id)).toEqual([
      first.id,
      second.id,
    ]);
    expect(report?.messages.map((record) => record.seq)).toEqual([1, 2]);
    store.close();
  });

  it('does not truncate tool results', async () => {
    const store = makeStore();
    const long = 'x'.repeat(20_000);
    store.append(SESSION, userMessage('read it'));
    store.append(
      SESSION,
      assistantMessage('', {
        toolCalls: [{ id: 'a', name: 'read_file', argumentsJson: '{}' }],
      }),
    );
    store.append(SESSION, toolMessage('a', 'read_file', long));

    const report = await describeContext({
      store,
      loop,
      tools: TOOLS,
      sessionKey: SESSION,
      contextWindowTokens: 10_000,
    });
    const tool = report?.messages.find(
      (record) => record.message.role === 'tool',
    );

    // Truncating here would understate the budget the panel exists to explain,
    // and would break the object identity the mapping above depends on.
    expect(tool?.message.role === 'tool' && tool.message.content).toHaveLength(
      20_000,
    );
    store.close();
  });

  it('reads only past the consolidation marker, as the loop does', async () => {
    const store = makeStore();
    store.append(SESSION, userMessage('old and summarised'));
    store.append(SESSION, userMessage('still in the window'));
    store.updateSession(SESSION, { lastConsolidatedSeq: 1 });

    const report = await describeContext({
      store,
      loop,
      tools: TOOLS,
      sessionKey: SESSION,
      contextWindowTokens: 10_000,
    });

    expect(report?.messages.map((record) => record.seq)).toEqual([2]);
    store.close();
  });
});
