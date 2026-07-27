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
import { ConfigSchema, type Config } from '@ghostai/protocol';

import { HubApprovalGate } from '../approvals.js';
import { SessionHub, type TurnRunner } from '../hub.js';

export interface FakeRunner extends TurnRunner {
  /** Every turn this runner was asked to run, in order. */
  readonly inputs: TurnInput[];
  readonly steers: { sessionKey: string; content: string }[];
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

export function createTestHub(store: SessionStore, config?: Config, answer?: string): TestHub {
  const runner = fakeRunner(answer);
  const hub = new SessionHub({
    config: config ?? ConfigSchema.parse({}),
    loop: () => runner,
    store,
    approvals: new HubApprovalGate(),
  });
  return { hub, runner };
}
