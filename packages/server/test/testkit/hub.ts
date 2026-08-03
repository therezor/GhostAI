/**
 * A hub over a turn that answers instantly.
 *
 * `createServer` requires a `SessionHub` — the socket route is in the manifest,
 * so a server without one would serve a route over nothing — and a route test
 * has no interest in what a turn does. This builds the real hub over a scripted
 * runner, which is the same trick `hub.test.ts` uses, minus the ability to
 * suspend a turn mid-event that only that file needs.
 *
 * Not exported from `index.ts`: it is test scaffolding.
 */

import type { AgentEvent, TurnInput, TurnResult } from '@ghostai/agent';
import type { SessionStore } from '@ghostai/core';
import { ConfigSchema, DEFAULT_AGENT_ID, type Config } from '@ghostai/protocol';

import { HubApprovalGate } from '#src/approvals.js';
import { SessionHub, type TurnRunner } from '#src/hub.js';

export interface FakeRunner extends TurnRunner {
  /** Every turn this runner was asked to run, in order. */
  readonly inputs: TurnInput[];
  readonly steers: { sessionKey: string; content: string }[];
}

/**
 * A turn that starts and never ends.
 *
 * For the guards that only exist while a session is busy — branching mid-turn,
 * regenerating under a running answer. The instant runner above cannot express
 * those: it is finished before the assertion runs.
 */
export function hangingRunner(): FakeRunner {
  const inputs: TurnInput[] = [];
  const steers: { sessionKey: string; content: string }[] = [];

  return {
    inputs,
    steers,
    run: async function* (input: TurnInput): AsyncGenerator<AgentEvent, TurnResult> {
      inputs.push(input);
      const turnId = input.turnId ?? 'turn-1';
      yield {
        type: 'turn.start',
        agentId: 'default',
        sessionKey: input.sessionKey,
        turnId,
        model: 'test-model',
        provider: 'test',
      };
      await new Promise<void>(() => {
        // Never resolves; the harness closes the hub in its cleanup.
      });
      throw new Error('unreachable');
    },
    steer(sessionKey: string, content: string): void {
      steers.push({ sessionKey, content });
    },
  };
}

/** A turn that says one thing and ends. */
export function fakeRunner(answer = 'ok'): FakeRunner {
  const inputs: TurnInput[] = [];
  const steers: { sessionKey: string; content: string }[] = [];

  return {
    inputs,
    steers,
    run: async function* (input: TurnInput): AsyncGenerator<AgentEvent, TurnResult> {
      inputs.push(input);
      const turnId = input.turnId ?? 'turn-1';
      yield {
        type: 'turn.start',
        agentId: 'default',
        sessionKey: input.sessionKey,
        turnId,
        model: 'test-model',
        provider: 'test',
      };
      yield { type: 'assistant.delta', turnId, text: answer };
      yield { type: 'turn.end', turnId, stopReason: 'complete', iterations: 1 };
      return {
        turnId,
        stopReason: 'complete',
        iterations: 1,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        text: answer,
      };
    },
    steer: (sessionKey, content) => {
      steers.push({ sessionKey, content });
    },
  };
}

export interface TestHub {
  readonly hub: SessionHub;
  readonly runner: FakeRunner;
}

export function createTestHub(
  store: SessionStore,
  config?: Config,
  answer?: string,
  supplied?: FakeRunner,
): TestHub {
  const runner = supplied ?? fakeRunner(answer);
  const resolved = config ?? ConfigSchema.parse({});
  const hub = new SessionHub({
    config: resolved,
    loop: () => runner,
    // The real rule, off the config the test supplied, so a test that sets up
    // an agent the way an operator would gets the behaviour an operator would.
    // Reimplementing it as "everything resolves" would make the fallback the
    // one thing these tests could never see.
    resolveAgentId: (agentId) => {
      const id = agentId === undefined || agentId === '' ? DEFAULT_AGENT_ID : agentId;
      if (id === DEFAULT_AGENT_ID) return { agentId: id, miss: undefined };
      const entry = resolved.agents.list[id];
      if (entry?.enabled === true) return { agentId: id, miss: undefined };
      return { agentId: DEFAULT_AGENT_ID, miss: entry === undefined ? 'unknown' : 'disabled' };
    },
    store,
    approvals: new HubApprovalGate(),
  });
  return { hub, runner };
}
