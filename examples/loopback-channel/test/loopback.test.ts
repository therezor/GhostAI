import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { AgentLoop } from '@ghostwire/agent';
import { ChannelManager } from '@ghostwire/channels';
import { channelConformance } from '@ghostwire/channels/testkit';
import { SessionStore, assistantMessage, textOf } from '@ghostwire/core';
import { AgentSettingsSchema, ConfigSchema } from '@ghostwire/protocol';
import {
  emptyUsage,
  findProvider,
  type ChatProvider,
  type ChatResult,
  type ChatStreamEvent,
  type ProviderSpec,
} from '@ghostwire/providers';
import { WorkspaceJail, singleJail } from '@ghostwire/security';
import { HubApprovalGate, SessionHub } from '@ghostwire/server';
import { ToolRegistry } from '@ghostwire/tools';

import { loopbackChannel, type LoopbackChannel } from '#src/loopback.js';

// ---------------------------------------------------------------------------
// The contract
// ---------------------------------------------------------------------------

channelConformance<LoopbackChannel>({
  factory: loopbackChannel(),
  receive: (channel, text) => {
    channel.say(text);
  },
  sent: (channel) =>
    channel.transcript
      .filter((entry) => entry.direction === 'out')
      .map((entry) => entry.text),
});

// ---------------------------------------------------------------------------
// The round trip: one message, through the agent a browser would have used
// ---------------------------------------------------------------------------

const SPEC: ProviderSpec = findProvider('ollama')!;

/** A provider that answers with one fixed sentence and never opens a socket. */
function fixedProvider(answer: string): ChatProvider {
  const result = (): ChatResult => ({
    message: assistantMessage(answer),
    finishReason: 'stop',
    usage: emptyUsage(),
    model: 'test-model',
  });

  return {
    id: 'scripted',
    spec: SPEC,
    chat: async () => result(),
    stream: async function* (): AsyncIterable<ChatStreamEvent> {
      yield { type: 'text', text: answer };
      yield { type: 'done', result: result() };
    },
    listModels: async () => [],
    close: async () => undefined,
  };
}

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface Stack {
  readonly hub: SessionHub;
  readonly store: SessionStore;
  readonly manager: ChannelManager;
  readonly channel: LoopbackChannel;
}

async function stack(answer = 'Hello from the agent.'): Promise<Stack> {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'ghostai-loopback-')));
  cleanups.push(() => {
    rmSync(base, { recursive: true, force: true });
  });

  const store = new SessionStore({});
  cleanups.push(() => {
    store.close();
  });

  const loop = new AgentLoop({
    provider: fixedProvider(answer),
    tools: new ToolRegistry(),
    store,
    jails: singleJail(new WorkspaceJail({ root: join(base, 'workspace') })),
    config: { ...AgentSettingsSchema.parse({}), model: 'test-model' },
    model: 'test-model',
  });

  const hub = new SessionHub({
    config: ConfigSchema.parse({}),
    loop: () => loop,
    // This example configures no agents, so every id is the default one.
    resolveAgentId: () => ({ agentId: 'default', miss: undefined }),
    store,
    approvals: new HubApprovalGate(),
  });
  cleanups.push(() => {
    hub.close();
  });

  const manager = new ChannelManager({ hub, factories: [loopbackChannel()] });
  cleanups.push(async () => {
    await manager.stop();
  });
  await manager.start();

  return {
    hub,
    store,
    manager,
    channel: manager.channel('loopback') as LoopbackChannel,
  };
}

describe('the loopback channel over the real hub', () => {
  it('round-trips a message through the agent and into the session store', async () => {
    const { store, channel } = await stack('Hello from the agent.');

    expect(channel.say('what can you do?')).toMatchObject({ kind: 'accepted' });
    await vi.waitFor(() => {
      expect(channel.replies()).toEqual(['Hello from the agent.']);
    });

    const messages = store
      .messages('loopback:default')
      .map((record) => record.message);
    expect(messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
    ]);
    expect(messages.map((message) => textOf(message))).toEqual([
      'what can you do?',
      'Hello from the agent.',
    ]);
    // The origin a session list shows, and the reason a channel turn is not
    // labelled `web`.
    expect(store.getSession('loopback:default')?.origin).toBe('loopback');
  });

  it('lands in the same store a browser turn lands in', async () => {
    const { hub, store, channel } = await stack('Same agent.');

    const web = hub.connect({ sessionKey: 'web:1', send: () => undefined });
    web.receive({
      type: 'user.message',
      sessionKey: 'web:1',
      content: 'from a tab',
    });
    channel.say('from a chat app');

    await vi.waitFor(() => {
      expect(store.messages('web:1')).toHaveLength(2);
      expect(store.messages('loopback:default')).toHaveLength(2);
    });

    expect(
      store
        .listSessions()
        .map((session) => [session.key, session.origin])
        .sort(),
    ).toEqual([
      ['loopback:default', 'loopback'],
      ['web:1', 'web'],
    ]);
    // Same answer, same loop, same store — the two paths differ only in
    // transport, which is the whole claim this example exists to check.
    expect(channel.replies()).toEqual(['Same agent.']);
  });

  it('queues a second message rather than running two turns on one session', async () => {
    const { store, channel } = await stack('One at a time.');

    channel.say('first');
    channel.say('second');

    await vi.waitFor(() => {
      expect(store.messages('loopback:default')).toHaveLength(4);
    });
    expect(channel.replies()).toEqual(['One at a time.', 'One at a time.']);
    expect(
      channel.transcript.some(
        (entry) => entry.kind === 'notice' && entry.text.includes('Queued'),
      ),
    ).toBe(true);
  });

  it('refuses to speak once it has been stopped', async () => {
    const { manager, channel } = await stack();
    await manager.stop();

    expect(channel.say('anyone there?')).toEqual({ kind: 'closed' });
  });
});
