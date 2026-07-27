import { afterEach, describe, expect, it } from 'vitest';

import type { AgentEvent, TurnInput, TurnResult } from '@ghostai/agent';
import { SessionStore, assistantMessage, userMessage } from '@ghostai/core';
import {
  ConfigSchema,
  PROTOCOL_VERSION,
  ServerMessageSchema,
  type Config,
  type ServerMessage,
  type ServerMessageType,
} from '@ghostai/protocol';

import { HubApprovalGate } from './approvals.js';
import { SessionHub, type ConnectOptions, type HubClient, type TurnRunner } from './hub.js';

const SESSION = 'web:1';

/** One macrotask, which is long enough for the loop's generator to advance. */
async function flush(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

// ---------------------------------------------------------------------------
// A scripted turn runner
// ---------------------------------------------------------------------------

const END = Symbol('end');
type Emission = AgentEvent | typeof END | { readonly throws: unknown };

/**
 * One `run()` call, driven from the test.
 *
 * The hub's whole job is what happens *between* events — a second message
 * arriving mid-turn, a stop, a reload — so the turn has to be suspendable at any
 * point rather than replayed from a fixed script.
 */
class ScriptedTurn {
  readonly input: TurnInput;
  readonly #queue: Emission[] = [];
  #resolve: ((emission: Emission) => void) | undefined;

  constructor(input: TurnInput) {
    this.input = input;
  }

  get turnId(): string {
    return this.input.turnId ?? 'unknown';
  }

  take(): Promise<Emission> {
    const next = this.#queue.shift();
    if (next !== undefined) return Promise.resolve(next);
    return new Promise<Emission>((resolve) => {
      this.#resolve = resolve;
    });
  }

  async emit(event: AgentEvent): Promise<void> {
    this.#push(event);
    await flush();
  }

  async fail(error: unknown): Promise<void> {
    this.#push({ throws: error });
    await flush();
  }

  /** Ends the turn the way the loop does: a `turn.end`, then the return. */
  async end(stopReason: 'complete' | 'aborted' = 'complete'): Promise<void> {
    this.#push({ type: 'turn.end', turnId: this.turnId, stopReason, iterations: 1 });
    this.#push(END);
    await flush();
  }

  #push(emission: Emission): void {
    const resolve = this.#resolve;
    if (resolve === undefined) {
      this.#queue.push(emission);
      return;
    }
    this.#resolve = undefined;
    resolve(emission);
  }
}

class ScriptedRunner implements TurnRunner {
  readonly turns: ScriptedTurn[] = [];
  readonly steers: { sessionKey: string; content: string }[] = [];

  async *run(input: TurnInput): AsyncGenerator<AgentEvent, TurnResult> {
    const turn = new ScriptedTurn(input);
    this.turns.push(turn);

    for (;;) {
      const emission = await turn.take();
      if (emission === END) break;
      if ('throws' in emission) throw emission.throws;
      yield emission;
    }

    return {
      turnId: turn.turnId,
      stopReason: 'complete',
      iterations: 1,
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      text: '',
    };
  }

  steer(sessionKey: string, content: string): void {
    this.steers.push({ sessionKey, content });
  }

