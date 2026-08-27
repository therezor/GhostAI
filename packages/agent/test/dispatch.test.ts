/**
 * `ToolDispatcher`, driven directly.
 *
 * `loop.test.ts` reaches this file through a whole turn, which is the right
 * altitude for "does history stay legal" and the wrong one for "which calls ran
 * together": a scripted provider cannot say when a tool *started*, only what
 * came back. Here the scope is the double, so `started` is the observation —
 * two names in it before either has settled is the whole definition of a group.
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { silentLogger } from '@ghostwire/core';
import type { ToolCall, ToolPermission, ToolRisk } from '@ghostwire/protocol';
import type { ChatResult } from '@ghostwire/providers';
import {
  DEFAULT_TOOLS_CONFIG,
  defineTool,
  type AnyTool,
  type ToolContext,
  type ToolExecution,
  type ToolScope,
} from '@ghostwire/tools';

import {
  CANCELLED_TOOL_RESULT,
  MAX_PARALLEL_TOOL_CALLS,
  ToolDispatcher,
  type TurnScope,
} from '#src/dispatch.js';
import type { AgentEvent } from '#src/events.js';
import type { SubagentBinding } from '#src/subagent.js';
import { manualClock, toolCall, type ManualClock } from '#testkit/index.js';

/** Sixteen hex characters — `wrapToolOutput` refuses a guessable delimiter. */
const NONCE = '0123456789abcdef';

function tool(name: string, risk: ToolRisk = 'safe'): AnyTool {
  return defineTool({
    name,
    description: `${name}, for a test`,
    schema: z.strictObject({ key: z.string().optional() }),
    risk,
    execute: () => name,
  });
}

/** A call whose arguments carry its own id, so the double can address it. */
function call(id: string, name: string): ToolCall {
  return toolCall(id, name, { key: id });
}

interface FakeScope extends ToolScope {
  /** Call ids `execute` was entered for, in the order they were entered. */
  readonly started: readonly string[];
  /** Ids started and not yet settled. */
  readonly inFlight: readonly string[];
  settle(id: string, execution?: Partial<ToolExecution>): void;
  /** The seam a scope from outside the registry would come through. */
  reject(id: string, error: unknown): void;
}

function fakeScope(
  tools: readonly AnyTool[],
  permissions: Readonly<Record<string, ToolPermission>> = {},
): FakeScope {
  const byName = new Map(tools.map((entry) => [entry.name, entry]));
  const waiting = new Map<
    string,
    {
      resolve: (execution: ToolExecution) => void;
      reject: (error: unknown) => void;
    }
  >();
  const started: string[] = [];

  return {
    definitions: () => [],
    get: (name) => byName.get(name),
    permissionFor: (name) => permissions[name] ?? 'allow',
    execute: async (invocation) => {
      const args = JSON.parse(invocation.argumentsJson ?? '{}') as {
        key?: string;
      };
      const id = args.key ?? invocation.name;
      started.push(id);
      return await new Promise<ToolExecution>((resolve, reject) => {
        waiting.set(id, { resolve, reject });
      });
    },
    started,
    get inFlight() {
      return [...waiting.keys()];
    },
    settle(id, execution) {
      const pending = waiting.get(id);
      if (pending === undefined) throw new Error(`nothing running for ${id}`);
      waiting.delete(id);
      pending.resolve({
        name: id,
        content: `${id} finished`,
        isError: false,
        truncated: false,
        durationMs: 1,
        ...execution,
      });
    },
    reject(id, error) {
      const pending = waiting.get(id);
      if (pending === undefined) throw new Error(`nothing running for ${id}`);
      waiting.delete(id);
      pending.reject(error);
    },
  };
}

interface Harness {
  readonly events: AgentEvent[];
  readonly scope: FakeScope;
  readonly clock: ManualClock;
  readonly controller: AbortController;
  /** Resolves when the whole batch has been dispatched. */
  readonly done: Promise<{
    cancelled: boolean;
    pending: readonly unknown[];
  }>;
}

interface HarnessOptions {
  readonly tools?: readonly AnyTool[];
  readonly permissions?: Readonly<Record<string, ToolPermission>>;
  readonly subagents?: ReadonlyMap<string, SubagentBinding>;
  readonly toolsEnabled?: boolean;
  readonly heartbeatMs?: number;
}

