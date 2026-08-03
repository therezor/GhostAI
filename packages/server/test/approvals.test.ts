import { describe, expect, it } from 'vitest';

import type { ApprovalRequest } from '@ghostai/agent';
import type { Clock, TimerHandle } from '@ghostai/core';

import { HubApprovalGate, type UnattendedApproval } from '#src/approvals.js';

const START_MS = 1_700_000_000_000;
const TIMEOUT_MS = 60_000;

interface ManualClock extends Clock {
  advance(ms: number): void;
  readonly pending: number;
}

/**
 * Timers that fire when the test says so.
 *
 * The gate's deadline is the thing under test in two of the cases below, and a
 * clock that is a parameter states the advance where the assertion is instead
 * of interleaving `vi.advanceTimersByTime` with the promise it is racing.
 */
function manualClock(): ManualClock {
  const timers = new Map<number, { at: number; callback: () => void }>();
  let elapsed = 0;
  let nextId = 1;

  return {
    now: () => START_MS + elapsed,
    monotonic: () => elapsed,
    setTimeout(callback, delayMs) {
      const id = nextId++;
      timers.set(id, { at: elapsed + delayMs, callback });
      return id as unknown as TimerHandle;
    },
    clearTimeout(handle) {
      timers.delete(handle as unknown as number);
    },
    sleep: () => Promise.resolve(),
    advance(ms) {
      elapsed += ms;
      for (const [id, timer] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
        if (timer.at > elapsed) continue;
        timers.delete(id);
        timer.callback();
      }
    },
    get pending() {
      return timers.size;
    },
  };
}

interface RequestOptions {
  readonly sessionKey?: string;
  readonly agentId?: string;
  readonly callId?: string;
  readonly name?: string;
  readonly signal?: AbortSignal;
  readonly expiresAtMs?: number;
}

function approvalRequest(options: RequestOptions = {}): ApprovalRequest {
  return {
    sessionKey: options.sessionKey ?? 'web:1',
    agentId: options.agentId ?? 'default',
    turnId: 'turn-1',
    callId: options.callId ?? 'call-1',
    name: options.name ?? 'exec',
    args: { argv: ['ls'] },
    risk: 'exec',
    expiresAtMs: options.expiresAtMs ?? START_MS + TIMEOUT_MS,
    signal: options.signal ?? new AbortController().signal,
  };
}

