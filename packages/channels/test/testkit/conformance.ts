/**
 * The suite every channel has to pass.
 *
 * A channel is easy to write and easy to write *almost* right: one that
 * publishes a session key it made up, or renders `progress` it never declared,
 * or keeps answering after `stop()`, looks fine in a manual test and breaks a
 * property something else depends on. Those properties are stated here once and
 * checked against every implementation — the loopback reference channel today,
 * Telegram in Phase 3, and whatever a plugin registers after that.
 *
 * The suite drives the channel through a real `ChannelManager` against a
 * scripted hub, because the contract is about what the manager sees and what
 * the transport shows, not about a channel's internals.
 *
 * It imports `vitest`, so it lives in `src/testkit/` and is not exported from
 * `index.ts` — the same rule the provider and tool suites follow. A channel
 * imports it by path.
 */

import { describe, expect, it } from 'vitest';

import type { Channel, ChannelFactory } from '#src/channel.js';
import { ChannelManager } from '#src/manager.js';
import { ScriptedHub } from './hub.js';

/** One macrotask: long enough for both of the manager's pumps to run. */
async function flush(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

export interface ChannelConformanceOptions<C extends Channel = Channel> {
  readonly factory: ChannelFactory;
  /** The settings block the factory is handed. Defaults to `{}`. */
  readonly settings?: Readonly<Record<string, unknown>>;
  /**
   * A user speaking on the channel's own transport.
   *
   * Whatever the channel's real input is — a webhook body, a gateway event, an
   * array push — this is the test's way of producing one. It must lead to a
   * `context.publish`, which is the whole of what is being checked.
   */
  receive(channel: C, text: string): Promise<void> | void;
  /** Everything the channel has put on its transport, oldest first. */
  sent(channel: C): readonly string[];
  /**
   * The conversation `receive` speaks into.
   *
   * Only used to assert that two messages from one conversation land in one
   * session; a channel with a single implicit conversation can leave it out.
   */
  readonly conversation?: string;
}

/**
 * Runs the contract against one factory. Call it inside a test file.
 */
export function channelConformance<C extends Channel>(
  options: ChannelConformanceOptions<C>,
): void {
  const { factory } = options;

  /** A manager with this factory registered, started, and its channel to hand. */
  async function start(
    hub: ScriptedHub,
  ): Promise<{ manager: ChannelManager; channel: C; hub: ScriptedHub }> {
    const manager = new ChannelManager({
      hub,
      factories: [factory],
      ...(options.settings === undefined
        ? {}
        : { channels: { [factory.id]: options.settings } }),
    });
    await manager.start();
    const channel = manager.channel(factory.id) as C | undefined;
    if (channel === undefined) throw new Error(`"${factory.id}" did not start`);
    return { manager, channel, hub };
  }

  describe(`channel contract: ${factory.id}`, () => {
    it('creates a channel under the factory’s own id', async () => {
      const { manager, channel } = await start(new ScriptedHub());
      try {
        expect(channel.id).toBe(factory.id);
      } finally {
        await manager.stop();
      }
    });

    it('publishes what it receives, under its own id', async () => {
      const { manager, channel, hub } = await start(
        new ScriptedHub({ silent: true }),
      );
      try {
        await options.receive(channel, 'hello there');
        await flush();

        expect(hub.origins).toEqual([factory.id]);
        const [message] = hub.messages();
        expect(message?.type).toBe('user.message');
        expect(message?.content).toBe('hello there');
        // Namespaced by the manager, whatever the channel chose.
        expect(hub.only().sessionKey.startsWith(`${factory.id}:`)).toBe(true);
        // An idempotency key, so a transport that redelivers is acked rather
        // than running the turn twice.
        expect(message?.clientMessageId).toBeTruthy();
      } finally {
        await manager.stop();
      }
    });

    it('renders the answer back onto its transport', async () => {
      const { manager, channel } = await start(
        new ScriptedHub({ reply: () => 'the answer' }),
      );
      try {
        await options.receive(channel, 'a question');
        await flush();
        await flush();

        expect(options.sent(channel)).toContain('the answer');
      } finally {
        await manager.stop();
      }
    });

    it('keeps one conversation in one session', async () => {
      const { manager, channel, hub } = await start(new ScriptedHub());
      try {
        await options.receive(channel, 'first');
        await flush();
        await options.receive(channel, 'second');
        await flush();

        expect(hub.connections).toHaveLength(1);
        expect(hub.messages().map((frame) => frame.content)).toEqual([
          'first',
          'second',
        ]);
      } finally {
        await manager.stop();
      }
    });

    it('renders an error rather than swallowing it', async () => {
      const { manager, channel, hub } = await start(
        new ScriptedHub({ silent: true }),
      );
      try {
        await options.receive(channel, 'a question');
        await flush();
        hub.only().emit({
          type: 'error',
          code: 'provider_error',
          message: 'the model is unreachable',
          retryable: true,
        });
        await flush();
        await flush();

        expect(options.sent(channel).join('\n')).toContain(
          'the model is unreachable',
        );
      } finally {
        await manager.stop();
      }
    });

    it('says nothing more once it has been stopped', async () => {
      const { manager, channel, hub } = await start(
        new ScriptedHub({ silent: true }),
      );
      await options.receive(channel, 'a question');
      await flush();
      const connection = hub.only();
      await manager.stop();

      const before = [...options.sent(channel)];
      connection.turn('too late');
      await flush();
      await flush();

      expect(options.sent(channel)).toEqual(before);
      expect(connection.closed).toBe(true);
    });

    it('stops cleanly when it never received anything', async () => {
      const { manager } = await start(new ScriptedHub());

      await expect(manager.stop()).resolves.toBeUndefined();
      // Idempotent: a transport that closed on its own and a manager shutting
      // down both call this, and in either order.
      await expect(manager.stop()).resolves.toBeUndefined();
    });
  });
}
