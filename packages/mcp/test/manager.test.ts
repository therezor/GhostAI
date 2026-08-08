import { GhostError } from '@ghostbot/core';
import {
  McpServerConfigSchema,
  type McpServerConfig,
} from '@ghostbot/protocol';
import type { AnyTool } from '@ghostbot/tools';
import { describe, expect, it } from 'vitest';

import { McpManager, type McpToolSink } from '#src/manager.js';
import { manualClock } from '#testkit/clock.js';
import {
  ECHO_TOOL,
  fakeServer,
  type FakeServer,
} from '#testkit/fake-server.js';

function server(overrides: Record<string, unknown> = {}): McpServerConfig {
  return McpServerConfigSchema.parse({ command: 'npx', ...overrides });
}

interface Recorder extends McpToolSink {
  readonly registered: Map<string, readonly string[]>;
  /** Names this sink will refuse, as another source already holds them. */
  refuse(name: string): void;
}

function recorder(): Recorder {
  const registered = new Map<string, readonly string[]>();
  const refused = new Set<string>();
  return {
    registered,
    refuse: (name) => refused.add(name),
    replace(serverId: string, tools: readonly AnyTool[]): readonly string[] {
      const accepted = tools.filter((tool) => !refused.has(tool.name));
      registered.set(
        serverId,
        accepted.map((tool) => tool.name),
      );
      return tools
        .filter((tool) => refused.has(tool.name))
        .map((tool) => tool.name);
    },
  };
}

function harness(fake: FakeServer = fakeServer()) {
  const sink = recorder();
  const clock = manualClock();
  const manager = new McpManager({
    sink,
    connect: fake.connect,
    clock,
    backoff: { jitter: (ceiling) => ceiling },
  });
  const settle = async (): Promise<void> => {
    for (let index = 0; index < 6; index += 1) await Promise.resolve();
  };
  return { manager, sink, clock, fake, settle };
}