function dispatch(
  calls: readonly ToolCall[],
  options: HarnessOptions = {},
): Harness {
  const clock = manualClock();
  const controller = new AbortController();
  const scope = fakeScope(
    options.tools ?? [tool('read'), tool('write', 'write')],
    options.permissions ?? {},
  );

  const dispatcher = new ToolDispatcher({
    tools: scope,
    subagents: options.subagents ?? new Map(),
    approvals: undefined,
    toolsConfig: DEFAULT_TOOLS_CONFIG,
    toolsEnabled: options.toolsEnabled ?? true,
    maxToolResultChars: 4_000,
    heartbeatMs: options.heartbeatMs ?? 15_000,
    agentId: 'main',
    clock,
    logger: silentLogger,
    // eslint-disable-next-line require-yield
    delegate: async function* delegate(delegated) {
      return {
        name: delegated.name,
        content: 'delegated',
        isError: false,
        truncated: false,
        durationMs: 1,
      };
    },
  });

  const turn: TurnScope = {
    sessionKey: 'session',
    turnId: 'turn-1',
    nonce: NONCE,
    signal: controller.signal,
    toolContext: {
      signal: controller.signal,
      config: DEFAULT_TOOLS_CONFIG,
    } as unknown as ToolContext,
    workspaceId: 'default',
    chain: [],
    rootSessionKey: 'session',
  };

  const result = {
    message: { role: 'assistant', content: '', toolCalls: calls },
  } as unknown as ChatResult;

  const events: AgentEvent[] = [];
  const iterator = dispatcher.dispatch(result, turn);
  const done = (async () => {
    for (;;) {
      const step = await iterator.next();
      if (step.done === true) return step.value;
      events.push(step.value);
    }
  })();

  return { events, scope, clock, controller, done };
}

/**
 * Drains the microtask queue completely.
 *
 * A macrotask rather than a fixed number of `await Promise.resolve()` turns:
 * pumping the generator one step costs an unknown number of microtasks, and a
 * count that happens to be enough today is the kind of test that fails on a
 * loaded runner and nowhere else.
 */
async function flush(): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

function resultsOf(events: readonly AgentEvent[]): readonly string[] {
  return events
    .filter((event) => event.type === 'tool.result')
    .map((event) => event.callId);
}

describe('ToolDispatcher grouping', () => {
  it('runs adjacent read-only calls together', async () => {
    const run = dispatch([call('c1', 'read'), call('c2', 'read')]);
    await flush();

    expect(run.scope.started).toEqual(['c1', 'c2']);
    expect(run.scope.inFlight).toEqual(['c1', 'c2']);

    run.scope.settle('c2');
    run.scope.settle('c1');
    const outcome = await run.done;

    // Out of order on the wire, in the model's order in history.
    expect(resultsOf(run.events)).toEqual(['c2', 'c1']);
    expect(outcome.pending).toHaveLength(3);
    expect(outcome.cancelled).toBe(false);
  });

  it('never starts the next call while one is running on its own', async () => {
    const run = dispatch([call('c1', 'write'), call('c2', 'write')]);
    await flush();

    expect(run.scope.started).toEqual(['c1']);

    run.scope.settle('c1');
    await flush();
    expect(run.scope.started).toEqual(['c1', 'c2']);

    run.scope.settle('c2');
    await run.done;
    expect(resultsOf(run.events)).toEqual(['c1', 'c2']);
  });

  it('does not reorder a read past a write', async () => {
    const run = dispatch([
      call('c1', 'read'),
      call('c2', 'read'),
      call('c3', 'write'),
      call('c4', 'read'),
    ]);
    await flush();

    // Three groups: [c1‖c2], c3, c4 — not one group of three reads.
    expect(run.scope.started).toEqual(['c1', 'c2']);
    run.scope.settle('c1');
    run.scope.settle('c2');
    await flush();

    expect(run.scope.started).toEqual(['c1', 'c2', 'c3']);
    run.scope.settle('c3');
    await flush();

    expect(run.scope.started).toEqual(['c1', 'c2', 'c3', 'c4']);
    run.scope.settle('c4');
    await run.done;
  });

  it('splits a group at MAX_PARALLEL_TOOL_CALLS', async () => {
    const calls: ToolCall[] = [];
    for (let index = 0; index < MAX_PARALLEL_TOOL_CALLS + 2; index += 1) {
      calls.push(call(`c${String(index)}`, 'read'));
    }
    const run = dispatch(calls);
    await flush();

    expect(run.scope.started).toHaveLength(MAX_PARALLEL_TOOL_CALLS);
    for (const started of [...run.scope.inFlight]) run.scope.settle(started);
    await flush();

    expect(run.scope.started).toHaveLength(MAX_PARALLEL_TOOL_CALLS + 2);
    for (const started of [...run.scope.inFlight]) run.scope.settle(started);
    await run.done;
  });

  it('never groups a name the scope cannot resolve', async () => {
    const run = dispatch([call('c1', 'read'), call('c2', 'invented')]);
    await flush();

    // `riskOf` answers `safe` for an unknown name; the grouping predicate asks
    // `tools.get` instead, so the invented call waits its turn.
    expect(run.scope.started).toEqual(['c1']);
    run.scope.settle('c1');
    await flush();
    run.scope.settle('c2');
    await run.done;
  });

  it('never groups a read-only tool the operator set to ask', async () => {
    const run = dispatch([call('c1', 'read'), call('c2', 'read')], {
      permissions: { read: 'ask' },
    });
    await flush();

    expect(run.scope.started).toEqual(['c1']);
    run.scope.settle('c1');
    await flush();
    run.scope.settle('c2');
    await run.done;
  });

  it('never groups a delegation', async () => {
    const binding: SubagentBinding = {
      toolName: 'ask_helper',
      agentId: 'helper',
      label: 'Helper',
      prompt: '',
      permission: 'allow',
    };
    const run = dispatch(
      [call('c1', 'read'), call('c2', 'ask_helper'), call('c3', 'read')],
      { subagents: new Map([['ask_helper', binding]]) },
    );
    await flush();

    // c1 alone: the delegation between the two reads breaks the run, and a
    // delegation never joins one.
    expect(run.scope.started).toEqual(['c1']);
    run.scope.settle('c1');
    await flush();

    // The delegate answered without touching the scope.
    expect(run.scope.started).toEqual(['c1', 'c3']);
    run.scope.settle('c3');
    const outcome = await run.done;
    expect(resultsOf(run.events)).toEqual(['c1', 'c2', 'c3']);
    expect(outcome.pending).toHaveLength(4);
  });

  it('groups nothing when tool calling is switched off', async () => {
    const run = dispatch([call('c1', 'read'), call('c2', 'read')], {
      toolsEnabled: false,
    });
    const outcome = await run.done;

    expect(run.scope.started).toEqual([]);
    expect(outcome.pending).toHaveLength(3);
    expect(resultsOf(run.events)).toEqual(['c1', 'c2']);
  });
});