describe('HubApprovalGate', () => {
  it('parks a request until a client answers it', async () => {
    const gate = new HubApprovalGate({ clock: manualClock() });
    const pending = gate.request(approvalRequest());

    expect(gate.pendingCount).toBe(1);
    expect(gate.resolve('call-1', true, 'once')).toBe(true);

    await expect(pending).resolves.toEqual({ approved: true, scope: 'once' });
    expect(gate.pendingCount).toBe(0);
  });

  it('answers to nobody for an unknown call id', () => {
    const gate = new HubApprovalGate({ clock: manualClock() });
    expect(gate.resolve('call-nobody-asked-about', true, 'once')).toBe(false);
  });

  it('does not remember an answer scoped to once', async () => {
    const gate = new HubApprovalGate({ clock: manualClock() });

    const first = gate.request(approvalRequest({ callId: 'a' }));
    gate.resolve('a', true, 'once');
    await first;

    const second = gate.request(approvalRequest({ callId: 'b' }));
    expect(gate.pendingCount).toBe(1);
    gate.resolve('b', true, 'once');
    await second;
  });

  it('remembers a session-scoped answer for that session alone', async () => {
    const gate = new HubApprovalGate({ clock: manualClock() });

    const first = gate.request(
      approvalRequest({ callId: 'a', sessionKey: 'web:1' }),
    );
    gate.resolve('a', true, 'session');
    await first;

    // Same session, same tool: answered without asking.
    await expect(
      gate.request(approvalRequest({ callId: 'b', sessionKey: 'web:1' })),
    ).resolves.toEqual({ approved: true, scope: 'session' });
    expect(gate.pendingCount).toBe(0);

    // Another session has not answered anything.
    void gate.request(approvalRequest({ callId: 'c', sessionKey: 'web:2' }));
    expect(gate.pendingCount).toBe(1);
  });

  it('remembers an always-scoped answer across sessions', async () => {
    const gate = new HubApprovalGate({ clock: manualClock() });

    const first = gate.request(
      approvalRequest({ callId: 'a', sessionKey: 'web:1' }),
    );
    gate.resolve('a', true, 'always');
    await first;

    await expect(
      gate.request(approvalRequest({ callId: 'b', sessionKey: 'telegram:9' })),
    ).resolves.toEqual({ approved: true, scope: 'always' });
  });

  it('remembers a refusal exactly like an approval', async () => {
    const gate = new HubApprovalGate({ clock: manualClock() });

    const first = gate.request(approvalRequest({ callId: 'a' }));
    gate.resolve('a', false, 'session');
    await expect(first).resolves.toEqual({ approved: false, scope: 'session' });

    await expect(
      gate.request(approvalRequest({ callId: 'b' })),
    ).resolves.toEqual({
      approved: false,
      scope: 'session',
    });
  });

  it('scopes memory by tool name, so another tool still asks', async () => {
    const gate = new HubApprovalGate({ clock: manualClock() });

    const first = gate.request(approvalRequest({ callId: 'a', name: 'exec' }));
    gate.resolve('a', true, 'session');
    await first;

    void gate.request(approvalRequest({ callId: 'b', name: 'write_file' }));
    expect(gate.pendingCount).toBe(1);
  });

  it('denies when the deadline passes unanswered', async () => {
    const clock = manualClock();
    const gate = new HubApprovalGate({ clock });
    const pending = gate.request(approvalRequest());

    clock.advance(TIMEOUT_MS);

    await expect(pending).resolves.toMatchObject({ approved: false });
    expect(gate.pendingCount).toBe(0);
    expect(clock.pending).toBe(0);
  });

  it('denies immediately when the deadline has already passed', async () => {
    const clock = manualClock();
    const gate = new HubApprovalGate({ clock });
    const pending = gate.request(
      approvalRequest({ expiresAtMs: START_MS - 1 }),
    );

    clock.advance(0);

    await expect(pending).resolves.toMatchObject({ approved: false });
  });

  it('drops a prompt when its turn is cancelled', async () => {
    const clock = manualClock();
    const gate = new HubApprovalGate({ clock });
    const controller = new AbortController();
    const pending = gate.request(
      approvalRequest({ signal: controller.signal }),
    );

    controller.abort();

    await expect(pending).resolves.toMatchObject({ approved: false });
    expect(gate.pendingCount).toBe(0);
    // The timer is disarmed too: a cancelled turn must not leave the clock
    // holding a callback for a prompt nobody can see.
    expect(clock.pending).toBe(0);
  });

  it('refuses without parking when the turn is already cancelled', async () => {
    const gate = new HubApprovalGate({ clock: manualClock() });
    const controller = new AbortController();
    controller.abort();

    await expect(
      gate.request(approvalRequest({ signal: controller.signal })),
    ).resolves.toMatchObject({ approved: false });
    expect(gate.pendingCount).toBe(0);
  });

  it('supersedes an earlier prompt that reused a call id', async () => {
    const gate = new HubApprovalGate({ clock: manualClock() });
    const first = gate.request(approvalRequest({ callId: 'call-1' }));
    const second = gate.request(approvalRequest({ callId: 'call-1' }));

    await expect(first).resolves.toMatchObject({ approved: false });
    expect(gate.pendingCount).toBe(1);

    gate.resolve('call-1', true, 'once');
    await expect(second).resolves.toMatchObject({ approved: true });
  });

  it('settles pending prompts and forgets memory when a session closes', async () => {
    const gate = new HubApprovalGate({ clock: manualClock() });

    const remembered = gate.request(
      approvalRequest({ callId: 'a', sessionKey: 'web:1' }),
    );
    gate.resolve('a', true, 'session');
    await remembered;

    const pending = gate.request(
      approvalRequest({ callId: 'b', sessionKey: 'web:2' }),
    );
    gate.clearSession('web:2');
    await expect(pending).resolves.toMatchObject({ approved: false });

    gate.clearSession('web:1');
    void gate.request(approvalRequest({ callId: 'c', sessionKey: 'web:1' }));
    expect(gate.pendingCount).toBe(1);
  });
});

