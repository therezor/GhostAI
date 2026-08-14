import { describe, expect, it } from 'vitest';

import {
  SessionStore,
  assistantMessage,
  systemMessage,
  toolMessage,
  userMessage,
} from '@ghostwire/core';
import type { ToolDefinition } from '@ghostwire/protocol';
import {
  estimateMessageTokens,
  estimateTokens,
  estimateToolTokens,
} from '@ghostwire/providers';

import { describeContext } from '#src/context.js';
import { runtimeReminder } from '#src/prompt.js';

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

  it('prices the request, not the record: reasoning is not billed', async () => {
    const store = makeStore();
    const plain = makeStore();
    const first = store.append(SESSION, userMessage('hello'));
    const second = store.append(
      SESSION,
      assistantMessage('hi', { reasoning: 'x'.repeat(4000) }),
    );
    plain.append(SESSION, userMessage('hello'));
    plain.append(SESSION, assistantMessage('hi'));

    const input = { loop, tools: TOOLS, sessionKey: SESSION } as const;
    const report = await describeContext({
      ...input,
      store,
      contextWindowTokens: 10_000,
    });
    const without = await describeContext({
      ...input,
      store: plain,
      contextWindowTokens: 10_000,
    });

    // Four thousand characters the wire never carries, and the same figure.
    expect(report?.breakdown.messages).toBe(without?.breakdown.messages);
    // The other half of the same case, and the reason they are one test: a
    // projection applied before the window is matched back to storage would
    // satisfy the assertion above and empty this one.
    expect(report?.messages.map((record) => record.id)).toEqual([
      first.id,
      second.id,
    ]);
    store.close();
    plain.close();
  });

  it('prices each half of the prompt inside the message it is sent in', async () => {
    const store = makeStore();
    store.append(SESSION, userMessage('hello'));

    const report = await describeContext({
      store,
      loop,
      tools: TOOLS,
      sessionKey: SESSION,
      contextWindowTokens: 10_000,
    });

    // Equality against the envelope the loop builds, not merely "bigger than
    // the string" — that would pass on any envelope, including a wrong one.
    expect(report?.breakdown.systemPrompt).toBe(
      estimateMessageTokens(systemMessage(PROMPT)),
    );
    expect(report?.breakdown.runtimeBlock).toBe(
      estimateMessageTokens(userMessage(runtimeReminder(RUNTIME))),
    );
    store.close();
  });

  it('bills a tool for what the body carries, not for its risk band', async () => {
    const store = makeStore();
    store.append(SESSION, userMessage('hello'));
    // Annotated, because a bare definition happens to encode to nearly the same
    // length as it stores at — the wrapper the body puts around it is about as
    // long as the two fields it drops. The bookkeeping a real tool carries is
    // what makes the two figures differ, so it is what this measures.
    const annotated: ToolDefinition = {
      ...TOOLS[0]!,
      risk: 'exec',
      source: 'mcp',
      annotations: {
        title: 'Read a file from the workspace',
        readOnlyHint: true,
        idempotentHint: true,
      },
    };

    const report = await describeContext({
      store,
      loop,
      tools: [annotated],
      sessionKey: SESSION,
      contextWindowTokens: 10_000,
    });

    expect(report?.breakdown.tools).toBe(estimateToolTokens([annotated]));
    // None of that reaches a model, so none of it is charged to the window.
    expect(report?.breakdown.tools).toBeLessThan(
      estimateTokens(JSON.stringify([annotated])),
    );
    store.close();
  });

  it('counts nothing for a half the request omits', async () => {
    const store = makeStore();
    store.append(SESSION, userMessage('hello'));

    const report = await describeContext({
      store,
      // Raw mode: the operator's template is the whole system message and the
      // loop appends no trailing user turn, so there is nothing to price.
      loop: {
        previewPrompt: () =>
          Promise.resolve({ staticPrompt: PROMPT, runtimeBlock: '' }),
      },
      tools: [],
      sessionKey: SESSION,
      contextWindowTokens: 10_000,
    });

    expect(report?.breakdown.runtimeBlock).toBe(0);
    expect(report?.breakdown.tools).toBe(0);
    store.close();
  });

  it('reads the whole stored conversation, as the loop does', async () => {
    const store = makeStore();
    store.append(SESSION, userMessage('the first thing said'));
    store.append(SESSION, userMessage('and the last'));

    const report = await describeContext({
      store,
      loop,
      tools: TOOLS,
      sessionKey: SESSION,
      contextWindowTokens: 10_000,
    });

    expect(report?.messages.map((record) => record.seq)).toEqual([1, 2]);
    store.close();
  });
});