describe('ToolDispatcher cancellation', () => {
  it('answers every member of a group when the turn is stopped', async () => {
    const run = dispatch([call('c1', 'read'), call('c2', 'read')]);
    await flush();

    run.controller.abort();
    run.scope.settle('c1', {
      isError: true,
      errorKind: 'aborted',
      content: 'aborted',
    });
    run.scope.settle('c2', {
      isError: true,
      errorKind: 'aborted',
      content: 'aborted',
    });
    const outcome = await run.done;

    expect(outcome.cancelled).toBe(true);
    expect(resultsOf(run.events)).toEqual(['c1', 'c2']);
    expect(outcome.pending).toHaveLength(3);
  });

  it('reports a later group of several as never run', async () => {
    const run = dispatch([
      call('c1', 'read'),
      call('c2', 'write'),
      call('c3', 'read'),
      call('c4', 'read'),
    ]);
    await flush();

    // Groups are [c1], [c2], [c3‖c4] — so the abort on the first lands before
    // a *group* rather than before a single call.
    expect(run.scope.started).toEqual(['c1']);
    run.scope.settle('c1', {
      isError: true,
      errorKind: 'aborted',
      content: 'aborted',
    });
    const outcome = await run.done;

    expect(run.scope.started).toEqual(['c1']);
    expect(outcome.cancelled).toBe(true);
    expect(resultsOf(run.events)).toEqual(['c1', 'c2', 'c3', 'c4']);
    const contents = run.events
      .filter((event) => event.type === 'tool.result')
      .map((event) => event.content);
    expect(contents.slice(1)).toEqual([
      CANCELLED_TOOL_RESULT,
      CANCELLED_TOOL_RESULT,
      CANCELLED_TOOL_RESULT,
    ]);
  });

  it('reports a later group as never run', async () => {
    const run = dispatch([
      call('c1', 'read'),
      call('c2', 'write'),
      call('c3', 'write'),
    ]);
    await flush();

    run.scope.settle('c1', {
      isError: true,
      errorKind: 'aborted',
      content: 'aborted',
    });
    const outcome = await run.done;

    // c2 and c3 are each their own group, and neither was entered.
    expect(run.scope.started).toEqual(['c1']);
    expect(outcome.cancelled).toBe(true);
    const contents = run.events
      .filter((event) => event.type === 'tool.result')
      .map((event) => event.content);
    expect(contents.slice(1)).toEqual([
      CANCELLED_TOOL_RESULT,
      CANCELLED_TOOL_RESULT,
    ]);
  });
});

describe('ToolDispatcher failure', () => {
  it('surfaces a rejecting scope as a thrown turn, not an unhandled rejection', async () => {
    const run = dispatch([call('c1', 'read'), call('c2', 'read')]);
    await flush();

    // `ToolRegistry.execute` never throws, so only a scope from somewhere else
    // reaches this. It has to unwind the turn the way the sequential `await`
    // does rather than escaping as an unhandled rejection.
    run.scope.reject('c1', new Error('scope exploded'));

    await expect(run.done).rejects.toThrow('scope exploded');
  });
});

describe('ToolDispatcher heartbeat', () => {
  it('reports every call still running on one shared cadence', async () => {
    const run = dispatch([call('c1', 'read'), call('c2', 'read')]);
    await flush();

    run.clock.advance(15_000);
    await flush();

    const progress = run.events.filter(
      (event) => event.type === 'tool.progress',
    );
    expect(progress.map((event) => event.callId)).toEqual(['c1', 'c2']);

    // One call finishing leaves the other reporting alone.
    run.scope.settle('c1');
    await flush();
    run.clock.advance(15_000);
    await flush();

    const second = run.events
      .filter((event) => event.type === 'tool.progress')
      .slice(2);
    expect(second.map((event) => event.callId)).toEqual(['c2']);

    run.scope.settle('c2');
    await run.done;
    expect(run.clock.pending).toBe(0);
  });
});