describe('HubApprovalGate when nobody is watching', () => {
  /** A gate that records what it raised, over a watcher count the test sets. */
  function watched(counts: Record<string, number>): {
    gate: HubApprovalGate;
    raised: UnattendedApproval[];
  } {
    const raised: UnattendedApproval[] = [];
    const gate = new HubApprovalGate({
      clock: manualClock(),
      watchers: (sessionKey) => counts[sessionKey] ?? 0,
      onUnattended: (approval) => raised.push(approval),
    });
    return { gate, raised };
  }

  it('raises the request that reached an empty room', () => {
    // A scheduled run's session is its own and nothing subscribes to it, so the
    // prompt goes nowhere and the turn waits out the whole timeout for a denial
    // that was certain when it was raised. This is what sends someone to look.
    const { gate, raised } = watched({});
    void gate.request(
      approvalRequest({ sessionKey: 'automation:job-1:run-1', name: 'exec' }),
    );

    expect(raised).toEqual([
      {
        sessionKey: 'automation:job-1:run-1',
        agentId: 'default',
        toolName: 'exec',
        expiresAtMs: START_MS + TIMEOUT_MS,
      },
    ]);
  });

  it('stays quiet when a tab is open on the session', () => {
    const { gate, raised } = watched({ 'web:1': 1 });
    void gate.request(approvalRequest({ sessionKey: 'web:1' }));
    expect(raised).toHaveLength(0);
  });

  it('does not raise for a call answered from memory, which asks nobody', () => {
    const { gate, raised } = watched({});
    void gate.request(approvalRequest({ callId: 'a', sessionKey: 's' }));
    gate.resolve('a', true, 'session');
    raised.length = 0;

    // Second call on the same session: settled by the remembered answer without
    // ever being parked, so there is nothing for anyone to come and do.
    void gate.request(approvalRequest({ callId: 'b', sessionKey: 's' }));
    expect(raised).toHaveLength(0);
  });

  it('does not raise for a turn that was already cancelled', () => {
    const controller = new AbortController();
    controller.abort();
    const { gate, raised } = watched({});

    void gate.request(approvalRequest({ signal: controller.signal }));
    expect(raised).toHaveLength(0);
  });

  it('raises once when it parks, not again when it expires', () => {
    // A notification saying "this needed you five minutes ago" is worse than
    // none: by the timeout the answer is already decided.
    const raised: UnattendedApproval[] = [];
    const clock = manualClock();
    const gate = new HubApprovalGate({
      clock,
      watchers: () => 0,
      onUnattended: (approval) => raised.push(approval),
    });

    void gate.request(approvalRequest());
    expect(raised).toHaveLength(1);
    clock.advance(TIMEOUT_MS);
    expect(raised).toHaveLength(1);
  });

  it('treats an untracked deployment as attended, so a fixture raises nothing', () => {
    // Neither hook wired is every path except the live server. Defaulting the
    // other way would raise a notification for every prompt the CLI shows.
    const raised: UnattendedApproval[] = [];
    const gate = new HubApprovalGate({
      clock: manualClock(),
      onUnattended: (a) => raised.push(a),
    });

    void gate.request(approvalRequest());
    expect(raised).toHaveLength(0);
  });
});

describe('HubApprovalGate across agents', () => {
  it('does not let one agent’s standing answer pre-approve another’s call', async () => {
    // Two agents are configured with deliberately different permissions. An
    // "always allow" granted while using the permissive one must not silently
    // undo the restriction on the locked-down one.
    const gate = new HubApprovalGate({ clock: manualClock() });

    const granted = gate.request(
      approvalRequest({ agentId: 'writer', callId: 'c1' }),
    );
    gate.resolve('c1', true, 'always');
    await expect(granted).resolves.toMatchObject({ approved: true });

    // Same tool, same session, different agent: still has to ask.
    const pending = gate.request(
      approvalRequest({ agentId: 'reviewer', callId: 'c2' }),
    );
    expect(gate.pendingCount).toBe(1);

    gate.resolve('c2', false, 'once');
    await expect(pending).resolves.toMatchObject({ approved: false });
  });

  it('remembers a standing answer for the agent it was given to', async () => {
    const gate = new HubApprovalGate({ clock: manualClock() });

    const first = gate.request(
      approvalRequest({ agentId: 'writer', callId: 'c1' }),
    );
    gate.resolve('c1', true, 'always');
    await first;

    // A different session, the same agent: answered from memory, nothing parks.
    await expect(
      gate.request(
        approvalRequest({
          agentId: 'writer',
          sessionKey: 'web:2',
          callId: 'c2',
        }),
      ),
    ).resolves.toMatchObject({ approved: true, scope: 'always' });
    expect(gate.pendingCount).toBe(0);
  });

  it('keeps a session-scoped answer to that session, whoever runs it', async () => {
    const gate = new HubApprovalGate({ clock: manualClock() });

    const first = gate.request(
      approvalRequest({ agentId: 'writer', callId: 'c1' }),
    );
    gate.resolve('c1', true, 'session');
    await first;

    // A session is bound to one agent, so the session scope needs no agent
    // dimension — but it must not reach a different session.
    void gate.request(
      approvalRequest({ sessionKey: 'web:2', agentId: 'writer', callId: 'c2' }),
    );
    expect(gate.pendingCount).toBe(1);
  });
});

