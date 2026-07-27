import { afterEach, describe, expect, it } from 'vitest';

import { textPart, type OutboundKind, type OutboundMessage } from '@ghostai/core';
import type { ServerMessage } from '@ghostai/protocol';

import {
  DEFAULT_ACCEPTED_KINDS,
  type Channel,
  type ChannelContext,
  type ChannelFactory,
} from './channel.js';
import {
  ChannelManager,
  type ChannelHub,
  type ChannelHubConnectOptions,
  type ChannelHubConnection,
} from './manager.js';

/** One macrotask: long enough for both pumps to pick up what was queued. */
async function flush(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

// ---------------------------------------------------------------------------
// A hub that records what it was told and emits what a test asks it to
// ---------------------------------------------------------------------------

class FakeConnection implements ChannelHubConnection {
  readonly sessionKey: string;
  readonly frames: Record<string, unknown>[] = [];
  closed = false;
  readonly #send: (message: ServerMessage) => void;

  constructor(options: ChannelHubConnectOptions) {
    this.sessionKey = options.sessionKey ?? 'minted';
    this.#send = options.send;
  }

  receive(frame: unknown): void {
    this.frames.push(frame as Record<string, unknown>);
  }

  close(): void {
    this.closed = true;
  }

  /** What the hub would have broadcast to this connection. */
  emit(message: ServerMessage): void {
    this.#send(message);
  }

  /** A whole turn, as the hub emits one. */
  turn(text: string, turnId = 't1'): void {
    this.emit({
      type: 'turn.start',
      seq: 1,
      sessionKey: this.sessionKey,
      turnId,
      model: 'm',
      provider: 'p',
    });
    this.emit({ type: 'assistant.delta', seq: 2, turnId, text });
    this.emit({ type: 'turn.end', seq: 3, turnId, stopReason: 'complete', iterations: 1 });
  }
}

class FakeHub implements ChannelHub {
  readonly connections: FakeConnection[] = [];
  readonly channels: (string | undefined)[] = [];

  connect(options: ChannelHubConnectOptions): ChannelHubConnection {
    const connection = new FakeConnection(options);
    this.connections.push(connection);
    this.channels.push(options.channel);
    return connection;
  }

  only(): FakeConnection {
    const connection = this.connections[0];
    if (connection === undefined) throw new Error('No hub connection was opened');
    return connection;
  }
}

// ---------------------------------------------------------------------------
// A channel that does nothing but remember
// ---------------------------------------------------------------------------

class FakeChannel implements Channel {
  readonly sent: OutboundMessage[] = [];
  started = 0;
  stopped = 0;
  /** Resolves the next `send`, so a test can hold the delivery chain open. */
  gate: (() => void) | undefined;

  constructor(
    readonly id: string,
    readonly context: ChannelContext,
    readonly accepts: readonly OutboundKind[] = DEFAULT_ACCEPTED_KINDS,
  ) {}

  start(): void {
    this.started += 1;
  }

  async send(message: OutboundMessage): Promise<void> {
    if (this.gate !== undefined) {
      await new Promise<void>((resolve) => {
        this.gate = resolve;
      });
    }
    this.sent.push(message);
  }

  stop(): void {
    this.stopped += 1;
  }

  texts(): string[] {
    return this.sent.map((message) =>
      message.content.map((part) => (part.type === 'text' ? part.text : '')).join(''),
    );
  }
}

interface Harness {
  readonly hub: FakeHub;
  readonly manager: ChannelManager;
  readonly channel: (id?: string) => FakeChannel;
}

interface HarnessOptions {
  readonly ids?: readonly string[];
  readonly accepts?: readonly OutboundKind[];
  readonly channels?: Readonly<Record<string, unknown>>;
  readonly maxSessions?: number;
}

const managers: ChannelManager[] = [];

async function harness(options: HarnessOptions = {}): Promise<Harness> {
  const hub = new FakeHub();
  const built = new Map<string, FakeChannel>();
  const factories: ChannelFactory[] = (options.ids ?? ['loopback']).map((id) => ({
    id,
    create: (context) => {
      const channel = new FakeChannel(id, context, options.accepts);
      built.set(id, channel);
      return channel;
    },
  }));

  const manager = new ChannelManager({
    hub,
    factories,
    ...(options.channels === undefined ? {} : { channels: options.channels }),
    ...(options.maxSessions === undefined ? {} : { maxSessions: options.maxSessions }),
  });
  managers.push(manager);
  await manager.start();

  return {
    hub,
    manager,
    channel: (id = 'loopback') => {
      const channel = built.get(id);
      if (channel === undefined) throw new Error(`Channel "${id}" was never created`);
      return channel;
    },
  };
}

afterEach(async () => {
  await Promise.all(
    managers.splice(0).map(async (manager) => {
      await manager.stop();
    }),
  );
});

// ---------------------------------------------------------------------------

describe('ChannelManager', () => {
  it('turns a published message into the frame a browser would have sent', async () => {
    const { hub, channel } = await harness();

    channel().context.publish({ sessionKey: '4471', senderId: 'u1', content: [textPart('hello')] });
    await flush();

    expect(hub.channels).toEqual(['loopback']);
    expect(hub.only().frames).toEqual([
      {
        type: 'user.message',
        sessionKey: 'loopback:4471',
        content: 'hello',
        attachments: [],
        clientMessageId: expect.any(String) as unknown,
      },
    ]);
  });

  it('namespaces a session key the channel chose, and leaves its own prefix alone', async () => {
    const { hub, channel } = await harness();

    channel().context.publish({ sessionKey: 'web:1', senderId: 'u1', content: [textPart('a')] });
    channel().context.publish({
      sessionKey: 'loopback:7',
      senderId: 'u1',
      content: [textPart('b')],
    });
    await flush();

    expect(hub.connections.map((connection) => connection.sessionKey)).toEqual([
      'loopback:web:1',
      'loopback:7',
    ]);
  });

  it('stamps the channel id, so a channel cannot publish as another one', async () => {
    const { hub, channel } = await harness({ ids: ['loopback', 'other'] });

    // `publish` takes no `channelId`. Smuggling one in is the closest a channel
    // can get to naming another, and it is overwritten rather than honoured.
    channel().context.publish({
      channelId: 'other',
      sessionKey: '1',
      senderId: 'u1',
      content: [textPart('x')],
    } as never);
    await flush();

    expect(hub.channels).toEqual(['loopback']);
    expect(hub.only().sessionKey).toBe('loopback:1');
  });

  it('carries an image through as an attachment', async () => {
    const { hub, channel } = await harness();

    channel().context.publish({
      sessionKey: '1',
      senderId: 'u1',
      content: [
        textPart('look'),
        { type: 'image', mimeType: 'image/png', data: 'AAA' },
        { type: 'image', mimeType: 'image/jpeg', url: 'https://example.test/a.jpg' },
      ],
    });
    await flush();

    expect(hub.only().frames[0]?.attachments).toEqual([
      { type: 'image/png', url: 'data:image/png;base64,AAA' },
      { type: 'image/jpeg', url: 'https://example.test/a.jpg' },
    ]);
  });

  it('delivers the answer back to the address the message came from', async () => {
    const { hub, channel } = await harness();

    channel().context.publish({
      sessionKey: '1',
      senderId: 'u1',
      content: [textPart('hi')],
      metadata: { target: 'chat:99' },
    });
    await flush();
    hub.only().turn('Hello back.');
    await flush();

    expect(channel().sent).toHaveLength(1);
    expect(channel().sent[0]).toMatchObject({
      channelId: 'loopback',
      sessionKey: 'loopback:1',
      target: 'chat:99',
      kind: 'reply',
    });
    expect(channel().texts()).toEqual(['Hello back.']);
  });

  it('falls back to the sender as the reply address', async () => {
    const { hub, channel } = await harness();

    channel().context.publish({ sessionKey: '1', senderId: 'u1', content: [textPart('hi')] });
    await flush();
    hub.only().turn('there');
    await flush();

    expect(channel().sent[0]?.target).toBe('u1');
  });

  it('withholds progress from a channel that did not ask for it', async () => {
    const quiet = await harness({ channels: { sendProgress: true } });
    quiet.channel().context.publish({ sessionKey: '1', senderId: 'u1', content: [textPart('hi')] });
    await flush();
    const connection = quiet.hub.only();
    connection.emit({
      type: 'turn.start',
      seq: 1,
      sessionKey: connection.sessionKey,
      turnId: 't1',
      model: 'm',
      provider: 'p',
    });
    connection.emit({ type: 'assistant.delta', seq: 2, turnId: 't1', text: 'so far' });
    connection.emit({
      type: 'tool.call',
      seq: 3,
      turnId: 't1',
      callId: 'c1',
      name: 'read_file',
      args: {},
      risk: 'safe',
    });
    await flush();

    expect(quiet.channel().sent).toEqual([]);
  });

  it('delivers progress to a channel that renders it', async () => {
    const loud = await harness({
      accepts: ['reply', 'progress'],
      channels: { sendProgress: true },
    });
    loud.channel().context.publish({ sessionKey: '1', senderId: 'u1', content: [textPart('hi')] });
    await flush();
    const connection = loud.hub.only();
    connection.emit({
      type: 'turn.start',
      seq: 1,
      sessionKey: connection.sessionKey,
      turnId: 't1',
      model: 'm',
      provider: 'p',
    });
    connection.emit({ type: 'assistant.delta', seq: 2, turnId: 't1', text: 'so far' });
    connection.emit({
      type: 'tool.call',
      seq: 3,
      turnId: 't1',
      callId: 'c1',
      name: 'read_file',
      args: {},
      risk: 'safe',
    });
    await flush();

    expect(loud.channel().sent.map((message) => message.kind)).toEqual(['progress']);
    expect(loud.channel().sent[0]?.metadata).toEqual({ turnId: 't1' });
  });

  it('keeps one channel’s order without making it another channel’s problem', async () => {
    const { hub, channel } = await harness({ ids: ['slow', 'fast'] });
    channel('slow').context.publish({ sessionKey: '1', senderId: 'u1', content: [textPart('a')] });
    channel('fast').context.publish({ sessionKey: '1', senderId: 'u2', content: [textPart('b')] });
    await flush();

    // Hold `slow` inside its first send.
    channel('slow').gate = () => undefined;
    hub.connections[0]?.turn('slow one');
    hub.connections[1]?.turn('fast one');
    await flush();

    expect(channel('slow').sent).toEqual([]);
    expect(channel('fast').texts()).toEqual(['fast one']);

    channel('slow').gate?.();
    channel('slow').gate = undefined;
    await flush();

    expect(channel('slow').texts()).toEqual(['slow one']);
  });

  it('evicts the least recently used session, and never a busy one', async () => {
    const { hub, manager, channel } = await harness({ maxSessions: 1 });

    channel().context.publish({ sessionKey: 'a', senderId: 'u1', content: [textPart('1')] });
    await flush();
    hub.only().emit({
      type: 'session.status',
      seq: 1,
      sessionKey: 'loopback:a',
      busy: true,
      queueDepth: 0,
    });

    channel().context.publish({ sessionKey: 'b', senderId: 'u2', content: [textPart('2')] });
    await flush();

    // `a` is mid-turn, so the cap yields rather than dropping its reply.
    expect(manager.sessionCount).toBe(2);
    expect(hub.connections[0]?.closed).toBe(false);

    hub.connections[0]?.emit({
      type: 'session.status',
      seq: 2,
      sessionKey: 'loopback:a',
      busy: false,
      queueDepth: 0,
    });
    channel().context.publish({ sessionKey: 'c', senderId: 'u3', content: [textPart('3')] });
    await flush();

    // With nothing running, the cap is enforced properly again: `a` and `b` go,
    // oldest first, and only the session that just spoke is left.
    expect(hub.connections.map((connection) => connection.closed)).toEqual([true, true, false]);
    expect(manager.sessionCount).toBe(1);
  });

  it('reuses the connection for a session it has already seen', async () => {
    const { hub, channel } = await harness();

    channel().context.publish({ sessionKey: '1', senderId: 'u1', content: [textPart('a')] });
    await flush();
    channel().context.publish({ sessionKey: '1', senderId: 'u1', content: [textPart('b')] });
    await flush();

    expect(hub.connections).toHaveLength(1);
    expect(hub.only().frames).toHaveLength(2);
  });

  it('does not start a channel its config disabled', async () => {
    const { manager } = await harness({ channels: { loopback: { enabled: false } } });

    expect(manager.channels).toEqual([]);
  });

  it('refuses a duplicate id and a registration after start', async () => {
    const { manager } = await harness();
    const other: ChannelFactory = {
      id: 'loopback',
      create: () => ({ id: 'loopback', send: () => undefined }),
    };

    expect(() => {
      manager.register(other);
    }).toThrow(/after the manager started/);

    const fresh = new ChannelManager({ hub: new FakeHub(), factories: [other] });
    expect(() => {
      fresh.register(other);
    }).toThrow(/already registered/);
  });

  it('fails to start when a factory builds a channel under another id', async () => {
    const manager = new ChannelManager({
      hub: new FakeHub(),
      factories: [{ id: 'a', create: () => ({ id: 'b', send: () => undefined }) }],
    });

    await expect(manager.start()).rejects.toThrow(/created a channel with id "b"/);
    expect(manager.channels).toEqual([]);
  });

  it('stops the channels it already started when a later one fails', async () => {
    const first = { id: 'first', started: 0, stopped: 0 };
    const manager = new ChannelManager({
      hub: new FakeHub(),
      factories: [
        {
          id: 'first',
          create: () => ({
            id: 'first',
            send: () => undefined,
            start: () => {
              first.started += 1;
            },
            stop: () => {
              first.stopped += 1;
            },
          }),
        },
        {
          id: 'second',
          create: () => {
            throw new Error('no token');
          },
        },
      ],
    });

    await expect(manager.start()).rejects.toThrow('no token');
    expect(first).toEqual({ id: 'first', started: 1, stopped: 1 });
  });

  it('closes its connections and stops its channels on stop', async () => {
    const { hub, manager, channel } = await harness();
    channel().context.publish({ sessionKey: '1', senderId: 'u1', content: [textPart('hi')] });
    await flush();
    const target = channel();

    await manager.stop();

    expect(target.stopped).toBe(1);
    expect(target.context.signal.aborted).toBe(true);
    expect(hub.only().closed).toBe(true);
    expect(manager.sessionCount).toBe(0);
    expect(manager.bus.closed).toBe(true);
  });

  it('survives a channel that throws on send and on stop', async () => {
    const hub = new FakeHub();
    let context: ChannelContext | undefined;
    const manager = new ChannelManager({
      hub,
      factories: [
        {
          id: 'brittle',
          create: (given) => {
            context = given;
            return {
              id: 'brittle',
              send: () => {
                throw new Error('429');
              },
              stop: () => {
                throw new Error('socket already gone');
              },
            };
          },
        },
      ],
    });
    managers.push(manager);
    await manager.start();

    context?.publish({ sessionKey: '1', senderId: 'u1', content: [textPart('hi')] });
    await flush();
    hub.only().turn('answer');
    await flush();

    await expect(manager.stop()).resolves.toBeUndefined();
  });

  it('drops an outbound message addressed to a channel it does not have', async () => {
    const { manager } = await harness();

    manager.bus.publishOutbound({
      channelId: 'gone',
      sessionKey: 's',
      target: 't',
      content: [textPart('x')],
    });
    await flush();

    expect(manager.channels).toHaveLength(1);
  });
});