describe('McpManager.reconcile', () => {
  it('connects a new server and registers what it offers', async () => {
    const test = harness();
    test.manager.reconcile({ demo: server() });
    await test.settle();

    expect(test.sink.registered.get('demo')).toEqual(['mcp_demo_echo']);
    expect(test.manager.connectedCount).toBe(1);
    await test.manager.close();
  });

  it('is synchronous and never throws, whatever the servers do', () => {
    const fake = fakeServer();
    fake.failConnects(new GhostError('network', 'ECONNREFUSED'));
    const test = harness(fake);

    // `Runtime#build` calls this from the region whose comment reads "past here
    // nothing throws", and a save must not be lost to an unreachable server.
    expect(() => {
      test.manager.reconcile({ broken: server(), missing: server({}) });
    }).not.toThrow();
    void test.manager.close();
  });

  it('leaves an unchanged server entirely alone', async () => {
    const test = harness();
    test.manager.reconcile({ demo: server() });
    await test.settle();
    const attempts = test.fake.attempts;

    test.manager.reconcile({ demo: server() });
    await test.settle();
    expect(test.fake.attempts).toBe(attempts);
    await test.manager.close();
  });

  it('reconnects when the transport moved', async () => {
    const test = harness();
    test.manager.reconcile({ demo: server() });
    await test.settle();
    expect(test.fake.attempts).toBe(1);

    test.manager.reconcile({ demo: server({ args: ['--verbose'] }) });
    await test.settle();
    expect(test.fake.attempts).toBe(2);
    await test.manager.close();
  });

  it('re-filters without reconnecting when only exposure moved', async () => {
    const test = harness();
    test.fake.setTools([ECHO_TOOL, { ...ECHO_TOOL, name: 'reverse' }]);
    test.manager.reconcile({ demo: server() });
    await test.settle();
    expect(test.sink.registered.get('demo')).toHaveLength(2);

    test.manager.reconcile({ demo: server({ enabledTools: ['echo'] }) });
    await test.settle();

    expect(test.sink.registered.get('demo')).toEqual(['mcp_demo_echo']);
    expect(test.fake.attempts).toBe(1);
    await test.manager.close();
  });

  it('unregisters a server that left the config', async () => {
    const test = harness();
    test.manager.reconcile({ demo: server() });
    await test.settle();

    test.manager.reconcile({});
    await test.settle();

    expect(test.sink.registered.get('demo')).toEqual([]);
    expect(test.manager.statuses()).toEqual([]);
    expect(test.manager.connectedCount).toBe(0);
    await test.manager.close();
  });

  it('takes down a server that was switched off, and says so', async () => {
    const test = harness();
    test.manager.reconcile({ demo: server() });
    await test.settle();

    test.manager.reconcile({ demo: server({ enabled: false }) });
    await test.settle();

    expect(test.sink.registered.get('demo')).toEqual([]);
    // Still a row: an operator who switched it off should see it switched off,
    // not see it vanish.
    expect(test.manager.statuses()).toMatchObject([
      { id: 'demo', state: 'disabled', enabled: false },
    ]);
    await test.manager.close();
  });

  it('reports a misconfigured entry rather than refusing the save', async () => {
    const test = harness();
    test.manager.reconcile({ broken: McpServerConfigSchema.parse({}) });
    await test.settle();

    const [status] = test.manager.statuses();
    expect(status).toMatchObject({ id: 'broken', state: 'failed' });
    expect(status?.lastError).toContain('neither a command nor a url');
    await test.manager.close();
  });

  it('clears a misconfiguration once it is fixed', async () => {
    const test = harness();
    test.manager.reconcile({ demo: McpServerConfigSchema.parse({}) });
    await test.settle();
    expect(test.manager.statuses()[0]?.state).toBe('failed');

    test.manager.reconcile({ demo: server() });
    await test.settle();
    expect(test.manager.statuses()).toMatchObject([
      { id: 'demo', state: 'ready' },
    ]);
    await test.manager.close();
  });

  it('lists every server, connected or not, sorted by id', async () => {
    const fake = fakeServer();
    const test = harness(fake);
    test.manager.reconcile({
      zulu: server(),
      alpha: McpServerConfigSchema.parse({}),
    });
    await test.settle();

    expect(test.manager.statuses().map((status) => status.id)).toEqual([
      'alpha',
      'zulu',
    ]);
    await test.manager.close();
  });

  it('keeps one server working when another cannot be reached', async () => {
    // Two managers rather than two servers on one fake, because the fake is the
    // transport: what matters is that a failure is scoped to its own row.
    const good = harness();
    good.manager.reconcile({ demo: server() });
    await good.settle();

    const broken = fakeServer();
    broken.failConnects(new GhostError('network', 'ECONNREFUSED'));
    const bad = harness(broken);
    bad.manager.reconcile({ other: server() });
    await bad.settle();

    expect(good.sink.registered.get('demo')).toEqual(['mcp_demo_echo']);
    expect(bad.manager.statuses()[0]?.state).toBe('failed');
    await good.manager.close();
    await bad.manager.close();
  });
});

describe('McpManager.close', () => {
  it('unregisters everything and stops every timer', async () => {
    const fake = fakeServer();
    fake.failConnects(new GhostError('network', 'ECONNREFUSED'));
    const test = harness(fake);
    test.manager.reconcile({ demo: server() });
    await test.settle();
    expect(test.clock.pending).toBe(1);

    await test.manager.close();

    expect(test.sink.registered.get('demo')).toEqual([]);
    expect(test.clock.pending).toBe(0);
  });

  it('ignores a reconcile after it has closed', async () => {
    const test = harness();
    await test.manager.close();
    test.manager.reconcile({ demo: server() });
    await test.settle();
    expect(test.fake.attempts).toBe(0);
  });
});

describe('name collisions with another source', () => {
  it('registers what it can and reports the rest', async () => {
    const test = harness();
    test.sink.refuse('mcp_demo_echo');
    test.manager.reconcile({ demo: server() });
    await test.settle();

    // The other tools of a server whose one name clashes still work.
    expect(test.sink.registered.get('demo')).toEqual([]);
    expect(test.manager.statuses()[0]?.state).toBe('ready');
    await test.manager.close();
  });
});
