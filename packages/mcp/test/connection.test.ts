import { GhostError } from '@ghostwire/core';
import { McpServerConfigSchema } from '@ghostwire/protocol';
import type { AnyTool } from '@ghostwire/tools';
import { describe, expect, it } from 'vitest';

import { McpConnection } from '#src/connection.js';
import { resolveSpec, type McpConnectionSpec } from '#src/spec.js';
import { manualClock, type ManualClock } from '#testkit/clock.js';
import {
  ECHO_TOOL,
  fakeServer,
  type FakeServer,
} from '#testkit/fake-server.js';

function specFor(overrides: Record<string, unknown> = {}): McpConnectionSpec {
  const resolution = resolveSpec(
    'demo',
    McpServerConfigSchema.parse({ command: 'npx', ...overrides }),
  );
  if (!resolution.ok) throw resolution.error;
  return resolution.spec;
}

interface Harness {
  readonly connection: McpConnection;
  readonly server: FakeServer;
  readonly clock: ManualClock;
  readonly published: ReadonlyArray<readonly string[]>;
  /** The names registered right now. */
  current(): readonly string[];
  /** Lets every already-resolved promise settle. */
  settle(): Promise<void>;
}

function harness(
  options: { spec?: McpConnectionSpec; server?: FakeServer } = {},
): Harness {
  const clock = manualClock();
  const server = options.server ?? fakeServer();
  const published: Array<readonly string[]> = [];

  const connection = new McpConnection({
    spec: options.spec ?? specFor(),
    connect: server.connect,
    publish: (serverId, tools: readonly AnyTool[]) => {
      published.push(tools.map((tool) => tool.name));
    },
    clock,
    // No jitter, so the cadence is the thing under test rather than a
    // distribution over it.
    backoff: { jitter: (ceiling) => ceiling },
  });

  return {
    connection,
    server,
    clock,
    published,
    current: () => published.at(-1) ?? [],
    settle: async () => {
      // Four turns: dial, listTools, republish, and the publish callback.
      for (let index = 0; index < 6; index += 1) await Promise.resolve();
    },
  };
}