  turn(index: number): ScriptedTurn {
    const turn = this.turns[index];
    if (turn === undefined) throw new Error(`No turn ${String(index)} has started`);
    return turn;
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface TestClient extends HubClient {
  /** Every frame this connection was sent, in order. */
  readonly frames: ServerMessage[];
  types(): ServerMessageType[];
  /** Frames of one type, which is what most assertions actually want. */
  of<T extends ServerMessageType>(type: T): Extract<ServerMessage, { type: T }>[];
  /** Drops what has been asserted, so the next assertion reads a clean slate. */
  reset(): void;
}

/** `sessionKey: undefined` has to be expressible — it is what asks for a new one. */
type TestConnectOptions = Omit<Partial<ConnectOptions>, 'sessionKey'> & {
  sessionKey?: string | undefined;
};

interface Harness {
  readonly hub: SessionHub;
  readonly runner: ScriptedRunner;
  readonly store: SessionStore;
  readonly approvals: HubApprovalGate;
  connect(options?: TestConnectOptions): TestClient;
}

interface HarnessOptions {
  readonly config?: Partial<Config['server']>;
  readonly loop?: () => TurnRunner;
  readonly maxQueueDepth?: number;
  readonly maxSessions?: number;
}

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function harness(options: HarnessOptions = {}): Harness {
  const config = ConfigSchema.parse({ server: options.config ?? {} });
  const store = new SessionStore();
  cleanups.push(() => {
    store.close();
  });

  const runner = new ScriptedRunner();
  const approvals = new HubApprovalGate();
  let counter = 0;

  const hub = new SessionHub({
    config,
    store,
    approvals,
    loop: options.loop ?? ((): TurnRunner => runner),
    newId: () => `id-${String(++counter)}`,
    ...(options.maxQueueDepth === undefined ? {} : { maxQueueDepth: options.maxQueueDepth }),
    ...(options.maxSessions === undefined ? {} : { maxSessions: options.maxSessions }),
  });
  cleanups.push(() => {
    hub.close();
  });

  return {
    hub,
    runner,
    store,
    approvals,
    connect: (connectOptions: TestConnectOptions = {}): TestClient => {
      const frames: ServerMessage[] = [];
      const { sessionKey, ...rest } = { sessionKey: SESSION, ...connectOptions };
      const client = hub.connect({
        ...rest,
        ...(sessionKey === undefined ? {} : { sessionKey }),
        send: (message) => {
          // The invariant this whole file exists to protect: every frame the hub
          // emits is a `ServerMessage`. A field the loop renames, or a `seq` the
          // hub forgets to stamp, fails here rather than in a browser.
          ServerMessageSchema.parse(message);
          // Before recording it: a test whose transport throws is testing a dead
          // socket, and a dead socket did not receive the frame.
          connectOptions.send?.(message);
          frames.push(message);
        },
      });

      return Object.assign(client, {
        frames,
        types: (): ServerMessageType[] => frames.map((frame) => frame.type),
        of: <T extends ServerMessageType>(type: T): Extract<ServerMessage, { type: T }>[] =>
          frames.filter(
            (frame): frame is Extract<ServerMessage, { type: T }> => frame.type === type,
          ),
        reset: (): void => {
          frames.length = 0;
        },
      });
    },
  };
}

/** Sends a message and lets the hub start whatever it decided to start. */
async function send(client: HubClient, frame: unknown): Promise<void> {
  client.receive(frame);
  await flush();
}

// ---------------------------------------------------------------------------

describe('SessionHub', () => {
  describe('connections', () => {
    it('greets a new connection with the protocol version and where the session is', () => {
      const h = harness();
      const client = h.connect();

      expect(client.frames).toEqual([
        {
          type: 'connected',
          protocolVersion: PROTOCOL_VERSION,
          sessionKey: SESSION,
          serverTimeMs: expect.any(Number) as number,
          lastSeq: 0,
        },
      ]);
    });

    it('mints a session key when the client does not name one', () => {
      const h = harness();
      const client = h.connect({ sessionKey: undefined });

      expect(client.sessionKey).not.toBe('');
      expect(client.of('connected')[0]?.sessionKey).toBe(client.sessionKey);
    });

    it('answers a ping on the connection that sent it', async () => {
      const h = harness();
      const client = h.connect();
      const other = h.connect();
      client.reset();
      other.reset();

      await send(client, { type: 'ping' });

      expect(client.types()).toEqual(['pong']);
      expect(other.types()).toEqual([]);
    });

    it('reports a malformed frame instead of throwing', async () => {
      const h = harness();
      const client = h.connect();
      client.reset();

      await send(client, '{ not json');
      await send(client, { type: 'user.message' });
      await send(client, { type: 'no.such.message' });

      expect(client.of('error').map((frame) => frame.code)).toEqual([
        'bad_request',
        'bad_request',
        'bad_request',
      ]);
      expect(h.runner.turns).toHaveLength(0);
    });

    it('accepts a frame that arrives as bytes', async () => {
      const h = harness();
      const client = h.connect();
      client.reset();

      await send(client, new TextEncoder().encode(JSON.stringify({ type: 'ping' })));

      expect(client.types()).toEqual(['pong']);
    });

    it('detaches a connection whose send throws, without losing the others', async () => {
      const h = harness();
      let live = true;
      const broken = h.connect({
        send: () => {
          if (!live) throw new Error('socket closed');
        },
      });
      const healthy = h.connect();
      live = false;
      broken.reset();
      healthy.reset();

      await send(healthy, { type: 'user.message', sessionKey: SESSION, content: 'hello' });

      expect(broken.types()).toEqual([]);
      expect(healthy.types()).toContain('message.ack');
    });
  });

  describe('turns', () => {
    it('acks a message, starts a turn, and forwards its events in sequence', async () => {
      const h = harness();
      const client = h.connect();
      client.reset();

      await send(client, {
        type: 'user.message',
        sessionKey: SESSION,
        content: 'hello',
        clientMessageId: 'c-1',
      });

      const turn = h.runner.turn(0);
      expect(turn.input).toMatchObject({ sessionKey: SESSION, content: 'hello', channel: 'web' });

      await turn.emit({
        type: 'turn.start',
        sessionKey: SESSION,
        turnId: turn.turnId,
        model: 'm',
        provider: 'p',
      });
      await turn.emit({ type: 'assistant.delta', turnId: turn.turnId, text: 'hi' });
      await turn.end();

      expect(client.types()).toEqual([
        'message.ack',
        'session.status',
        'turn.start',
        'assistant.delta',
        'turn.end',
        'session.status',
      ]);
      // One counter, no gaps and no reuse.
      expect(client.frames.map((frame) => ('seq' in frame ? frame.seq : null))).toEqual([
        1, 2, 3, 4, 5, 6,
      ]);
      expect(client.of('message.ack')[0]).toMatchObject({
        messageId: turn.turnId,
        clientMessageId: 'c-1',
      });
      expect(client.of('session.status').map((frame) => frame.busy)).toEqual([true, false]);
    });

    it('turns attachments into content parts and keeps the text', async () => {
      const h = harness();
      const client = h.connect();

      await send(client, {
        type: 'user.message',
        sessionKey: SESSION,
        content: 'look at this',
        attachments: [
          { type: 'image/png', url: '/media/abc' },
          { type: 'text/csv', url: '/media/def', name: 'rows.csv' },
        ],
      });

      expect(h.runner.turn(0).input.content).toEqual([
        { type: 'text', text: 'look at this' },
        { type: 'image', mimeType: 'image/png', url: '/media/abc' },
        { type: 'text', text: '[Attachment: rows.csv (text/csv)]' },
      ]);
    });

    it('parses mentions here, so a channel gets them as a browser does', async () => {
      const h = harness();
      const client = h.connect({ channel: 'telegram' });

      await send(client, {
        type: 'user.message',
        sessionKey: SESSION,
        content: 'check @kb:"release notes" and @skill:triage before answering',
      });

      const input = h.runner.turn(0).input;
      expect(input.mentions).toMatchObject({ kb: ['release notes'], mcp: [], skill: ['triage'] });
      // The text is untouched: the model sees exactly what was typed, and the
      // spans are what a renderer uses to highlight them.
      expect(input.content).toBe('check @kb:"release notes" and @skill:triage before answering');
      expect(input.channel).toBe('telegram');
    });

    it('refuses a message with neither text nor attachments', async () => {
      const h = harness();
      const client = h.connect();
      client.reset();

      await send(client, { type: 'user.message', sessionKey: SESSION, content: '' });

      expect(client.of('error')[0]).toMatchObject({ code: 'bad_request' });
      expect(h.runner.turns).toHaveLength(0);
    });

    it('queues a second message rather than running two turns at once', async () => {
      const h = harness();
      const client = h.connect();
      client.reset();

      await send(client, { type: 'user.message', sessionKey: SESSION, content: 'first' });
      await send(client, { type: 'user.message', sessionKey: SESSION, content: 'second' });

      expect(h.runner.turns).toHaveLength(1);
      expect(client.of('message.queued')[0]?.queueDepth).toBe(1);
      expect(client.of('session.status').at(-1)).toMatchObject({ busy: true, queueDepth: 1 });

      await h.runner.turn(0).end();

      expect(h.runner.turns).toHaveLength(2);
      expect(h.runner.turn(1).input.content).toBe('second');
      // The queue drained straight into the next turn: no idle status between.
      expect(client.of('session.status').at(-1)).toMatchObject({ busy: true, queueDepth: 0 });

      await h.runner.turn(1).end();
      expect(h.hub.busy(SESSION)).toBe(false);
    });

    it('refuses a message past the queue bound with session_busy', async () => {
      const h = harness({ maxQueueDepth: 1 });
      const client = h.connect();

      await send(client, { type: 'user.message', sessionKey: SESSION, content: 'running' });
      await send(client, { type: 'user.message', sessionKey: SESSION, content: 'queued' });
      client.reset();
      await send(client, { type: 'user.message', sessionKey: SESSION, content: 'too much' });

      expect(client.of('error')[0]).toMatchObject({ code: 'session_busy', retryable: true });
      expect(h.runner.turns).toHaveLength(1);
    });

    it('acks a retried client message id without queueing it twice', async () => {
      const h = harness();
      const client = h.connect();

      await send(client, {
        type: 'user.message',
        sessionKey: SESSION,
        content: 'once',
        clientMessageId: 'c-1',
      });
      client.reset();
      await send(client, {
        type: 'user.message',
        sessionKey: SESSION,
        content: 'once',
        clientMessageId: 'c-1',
      });

      expect(h.runner.turns).toHaveLength(1);
      const acks = client.of('message.ack');
      expect(acks).toHaveLength(1);
      expect(acks[0]?.messageId).toBe(h.runner.turn(0).turnId);
    });

    it('forgets idempotency keys past the bound rather than growing', async () => {
      const h = harness({ maxQueueDepth: 512 });
      const client = h.connect();

      // 65 distinct keys against a bound of 64: the first is dropped.
      for (let index = 0; index <= 64; index += 1) {
        await send(client, {
          type: 'user.message',
          sessionKey: SESSION,
          content: `message ${String(index)}`,
          clientMessageId: `c-${String(index)}`,
        });
      }
      // One turn running, sixty-four waiting behind it.
      expect(h.runner.turns).toHaveLength(1);
      expect(client.of('message.queued').at(-1)?.queueDepth).toBe(64);

      // The oldest key was forgotten, so its retry is taken as a new message.
      await send(client, {
        type: 'user.message',
        sessionKey: SESSION,
        content: 'message 0',
        clientMessageId: 'c-0',
      });
      expect(client.of('message.queued').at(-1)?.queueDepth).toBe(65);

      // The newest is still remembered: acked again, queued nothing.
      await send(client, {
        type: 'user.message',
        sessionKey: SESSION,
        content: 'message 64',
        clientMessageId: 'c-64',
      });
      expect(client.of('message.queued').at(-1)?.queueDepth).toBe(65);
      expect(client.of('message.ack')).toHaveLength(67);
    });

    it('forwards a mid-turn error without sequencing it, and still closes the turn', async () => {
      const h = harness();
      const client = h.connect();
      await send(client, { type: 'user.message', sessionKey: SESSION, content: 'go' });
      const turn = h.runner.turn(0);
      client.reset();

      await turn.emit({
        type: 'error',
        code: 'rate_limited',
        message: 'slow down',
        retryable: true,
        turnId: turn.turnId,
      });
      await turn.end();

      const error = client.of('error')[0];
      expect(error).toMatchObject({ code: 'rate_limited', retryable: true });
      expect(error).not.toHaveProperty('seq');
      expect(client.of('turn.end')).toHaveLength(1);
    });

    it('aborts the running turn on turn.stop and leaves the session usable', async () => {
      const h = harness();
      const client = h.connect();

      await send(client, { type: 'user.message', sessionKey: SESSION, content: 'run a build' });
      const turn = h.runner.turn(0);
      await turn.emit({
        type: 'tool.call',
        turnId: turn.turnId,
        callId: 'call-1',
        name: 'exec',
        args: { argv: ['make'] },
        risk: 'exec',
      });

      await send(client, { type: 'turn.stop', sessionKey: SESSION });

      expect(turn.input.signal?.aborted).toBe(true);
      await turn.end('aborted');
      expect(h.hub.busy(SESSION)).toBe(false);
      expect(client.of('turn.end')[0]?.stopReason).toBe('aborted');
    });

    it('ignores a stop for a session with nothing running', async () => {
      const h = harness();
      const client = h.connect();
      client.reset();

      await send(client, { type: 'turn.stop', sessionKey: SESSION });
      await send(client, { type: 'turn.stop', sessionKey: 'web:never-seen' });

      expect(client.types()).toEqual([]);
    });

    it('closes a turn the loop threw out of, and says why', async () => {
      const h = harness();
      const client = h.connect();

      await send(client, { type: 'user.message', sessionKey: SESSION, content: 'go' });
      client.reset();
      await h.runner.turn(0).fail(new Error('the provider adapter exploded'));

      const error = client.of('error')[0];
      expect(error?.code).toBe('internal');
      // An unexpected throw's message was written for a stack trace.
      expect(error?.message).not.toContain('exploded');
      expect(client.of('turn.end')[0]).toMatchObject({ stopReason: 'error' });
      expect(h.hub.busy(SESSION)).toBe(false);
    });

    it('closes a turn abandoned by an abort without reporting an error', async () => {
      const h = harness();
      const client = h.connect();

      await send(client, { type: 'user.message', sessionKey: SESSION, content: 'go' });
      client.reset();
      await h.runner.turn(0).fail(new DOMException('aborted', 'AbortError'));

      expect(client.of('error')).toEqual([]);
      expect(client.of('turn.end')[0]).toMatchObject({ stopReason: 'aborted' });
    });

    it('reports a loop that cannot be built and moves on to the next message', async () => {
      let broken = true;
      const runner = new ScriptedRunner();
      const h = harness({
        loop: (): TurnRunner => {
          if (broken) throw new Error('no provider could be resolved');
          return runner;
        },
      });
      const client = h.connect();

      await send(client, { type: 'user.message', sessionKey: SESSION, content: 'go' });
      expect(client.of('error')[0]).toMatchObject({ code: 'internal' });
      expect(client.of('turn.end')).toHaveLength(1);

      broken = false;
      await send(client, { type: 'user.message', sessionKey: SESSION, content: 'again' });
      expect(runner.turns).toHaveLength(1);
    });

    it('stops every running turn on close', async () => {
      const h = harness();
      const client = h.connect();

      await send(client, { type: 'user.message', sessionKey: SESSION, content: 'go' });
      h.hub.close();

      expect(h.runner.turn(0).input.signal?.aborted).toBe(true);
      expect(h.hub.sessionCount).toBe(0);
    });
  });

  describe('fanout', () => {
    it('gives three connections on one session the same stream', async () => {
      const h = harness();
      const [a, b, c] = [h.connect(), h.connect(), h.connect()];
      for (const client of [a, b, c]) client.reset();

      await send(a, { type: 'user.message', sessionKey: SESSION, content: 'hello' });
      const turn = h.runner.turn(0);
      await turn.emit({ type: 'assistant.delta', turnId: turn.turnId, text: 'hi' });
      await turn.end();

      expect(b.frames).toEqual(a.frames);
      expect(c.frames).toEqual(a.frames);
      expect(a.of('assistant.delta')).toHaveLength(1);
    });

    it('stops sending to a connection that closed', async () => {
      const h = harness();
      const staying = h.connect();
      const leaving = h.connect();
      leaving.close();
      leaving.close(); // idempotent
      staying.reset();
      leaving.reset();

      await send(staying, { type: 'user.message', sessionKey: SESSION, content: 'hello' });

      expect(leaving.types()).toEqual([]);
      expect(staying.types()).toContain('message.ack');
      // A frame from a closed connection is dropped, not dispatched.
      await send(leaving, { type: 'ping' });
      expect(leaving.types()).toEqual([]);
    });

    it('stops delivering a session it has switched away from', async () => {
      const h = harness();
      const stayed = h.connect();
      const switched = h.connect();

      await send(switched, { type: 'session.switch', sessionKey: 'web:2' });
      expect(switched.sessionKey).toBe('web:2');
      stayed.reset();
      switched.reset();

      await send(stayed, { type: 'user.message', sessionKey: SESSION, content: 'hello' });

      expect(stayed.types()).toContain('message.ack');
      expect(switched.types()).toEqual([]);
    });

    it('reports the target session when a client opens or switches to one', async () => {
      const h = harness();
      const client = h.connect();
      client.reset();

      await send(client, { type: 'session.new' });

      const status = client.of('session.status')[0];
      expect(status).toMatchObject({ busy: false, queueDepth: 0 });
      expect(client.sessionKey).toBe(status?.sessionKey);
      expect(client.sessionKey).not.toBe(SESSION);
    });
  });

  describe('replay', () => {
    it('replays exactly what a reconnecting client missed', async () => {
      const h = harness();
      const first = h.connect();

      await send(first, { type: 'user.message', sessionKey: SESSION, content: 'hello' });
      const turn = h.runner.turn(0);
      await turn.emit({
        type: 'turn.start',
        sessionKey: SESSION,
        turnId: turn.turnId,
        model: 'm',
        provider: 'p',
      });
      await turn.emit({ type: 'assistant.delta', turnId: turn.turnId, text: 'one ' });
      const seenSoFar = first.frames.filter((frame) => 'seq' in frame).at(-1)?.seq ?? 0;

      // The tab reloads mid-turn and comes back.
      first.close();
      await turn.emit({ type: 'assistant.delta', turnId: turn.turnId, text: 'two ' });
      await turn.emit({ type: 'assistant.delta', turnId: turn.turnId, text: 'three' });

      const second = h.connect();
      second.reset();
      await send(second, { type: 'session.resume', sessionKey: SESSION, lastSeq: seenSoFar });

      expect(second.of('session.replay')[0]).toMatchObject({ complete: true, messages: [] });
      expect(second.of('assistant.delta').map((frame) => frame.text)).toEqual(['two ', 'three']);
      // The replayed frames keep the `seq` they were emitted with; only the
      // envelope and the status are new events.
      expect(second.of('assistant.delta').map((frame) => frame.seq)).toEqual([
        seenSoFar + 1,
        seenSoFar + 2,
      ]);
    });

    it('rebuilds from storage when the resume falls outside the ring', async () => {
      const h = harness({ config: { replayBufferSize: 2 } });
      h.store.ensureSession(SESSION);
      h.store.append(SESSION, userMessage('what did we decide'));
      h.store.append(SESSION, assistantMessage('to ship it'));

      const client = h.connect();
      await send(client, { type: 'user.message', sessionKey: SESSION, content: 'hello' });
      const turn = h.runner.turn(0);
      await turn.emit({ type: 'assistant.delta', turnId: turn.turnId, text: 'a' });
      await turn.emit({ type: 'assistant.delta', turnId: turn.turnId, text: 'b' });
      client.reset();

      await send(client, { type: 'session.resume', sessionKey: SESSION, lastSeq: 1 });

      const replay = client.of('session.replay')[0];
      expect(replay?.complete).toBe(false);
      expect(replay?.messages.map((stored) => stored.message.role)).toEqual(['user', 'assistant']);
      // No tail: storage and the ring would render the same text twice.
      expect(client.of('assistant.delta')).toEqual([]);
    });

    it('tells a client that has seen everything that it missed nothing', async () => {
      const h = harness();
      const client = h.connect();
      await send(client, { type: 'user.message', sessionKey: SESSION, content: 'hello' });
      const lastSeq = client.frames.filter((frame) => 'seq' in frame).at(-1)?.seq ?? 0;
      client.reset();

      await send(client, { type: 'session.resume', sessionKey: SESSION, lastSeq });

      expect(client.of('session.replay')[0]).toMatchObject({ complete: true, messages: [] });
    });

    it('rebuilds a client whose session state was evicted', async () => {
      const h = harness({ maxSessions: 1 });
      const first = h.connect();
      await send(first, { type: 'user.message', sessionKey: SESSION, content: 'hello' });
      await h.runner.turn(0).end();
      first.close();

      // A second session arrives and the idle first one is dropped.
      const second = h.connect({ sessionKey: 'web:2' });
      expect(h.hub.sessionCount).toBe(1);

      second.close();
      const returning = h.connect();
      returning.reset();
      await send(returning, { type: 'session.resume', sessionKey: SESSION, lastSeq: 3 });

      expect(returning.of('session.replay')[0]?.complete).toBe(false);
    });

    it('keeps a live session rather than evicting to satisfy the cap', async () => {
      const h = harness({ maxSessions: 1 });
      const busy = h.connect();
      await send(busy, { type: 'user.message', sessionKey: SESSION, content: 'hello' });

      h.connect({ sessionKey: 'web:2' });

      expect(h.hub.sessionCount).toBe(2);
    });
  });

  describe('steering and approvals', () => {
    it('steers the loop the turn is running on and echoes it to every tab', async () => {
      const h = harness();
      const a = h.connect();
      const b = h.connect();
      await send(a, { type: 'user.message', sessionKey: SESSION, content: 'read the config' });
      a.reset();
      b.reset();

      await send(a, { type: 'turn.steer', sessionKey: SESSION, content: 'the other directory' });

      expect(h.runner.steers).toEqual([{ sessionKey: SESSION, content: 'the other directory' }]);
      expect(a.of('steer')[0]?.content).toBe('the other directory');
      expect(b.of('steer')).toHaveLength(1);
    });

    it('refuses a steer when no turn is running', async () => {
      const h = harness();
      const client = h.connect();
      client.reset();

      await send(client, { type: 'turn.steer', sessionKey: SESSION, content: 'wait' });

      expect(client.of('error')[0]).toMatchObject({ code: 'bad_request' });
      expect(h.runner.steers).toEqual([]);
    });

    it('resolves a pending approval from an inbound tool.approve', async () => {
      const h = harness();
      const client = h.connect();
      const controller = new AbortController();
      const decision = h.approvals.request({
        sessionKey: SESSION,
        turnId: 'turn-1',
        callId: 'call-1',
        name: 'exec',
        args: {},
        risk: 'exec',
        expiresAtMs: Date.now() + 60_000,
        signal: controller.signal,
      });

      await send(client, {
        type: 'tool.approve',
        callId: 'call-1',
        approved: true,
        scope: 'session',
      });

      await expect(decision).resolves.toEqual({ approved: true, scope: 'session' });
    });

    it('says nothing when an approval arrives too late to matter', async () => {
      const h = harness();
      const client = h.connect();
      client.reset();

      await send(client, { type: 'tool.approve', callId: 'call-gone', approved: true });

      expect(client.types()).toEqual([]);
    });

    it('reports that transcription is not configured', async () => {
      const h = harness();
      const client = h.connect();
      client.reset();

      await send(client, { type: 'audio.transcribe', audio: 'AAAA', mimeType: 'audio/webm' });

      expect(client.of('error')[0]).toMatchObject({ code: 'config_invalid' });
    });
  });
});