describe('HubApprovalGate when an agent goes away', () => {
  it('forgets a departed agent’s standing answers', async () => {
    // The bug this exists to stop: an agent id is user-authored, so deleting
    // `reviewer` and creating a new `reviewer` produces two different agents
    // that share a key — and the second would inherit the first's permissions.
    const gate = new HubApprovalGate({ clock: manualClock() });

    const granted = gate.request(
      approvalRequest({ agentId: 'reviewer', callId: 'c1' }),
    );
    gate.resolve('c1', true, 'always');
    await granted;

    gate.retainAgents(new Set(['default']));

    // The re-created agent has to ask for itself.
    void gate.request(
      approvalRequest({
        agentId: 'reviewer',
        sessionKey: 'web:2',
        callId: 'c2',
      }),
    );
    expect(gate.pendingCount).toBe(1);
  });

  it('keeps the standing answers of agents that are still configured', async () => {
    const gate = new HubApprovalGate({ clock: manualClock() });

    const granted = gate.request(
      approvalRequest({ agentId: 'writer', callId: 'c1' }),
    );
    gate.resolve('c1', true, 'always');
    await granted;

    gate.retainAgents(new Set(['default', 'writer']));

    await expect(
      gate.request(
        approvalRequest({
          agentId: 'writer',
          sessionKey: 'web:2',
          callId: 'c2',
        }),
      ),
    ).resolves.toMatchObject({ approved: true, scope: 'always' });
    expect(gate.pendingCount).toBe(0);
  });

  it('leaves session-scoped answers alone, which belong to the conversation', async () => {
    const gate = new HubApprovalGate({ clock: manualClock() });

    const granted = gate.request(
      approvalRequest({ agentId: 'reviewer', callId: 'c1' }),
    );
    gate.resolve('c1', true, 'session');
    await granted;

    gate.retainAgents(new Set(['default']));

    // Same session, so the conversation's own answer still stands — a
    // conversation does not stop existing because an agent did.
    await expect(
      gate.request(approvalRequest({ agentId: 'reviewer', callId: 'c2' })),
    ).resolves.toMatchObject({ approved: true });
  });

  it('carries a standing answer across a rename, which is the same agent', async () => {
    const gate = new HubApprovalGate({ clock: manualClock() });

    const granted = gate.request(
      approvalRequest({ agentId: 'reviewer', callId: 'c1' }),
    );
    gate.resolve('c1', true, 'always');
    await granted;

    gate.renameAgent('reviewer', 'code-review');

    await expect(
      gate.request(
        approvalRequest({
          agentId: 'code-review',
          sessionKey: 'web:2',
          callId: 'c2',
        }),
      ),
    ).resolves.toMatchObject({ approved: true, scope: 'always' });
    // And nothing is left behind under the old name.
    void gate.request(
      approvalRequest({
        agentId: 'reviewer',
        sessionKey: 'web:3',
        callId: 'c3',
      }),
    );
    expect(gate.pendingCount).toBe(1);
  });

  it('renames an agent that has no standing answers without inventing any', () => {
    const gate = new HubApprovalGate({ clock: manualClock() });

    expect(() => {
      gate.renameAgent('reviewer', 'code-review');
    }).not.toThrow();
  });
});