describe('McpConnection', () => {
  it('registers the server tools it can reach', async () => {
    const test = harness();
    test.connection.start();
    await test.settle();

    expect(test.connection.state).toBe('ready');
    expect(test.current()).toEqual(['mcp_demo_echo']);
    expect(test.connection.status.serverName).toBe('fake-demo');
    await test.connection.close();
  });

  it('records when it last connected, for the status row', async () => {
    const test = harness();
    test.connection.start();
    await test.settle();
    expect(test.connection.status.lastConnectedAtMs).toBe(test.clock.now());
    await test.connection.close();
  });

  it('re-lists when the server says its tools moved', async () => {
    const test = harness();
    test.connection.start();
    await test.settle();

    test.server.setTools([ECHO_TOOL, { ...ECHO_TOOL, name: 'reverse' }]);
    await test.settle();

    expect(test.current()).toEqual(['mcp_demo_echo', 'mcp_demo_reverse']);
    await test.connection.close();
  });

  it('unregisters its tools the moment the server goes away', async () => {
    const test = harness();
    test.connection.start();
    await test.settle();
    expect(test.current()).toEqual(['mcp_demo_echo']);

    test.server.drop();
    await test.settle();

    // A turn starting now must not be offered a tool nothing can answer.
    expect(test.current()).toEqual([]);
    expect(test.connection.state).toBe('failed');
    await test.connection.close();
  });

  it('retries on a widening backoff and comes back on its own', async () => {
    const server = fakeServer();
    server.failConnects(new GhostError('network', 'ECONNREFUSED'));
    const test = harness({ server });

    test.connection.start();
    await test.settle();
    expect(test.connection.state).toBe('failed');
    expect(server.attempts).toBe(1);

    // Nothing before the first delay is due.
    test.clock.advance(999);
    await test.settle();
    expect(server.attempts).toBe(1);

    test.clock.advance(1);
    await test.settle();
    expect(server.attempts).toBe(2);

    // Doubling: the second wait is 2 s, the third 4 s.
    test.clock.advance(1_999);
    await test.settle();
    expect(server.attempts).toBe(2);
    test.clock.advance(1);
    await test.settle();
    expect(server.attempts).toBe(3);

    server.recover();
    test.clock.advance(4_000);
    await test.settle();
    expect(test.connection.state).toBe('ready');
    expect(test.current()).toEqual(['mcp_demo_echo']);
    await test.connection.close();
  });

  it('never waits longer than the ceiling', async () => {
    const server = fakeServer();
    server.failConnects(new GhostError('network', 'ECONNREFUSED'));
    const test = harness({ server });
    test.connection.start();
    await test.settle();

    for (let round = 0; round < 12; round += 1) {
      test.clock.advance(60_000);
      await test.settle();
    }
    // A laptop that has been asleep for an hour has to come back without an
    // operator, so there is no attempt cap — only a ceiling on the wait.
    expect(server.attempts).toBe(13);
    await test.connection.close();
  });

  it('does not retry a server that needs an operator to authorize', async () => {
    const server = fakeServer();
    server.failConnects(
      new GhostError('permission_denied', 'authorize me', {
        details: { needsAuthorization: true },
      }),
    );
    const test = harness({ server });

    test.connection.start();
    await test.settle();
    expect(test.connection.state).toBe('needs_authorization');

    // Looping on a redirect nobody is going to follow spends the authorization
    // server's rate limit to reach the same answer.
    test.clock.advance(600_000);
    await test.settle();
    expect(server.attempts).toBe(1);
    expect(test.clock.pending).toBe(0);
    await test.connection.close();
  });

  it('leaves no timer armed after close', async () => {
    const server = fakeServer();
    server.failConnects(new GhostError('network', 'ECONNREFUSED'));
    const test = harness({ server });
    test.connection.start();
    await test.settle();
    expect(test.clock.pending).toBe(1);

    await test.connection.close();
    expect(test.clock.pending).toBe(0);
    expect(test.current()).toEqual([]);

    // And a timer that had already been armed cannot resurrect it.
    test.clock.advance(600_000);
    await test.settle();
    expect(server.attempts).toBe(1);
  });

  it('does not read its own close as a drop', async () => {
    const test = harness();
    test.connection.start();
    await test.settle();

    await test.connection.close();
    await test.settle();
    expect(test.clock.pending).toBe(0);
    expect(test.connection.state).toBe('disabled');
  });

  it('re-filters without reconnecting when only exposure changed', async () => {
    const test = harness();
    test.connection.start();
    await test.settle();
    test.server.setTools([ECHO_TOOL, { ...ECHO_TOOL, name: 'reverse' }]);
    await test.settle();
    expect(test.current()).toHaveLength(2);

    const attemptsBefore = test.server.attempts;
    test.connection.rebridge(specFor({ enabledTools: ['echo'] }));

    expect(test.current()).toEqual(['mcp_demo_echo']);
    expect(test.connection.status.filteredTools).toEqual(['reverse']);
    // The whole point of the two fingerprints: no subprocess was bounced.
    expect(test.server.attempts).toBe(attemptsBefore);
    await test.connection.close();
  });

  it('refuses a rebridge that would need a new connection', () => {
    const test = harness();
    expect(() => {
      test.connection.rebridge(specFor({ command: 'other' }));
    }).toThrow(/new connection/);
  });

  it('warns about an enabledTools entry that matches nothing', async () => {
    const test = harness({ spec: specFor({ enabledTools: ['nope'] }) });
    test.connection.start();
    await test.settle();

    expect(test.current()).toEqual([]);
    expect(test.connection.status.warnings.join(' ')).toContain('"nope"');
    await test.connection.close();
  });

  it('refuses a call once the server has gone, rather than hanging', async () => {
    const test = harness();
    test.connection.start();
    await test.settle();
    const tool = test.connection.tools[0];
    expect(tool).toBeDefined();

    test.server.drop();
    await test.settle();

    const failure = await tool
      ?.execute({ text: 'hi' }, {
        signal: new AbortController().signal,
      } as never)
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(failure).toBeInstanceOf(GhostError);
    await test.connection.close();
  });
});
