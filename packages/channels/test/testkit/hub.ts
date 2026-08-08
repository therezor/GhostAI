/**
 * A hub that answers.
 *
 * `SessionHub` needs a config, a store, an approval gate and a loop; a channel
 * test needs none of those and would be testing them by accident. This is the
 * same three-method port `ChannelManager` states, backed by a scripted turn —
 * so a channel under test gets a real turn's event *shape* (`turn.start`,
 * deltas, `turn.end`) without a provider anywhere near it.
 *
 * Not exported from `index.ts`, like every other testkit in this repo.
 */

import type { ServerMessage } from '@ghostbot/protocol';

import type {
  ChannelHub,
  ChannelHubConnectOptions,
  ChannelHubConnection,
} from '#src/manager.js';

/** A `user.message` frame, as the manager writes one. */
export interface ReceivedFrame {
  readonly type: string;
  readonly sessionKey?: string;
  readonly content?: string;
  readonly attachments?: ReadonlyArray<{ type: string; url: string }>;
  readonly clientMessageId?: string;
}

export interface ScriptedHubOptions {
  /** What the turn answers with. Defaults to echoing the message back. */
  readonly reply?: (frame: ReceivedFrame) => string;
  /** Suppresses the scripted turn, leaving the test to emit events by hand. */
  readonly silent?: boolean;
}

export class ScriptedConnection implements ChannelHubConnection {
  readonly sessionKey: string;
  readonly frames: ReceivedFrame[] = [];
  closed = false;
  private turns = 0;
  private readonly send: (message: ServerMessage) => void;
  private readonly options: ScriptedHubOptions;

  constructor(options: ChannelHubConnectOptions, scripted: ScriptedHubOptions) {
    this.sessionKey = options.sessionKey ?? 'scripted';
    this.send = options.send;
    this.options = scripted;
  }

  receive(frame: unknown): void {
    const received = frame as ReceivedFrame;
    this.frames.push(received);
    if (received.type !== 'user.message' || this.options.silent === true) {
      return;
    }
    this.turns += 1;
    this.turn(
      this.options.reply?.(received) ?? `echo: ${received.content ?? ''}`,
    );
  }

  close(): void {
    this.closed = true;
  }

  /** One turn, in the order and shape `AgentLoop` yields one. */
  turn(text: string): void {
    const turnId = `turn-${String(this.turns)}`;
    this.emit({
      type: 'turn.start',
      agentId: 'default',
      seq: 0,
      sessionKey: this.sessionKey,
      turnId,
      model: 'scripted',
      provider: 'scripted',
    });
    if (text !== '') {
      this.emit({ type: 'assistant.delta', seq: 0, turnId, text });
    }
    this.emit({
      type: 'turn.end',
      seq: 0,
      turnId,
      stopReason: 'complete',
      iterations: 1,
    });
  }

  /** Anything else the hub could send this connection. */
  emit(message: ServerMessage): void {
    if (!this.closed) this.send(message);
  }
}

export class ScriptedHub implements ChannelHub {
  readonly connections: ScriptedConnection[] = [];
  /** The `channel` each connection was opened with, in order. */
  readonly origins: Array<string | undefined> = [];
  private readonly options: ScriptedHubOptions;

  constructor(options: ScriptedHubOptions = {}) {
    this.options = options;
  }

  connect(options: ChannelHubConnectOptions): ChannelHubConnection {
    const connection = new ScriptedConnection(options, this.options);
    this.connections.push(connection);
    this.origins.push(options.channel);
    return connection;
  }

  /** The single connection, when a test expects exactly one. */
  only(): ScriptedConnection {
    if (this.connections.length !== 1) {
      throw new Error(
        `Expected one hub connection, found ${String(this.connections.length)}`,
      );
    }
    return this.connections[0]!;
  }

  /** Every `user.message` this hub was handed, across every connection. */
  messages(): ReceivedFrame[] {
    return this.connections.flatMap((connection) =>
      connection.frames.filter((frame) => frame.type === 'user.message'),
    );
  }
}
