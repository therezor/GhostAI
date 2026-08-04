import { afterEach, describe, expect, it } from 'vitest';

import type { AgentEvent, TurnInput, TurnResult } from '@ghostai/agent';
import {
  GhostError,
  SessionStore,
  assistantMessage,
  userMessage,
} from '@ghostai/core';
import {
  ConfigSchema,
  PROTOCOL_VERSION,
  ServerMessageSchema,
  type Config,
  type ServerMessage,
  type ServerMessageType,
} from '@ghostai/protocol';

import { HubApprovalGate } from '#src/approvals.js';
import {
  SessionHub,
  type ConnectOptions,
  type HubClient,
  type TurnRunner,
} from '#src/hub.js';

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
  private readonly queue: Emission[] = [];
  private resolve: ((emission: Emission) => void) | undefined;

  constructor(input: TurnInput) {
    this.input = input;
  }

  get turnId(): string {
    return this.input.turnId ?? 'unknown';
  }

  take(): Promise<Emission> {
    const next = this.queue.shift();
    if (next !== undefined) return Promise.resolve(next);
    return new Promise<Emission>((resolve) => {
      this.resolve = resolve;
    });
  }

  async emit(event: AgentEvent): Promise<void> {
    this.push(event);
    await flush();
  }

  async fail(error: unknown): Promise<void> {
    this.push({ throws: error });
    await flush();
  }

  /** Ends the turn the way the loop does: a `turn.end`, then the return. */
  async end(stopReason: 'complete' | 'aborted' = 'complete'): Promise<void> {
    this.push({
      type: 'turn.end',
      turnId: this.turnId,
      stopReason,
      iterations: 1,
    });
    this.push(END);
    await flush();
  }

  private push(emission: Emission): void {
    const resolve = this.resolve;
    if (resolve === undefined) {
      this.queue.push(emission);
      return;
    }
    this.resolve = undefined;
    resolve(emission);
  }
}

class ScriptedRunner implements TurnRunner {
  readonly turns: ScriptedTurn[] = [];
  readonly steers: Array<{ sessionKey: string; content: string }> = [];

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
    if (turn === undefined) {
      throw new Error(`No turn ${String(index)} has started`);
    }
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
  of<T extends ServerMessageType>(
    type: T,
  ): Array<Extract<ServerMessage, { type: T }>>;
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
  readonly loop?: (agentId: string | undefined) => TurnRunner | null;
  /** `agents.list`, so a test can set an agent up the way an operator would. */
  readonly agents?: Record<string, unknown>;
  readonly maxQueueDepth?: number;
  readonly maxSessions?: number;
}

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function harness(options: HarnessOptions = {}): Harness {
  const config = ConfigSchema.parse({
    server: options.config ?? {},
    agents: { list: options.agents ?? {} },
  });
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
    // The real rule, read off the config this harness built, so a test that
    // deletes an agent sees exactly what a deployment would.
    resolveAgentId: (agentId) => {
      const id = agentId === undefined || agentId === '' ? 'default' : agentId;
      if (id === 'default') return { agentId: id, miss: undefined };
      const entry = config.agents.list[id];
      if (entry?.enabled === true) return { agentId: id, miss: undefined };
      return {
        agentId: 'default',
        miss: entry === undefined ? 'unknown' : 'disabled',
      };
    },
    newId: () => `id-${String(++counter)}`,
    ...(options.maxQueueDepth === undefined
      ? {}
      : { maxQueueDepth: options.maxQueueDepth }),
    ...(options.maxSessions === undefined
      ? {}
      : { maxSessions: options.maxSessions }),
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
      const { sessionKey, ...rest } = {
        sessionKey: SESSION,
        ...connectOptions,
      };
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
        of: <T extends ServerMessageType>(
          type: T,
        ): Array<Extract<ServerMessage, { type: T }>> =>
          frames.filter(
            (frame): frame is Extract<ServerMessage, { type: T }> =>
              frame.type === type,
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
          workspaceId: 'default',
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

      await send(
        client,
        new TextEncoder().encode(JSON.stringify({ type: 'ping' })),
      );

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

      await send(healthy, {
        type: 'user.message',
        sessionKey: SESSION,
        content: 'hello',
      });

      expect(broken.types()).toEqual([]);
      expect(healthy.types()).toContain('message.ack');
    });
  });

  describe('turns with nothing configured', () => {
    it('answers not_configured and never opens a turn', async () => {
      // The socket stays up and every other frame keeps working — only a turn
      // is refused, because the client's answer to this is to offer setup
      // rather than to reconnect.
      const h = harness({ loop: () => null });
      const client = h.connect();
      client.reset();

      await send(client, {
        type: 'user.message',
        sessionKey: SESSION,
        content: 'hello',
        clientMessageId: 'c-1',
      });

      expect(client.of('error')[0]).toMatchObject({
        code: 'not_configured',
        retryable: false,
      });
      // No `turn.end`: no turn ever started, and a client that saw one close
      // would render an empty assistant message for a request nothing ran.
      expect(client.types()).not.toContain('turn.end');
      expect(client.types()).not.toContain('turn.start');
    });

    it('leaves the session idle and able to run once a provider arrives', async () => {
      let runner: TurnRunner | null = null;
      const h = harness({ loop: () => runner });
      const client = h.connect();

      await send(client, {
        type: 'user.message',
        sessionKey: SESSION,
        content: 'too early',
      });

      runner = h.runner;
      client.reset();
      await send(client, {
        type: 'user.message',
        sessionKey: SESSION,
        content: 'now',
      });

      expect(h.runner.turn(0).input).toMatchObject({ content: 'now' });
    });

    it('still answers a ping', async () => {
      const h = harness({ loop: () => null });
      const client = h.connect();
      client.reset();

      await send(client, { type: 'ping' });

      expect(client.types()).toEqual(['pong']);
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
      expect(turn.input).toMatchObject({
        sessionKey: SESSION,
        content: 'hello',
        channel: 'web',
      });

      await turn.emit({
        type: 'turn.start',
        agentId: 'default',
        sessionKey: SESSION,
        turnId: turn.turnId,
        model: 'm',
        provider: 'p',
      });
      await turn.emit({
        type: 'assistant.delta',
        turnId: turn.turnId,
        text: 'hi',
      });
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
      expect(
        client.frames.map((frame) => ('seq' in frame ? frame.seq : null)),
      ).toEqual([1, 2, 3, 4, 5, 6]);
      expect(client.of('message.ack')[0]).toMatchObject({
        messageId: turn.turnId,
        clientMessageId: 'c-1',
      });
      expect(client.of('session.status').map((frame) => frame.busy)).toEqual([
        true,
        false,
      ]);
    });

    it('turns every attachment into a file part, whatever its type', async () => {
      // No branch on the MIME type here. Recording *what was attached* is a
      // path either way; deciding what a model can be shown of it needs bytes
      // off the disk and happens at request time, in `materialiseAttachments`.
      const h = harness();
      const client = h.connect();

      await send(client, {
        type: 'user.message',
        sessionKey: SESSION,
        content: 'look at this',
        attachments: [
          { mimeType: 'image/png', path: 'uploads/ab12cd34-shot.png' },
          {
            mimeType: 'text/csv',
            path: 'uploads/ef56ab78-rows.csv',
            name: 'rows.csv',
            sizeBytes: 4096,
          },
        ],
      });

      expect(h.runner.turn(0).input.content).toEqual([
        { type: 'text', text: 'look at this' },
        {
          type: 'file',
          mimeType: 'image/png',
          path: 'uploads/ab12cd34-shot.png',
        },
        {
          type: 'file',
          mimeType: 'text/csv',
          path: 'uploads/ef56ab78-rows.csv',
          name: 'rows.csv',
          sizeBytes: 4096,
        },
      ]);
    });

    it('accepts an attachment-only message', async () => {
      const h = harness();
      const client = h.connect();

      await send(client, {
        type: 'user.message',
        sessionKey: SESSION,
        content: '',
        attachments: [
          { mimeType: 'image/png', path: 'uploads/ab12cd34-shot.png' },
        ],
      });

      expect(h.runner.turn(0).input.content).toEqual([
        {
          type: 'file',
          mimeType: 'image/png',
          path: 'uploads/ab12cd34-shot.png',
        },
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
      expect(input.mentions).toMatchObject({
        kb: ['release notes'],
        mcp: [],
        skill: ['triage'],
      });
      // The text is untouched: the model sees exactly what was typed, and the
      // spans are what a renderer uses to highlight them.
      expect(input.content).toBe(
        'check @kb:"release notes" and @skill:triage before answering',
      );
      expect(input.channel).toBe('telegram');
    });

    it('refuses a message with neither text nor attachments', async () => {
      const h = harness();
      const client = h.connect();
      client.reset();

      await send(client, {
        type: 'user.message',
        sessionKey: SESSION,
        content: '',
      });

      expect(client.of('error')[0]).toMatchObject({ code: 'bad_request' });
      expect(h.runner.turns).toHaveLength(0);
    });

    it('queues a second message rather than running two turns at once', async () => {
      const h = harness();
      const client = h.connect();
      client.reset();

      await send(client, {
        type: 'user.message',
        sessionKey: SESSION,
        content: 'first',
      });
      await send(client, {
        type: 'user.message',
        sessionKey: SESSION,
        content: 'second',
      });

      expect(h.runner.turns).toHaveLength(1);
      expect(client.of('message.queued')[0]?.queueDepth).toBe(1);
      expect(client.of('session.status').at(-1)).toMatchObject({
        busy: true,
        queueDepth: 1,
      });

      await h.runner.turn(0).end();

      expect(h.runner.turns).toHaveLength(2);
      expect(h.runner.turn(1).input.content).toBe('second');
      // The queue drained straight into the next turn: no idle status between.
      expect(client.of('session.status').at(-1)).toMatchObject({
        busy: true,
        queueDepth: 0,
      });

      await h.runner.turn(1).end();
      expect(h.hub.busy(SESSION)).toBe(false);
    });

    it('refuses a message past the queue bound with session_busy', async () => {
      const h = harness({ maxQueueDepth: 1 });
      const client = h.connect();

      await send(client, {
        type: 'user.message',
        sessionKey: SESSION,
        content: 'running',
      });
      await send(client, {
        type: 'user.message',
        sessionKey: SESSION,
        content: 'queued',
      });
      client.reset();
      await send(client, {
        type: 'user.message',
        sessionKey: SESSION,
        content: 'too much',
      });

      expect(client.of('error')[0]).toMatchObject({
        code: 'session_busy',
        retryable: true,
      });
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
      await send(client, {
        type: 'user.message',
        sessionKey: SESSION,
        content: 'go',
      });
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

      await send(client, {
        type: 'user.message',
        sessionKey: SESSION,
        content: 'run a build',
      });
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

      await send(client, {
        type: 'user.message',
        sessionKey: SESSION,
        content: 'go',
      });
      client.reset();
      await h.runner.turn(0).fail(new Error('the provider adapter exploded'));

      const error = client.of('error')[0];
      expect(error?.code).toBe('internal');
      // An unexpected throw's message was written for a stack trace.
      expect(error?.message).not.toContain('exploded');
      expect(client.of('turn.end')[0]).toMatchObject({ stopReason: 'error' });
      expect(h.hub.busy(SESSION)).toBe(false);
    });

    it('closes a failed turn at the address the client already has', async () => {
      // `firstSeq` is what Regenerate re-runs from. The loop reports it on
      // `turn.start`, but a client whose reconnect fell outside the replay ring
      // only ever sees this synthesised `turn.end` — and without the seq on it
      // the rebuilt turn has nothing to offer a re-run from.
      const h = harness();
      const client = h.connect();

      await send(client, {
        type: 'user.message',
        sessionKey: SESSION,
        content: 'go',
      });
      await h.runner.turn(0).emit({
        type: 'turn.start',
        sessionKey: SESSION,
        turnId: h.runner.turn(0).turnId,
        agentId: 'default',
        model: 'test-model',
        provider: 'test',
        firstSeq: 1,
      });
      client.reset();
      await h.runner.turn(0).fail(new Error('the sandbox is unreachable'));

      expect(client.of('turn.end')[0]).toMatchObject({
        stopReason: 'error',
        firstSeq: 1,
      });
    });

    it('closes a turn abandoned by an abort without reporting an error', async () => {
      const h = harness();
      const client = h.connect();

      await send(client, {
        type: 'user.message',
        sessionKey: SESSION,
        content: 'go',
      });
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

      await send(client, {
        type: 'user.message',
        sessionKey: SESSION,
        content: 'go',
      });
      expect(client.of('error')[0]).toMatchObject({ code: 'internal' });
      expect(client.of('turn.end')).toHaveLength(1);

      broken = false;
      await send(client, {
        type: 'user.message',
        sessionKey: SESSION,
        content: 'again',
      });
      expect(runner.turns).toHaveLength(1);
    });

    it('stops every running turn on close', async () => {
      const h = harness();
      const client = h.connect();

      await send(client, {
        type: 'user.message',
        sessionKey: SESSION,
        content: 'go',
      });
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

      await send(a, {
        type: 'user.message',
        sessionKey: SESSION,
        content: 'hello',
      });
      const turn = h.runner.turn(0);
      await turn.emit({
        type: 'assistant.delta',
        turnId: turn.turnId,
        text: 'hi',
      });
      await turn.end();

      expect(b.frames).toEqual(a.frames);
      expect(c.frames).toEqual(a.frames);
      expect(a.of('assistant.delta')).toHaveLength(1);
    });

    it('counts who is looking at a session, which is what the approval gate asks', () => {
      // Zero is the unattended case — a scheduled run, or a tab closed
      // mid-turn — and it is the difference between a prompt somebody can
      // answer and a five-minute wait for a certain denial.
      const h = harness();
      expect(h.hub.watchers(SESSION)).toBe(0);

      const first = h.connect();
      expect(h.hub.watchers(SESSION)).toBe(1);

      const second = h.connect();
      expect(h.hub.watchers(SESSION)).toBe(2);

      second.close();
      expect(h.hub.watchers(SESSION)).toBe(1);
      first.close();
      expect(h.hub.watchers(SESSION)).toBe(0);

      // A session this process has never held is unattended, not an error.
      expect(h.hub.watchers('web:never-seen')).toBe(0);
    });

    it('does not count a connection with nobody on the end of it', () => {
      // The scheduler drives its turns through the hub, so a scheduled run has
      // a connection attached exactly like a browser tab does — and that made
      // every unattended run look watched, which is the one case `watchers`
      // exists to detect.
      const h = harness();
      h.hub.connect({
        send: () => undefined,
        sessionKey: SESSION,
        unattended: true,
      });
      expect(h.hub.watchers(SESSION)).toBe(0);

      // A real tab on the same session still counts.
      h.connect();
      expect(h.hub.watchers(SESSION)).toBe(1);
    });

    it('stops sending to a connection that closed', async () => {
      const h = harness();
      const staying = h.connect();
      const leaving = h.connect();
      leaving.close();
      leaving.close(); // idempotent
      staying.reset();
      leaving.reset();

      await send(staying, {
        type: 'user.message',
        sessionKey: SESSION,
        content: 'hello',
      });

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

      await send(stayed, {
        type: 'user.message',
        sessionKey: SESSION,
        content: 'hello',
      });

      expect(stayed.types()).toContain('message.ack');
      expect(switched.types()).toEqual([]);
    });

    it('broadcasts one frame to every attached client, across sessions', async () => {
      // What the scheduler raises notifications through: a nightly job's result
      // is addressed to whoever is looking, not to a conversation.
      const h = harness();
      const here = h.connect();
      const elsewhere = h.connect();
      await send(elsewhere, { type: 'session.switch', sessionKey: 'web:2' });
      here.reset();
      elsewhere.reset();

      h.hub.broadcast({
        type: 'notification',
        id: 'n1',
        title: 'Nightly finished',
        body: '',
        level: 'info',
        createdAtMs: 1,
        jobId: 'job-1',
      });

      expect(here.of('notification')).toHaveLength(1);
      expect(elsewhere.of('notification')).toHaveLength(1);
      expect(here.of('notification')[0]).toMatchObject({ jobId: 'job-1' });
    });

    it('stamps each session′s own seq rather than inventing a second sequence', async () => {
      const h = harness();
      const client = h.connect();
      await send(client, {
        type: 'user.message',
        sessionKey: SESSION,
        content: 'hello',
      });
      const turn = h.runner.turn(0);
      await turn.end();
      client.reset();

      h.hub.broadcast({
        type: 'notification',
        id: 'n1',
        title: 'x',
        body: '',
        level: 'info',
        createdAtMs: 1,
      });

      const [notification] = client.of('notification');
      expect(notification?.seq).toBeGreaterThan(0);
    });

    it('skips a session nobody is watching, so its seq stays honest', async () => {
      // Bumping a counter nobody is reading would leave a session that
      // reconnects later resuming at a `lastSeq` accounting for an event it was
      // never sent — exactly the gap `replay` reports as incomplete.
      const h = harness();
      const client = h.connect();
      await send(client, {
        type: 'user.message',
        sessionKey: SESSION,
        content: 'hello',
      });
      const turn = h.runner.turn(0);
      await turn.end();
      // The session's own counter, as the hub reports it to a joining client —
      // rather than guessing which frame happened to be last.
      const probe = h.connect();
      const before = probe.of('connected')[0]?.lastSeq;
      probe.close();
      client.close();

      h.hub.broadcast({
        type: 'notification',
        id: 'n1',
        title: 'x',
        body: '',
        level: 'info',
        createdAtMs: 1,
      });

      const reconnected = h.connect();
      expect(reconnected.of('connected')[0]?.lastSeq).toBe(before);
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

      await send(first, {
        type: 'user.message',
        sessionKey: SESSION,
        content: 'hello',
      });
      const turn = h.runner.turn(0);
      await turn.emit({
        type: 'turn.start',
        agentId: 'default',
        sessionKey: SESSION,
        turnId: turn.turnId,
        model: 'm',
        provider: 'p',
      });
      await turn.emit({
        type: 'assistant.delta',
        turnId: turn.turnId,
        text: 'one ',
      });
      const seenSoFar =
        first.frames.filter((frame) => 'seq' in frame).at(-1)?.seq ?? 0;

      // The tab reloads mid-turn and comes back.
      first.close();
      await turn.emit({
        type: 'assistant.delta',
        turnId: turn.turnId,
        text: 'two ',
      });
      await turn.emit({
        type: 'assistant.delta',
        turnId: turn.turnId,
        text: 'three',
      });

      const second = h.connect();
      second.reset();
      await send(second, {
        type: 'session.resume',
        sessionKey: SESSION,
        lastSeq: seenSoFar,
      });

      expect(second.of('session.replay')[0]).toMatchObject({
        complete: true,
        messages: [],
      });
      expect(second.of('assistant.delta').map((frame) => frame.text)).toEqual([
        'two ',
        'three',
      ]);
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
      await send(client, {
        type: 'user.message',
        sessionKey: SESSION,
        content: 'hello',
      });
      const turn = h.runner.turn(0);
      await turn.emit({
        type: 'assistant.delta',
        turnId: turn.turnId,
        text: 'a',
      });
      await turn.emit({
        type: 'assistant.delta',
        turnId: turn.turnId,
        text: 'b',
      });
      client.reset();

      await send(client, {
        type: 'session.resume',
        sessionKey: SESSION,
        lastSeq: 1,
      });

      const replay = client.of('session.replay')[0];
      expect(replay?.complete).toBe(false);
      expect(replay?.messages.map((stored) => stored.message.role)).toEqual([
        'user',
        'assistant',
      ]);
      // No tail: storage and the ring would render the same text twice.
      expect(client.of('assistant.delta')).toEqual([]);
    });

    it('tells a client that has seen everything that it missed nothing', async () => {
      const h = harness();
      const client = h.connect();
      await send(client, {
        type: 'user.message',
        sessionKey: SESSION,
        content: 'hello',
      });
      const lastSeq =
        client.frames.filter((frame) => 'seq' in frame).at(-1)?.seq ?? 0;
      client.reset();

      await send(client, {
        type: 'session.resume',
        sessionKey: SESSION,
        lastSeq,
      });

      expect(client.of('session.replay')[0]).toMatchObject({
        complete: true,
        messages: [],
      });
    });

    it('rebuilds a client whose session state was evicted', async () => {
      const h = harness({ maxSessions: 1 });
      const first = h.connect();
      await send(first, {
        type: 'user.message',
        sessionKey: SESSION,
        content: 'hello',
      });
      await h.runner.turn(0).end();
      first.close();

      // A second session arrives and the idle first one is dropped.
      const second = h.connect({ sessionKey: 'web:2' });
      expect(h.hub.sessionCount).toBe(1);

      second.close();
      const returning = h.connect();
      returning.reset();
      await send(returning, {
        type: 'session.resume',
        sessionKey: SESSION,
        lastSeq: 3,
      });

      expect(returning.of('session.replay')[0]?.complete).toBe(false);
    });

    it('keeps a live session rather than evicting to satisfy the cap', async () => {
      const h = harness({ maxSessions: 1 });
      const busy = h.connect();
      await send(busy, {
        type: 'user.message',
        sessionKey: SESSION,
        content: 'hello',
      });

      h.connect({ sessionKey: 'web:2' });

      expect(h.hub.sessionCount).toBe(2);
    });
  });

  describe('steering and approvals', () => {
    it('steers the loop the turn is running on and echoes it to every tab', async () => {
      const h = harness();
      const a = h.connect();
      const b = h.connect();
      await send(a, {
        type: 'user.message',
        sessionKey: SESSION,
        content: 'read the config',
      });
      a.reset();
      b.reset();

      await send(a, {
        type: 'turn.steer',
        sessionKey: SESSION,
        content: 'the other directory',
      });

      expect(h.runner.steers).toEqual([
        { sessionKey: SESSION, content: 'the other directory' },
      ]);
      expect(a.of('steer')[0]?.content).toBe('the other directory');
      expect(b.of('steer')).toHaveLength(1);
    });

    it('refuses a steer when no turn is running', async () => {
      const h = harness();
      const client = h.connect();
      client.reset();

      await send(client, {
        type: 'turn.steer',
        sessionKey: SESSION,
        content: 'wait',
      });

      expect(client.of('error')[0]).toMatchObject({ code: 'bad_request' });
      expect(h.runner.steers).toEqual([]);
    });

    it('resolves a pending approval from an inbound tool.approve', async () => {
      const h = harness();
      const client = h.connect();
      const controller = new AbortController();
      const decision = h.approvals.request({
        sessionKey: SESSION,
        agentId: 'default',
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

      await expect(decision).resolves.toEqual({
        approved: true,
        scope: 'session',
      });
    });

    it('says nothing when an approval arrives too late to matter', async () => {
      const h = harness();
      const client = h.connect();
      client.reset();

      await send(client, {
        type: 'tool.approve',
        callId: 'call-gone',
        approved: true,
      });

      expect(client.types()).toEqual([]);
    });

    it('reports that transcription is not configured', async () => {
      const h = harness();
      const client = h.connect();
      client.reset();

      await send(client, {
        type: 'audio.transcribe',
        audio: 'AAAA',
        mimeType: 'audio/webm',
      });

      expect(client.of('error')[0]).toMatchObject({ code: 'config_invalid' });
    });
  });
});

describe('regenerating a turn', () => {
  /** A completed exchange: the question at seq 1, the answer at seq 2. */
  function seeded(h: Harness): void {
    h.store.append(SESSION, userMessage('the original question'), {
      turnId: 't1',
    });
    h.store.append(SESSION, assistantMessage('the first answer'), {
      turnId: 't1',
    });
  }

  it('drops the old answer and re-runs the question', async () => {
    const h = harness();
    seeded(h);
    const client = h.connect({ sessionKey: SESSION });

    client.receive({ type: 'turn.regenerate', sessionKey: SESSION });
    await flush();

    // Both rows are gone: the loop re-appends the question itself, so leaving
    // it behind would write it twice.
    expect(h.store.messageCount(SESSION)).toBe(0);
    expect(h.runner.turns).toHaveLength(1);
    expect(h.runner.turn(0).input.content).toEqual([
      { type: 'text', text: 'the original question' },
    ]);
  });

  it('echoes the client message id so the optimistic bubble can be claimed', async () => {
    // The rewind deletes the question and the loop writes it back, so the asking
    // tab is showing a bubble of its own in the gap. `message.ack` is what tells
    // it that bubble is now a real message; without the id it never matches and
    // the bubble sits on "Sending…" for the life of the session.
    const h = harness();
    seeded(h);
    const client = h.connect({ sessionKey: SESSION });
    client.reset();

    client.receive({
      type: 'turn.regenerate',
      sessionKey: SESSION,
      clientMessageId: 'c-9',
    });
    await flush();

    expect(client.of('message.ack')[0]).toMatchObject({
      clientMessageId: 'c-9',
    });
  });

  it('tells every attached tab what survived', async () => {
    const h = harness();
    seeded(h);
    const client = h.connect({ sessionKey: SESSION });
    const second = h.connect({ sessionKey: SESSION });

    client.receive({ type: 'turn.regenerate', sessionKey: SESSION });
    await flush();

    for (const tab of [client, second]) {
      const [frame] = tab.of('session.truncated');
      expect(frame?.upToSeq).toBe(0);
      expect(frame?.messages).toEqual([]);
    }
  });

  it('re-runs an earlier question when one is named', async () => {
    const h = harness();
    seeded(h);
    h.store.append(SESSION, userMessage('a second question'), { turnId: 't2' });
    h.store.append(SESSION, assistantMessage('a second answer'), {
      turnId: 't2',
    });
    const client = h.connect({ sessionKey: SESSION });

    client.receive({ type: 'turn.regenerate', sessionKey: SESSION, seq: 1 });
    await flush();

    expect(h.store.messageCount(SESSION)).toBe(0);
    expect(h.runner.turn(0).input.content).toEqual([
      { type: 'text', text: 'the original question' },
    ]);
  });

  it('picks the question, not a steer that landed during the turn', async () => {
    const h = harness();
    h.store.append(SESSION, userMessage('the real question'), { turnId: 't1' });
    // Steering appends a user row mid-turn under the same turn id.
    h.store.append(SESSION, userMessage('actually, focus on the parser'), {
      turnId: 't1',
    });
    h.store.append(SESSION, assistantMessage('an answer'), { turnId: 't1' });
    const client = h.connect({ sessionKey: SESSION });

    client.receive({ type: 'turn.regenerate', sessionKey: SESSION });
    await flush();

    expect(h.runner.turn(0).input.content).toEqual([
      { type: 'text', text: 'the real question' },
    ]);
  });

  it('refuses when there is nothing to re-run', async () => {
    const h = harness();
    const client = h.connect({ sessionKey: SESSION });

    client.receive({ type: 'turn.regenerate', sessionKey: SESSION });
    await flush();

    expect(client.of('error')[0]?.code).toBe('bad_request');
    expect(h.runner.turns).toHaveLength(0);
  });

  it('refuses while a turn is running', async () => {
    const h = harness();
    seeded(h);
    const client = h.connect({ sessionKey: SESSION });
    client.receive({
      type: 'user.message',
      sessionKey: SESSION,
      content: 'hello',
    });
    await flush();
    client.reset();

    client.receive({ type: 'turn.regenerate', sessionKey: SESSION });
    await flush();

    expect(client.of('error')[0]?.code).toBe('session_busy');
    // The history it would have rewritten is untouched.
    expect(h.store.messageCount(SESSION)).toBeGreaterThan(0);
  });

  it('checks for a model before it deletes anything', async () => {
    const h = harness({ loop: () => null });
    seeded(h);
    const client = h.connect({ sessionKey: SESSION });

    client.receive({ type: 'turn.regenerate', sessionKey: SESSION });
    await flush();

    expect(client.of('error')[0]?.code).toBe('not_configured');
    // The point of the ordering: truncating first would have destroyed the
    // answer and returned nothing in its place.
    expect(h.store.messageCount(SESSION)).toBe(2);
  });
});

describe('editing a message', () => {
  function seeded(h: Harness): void {
    h.store.append(SESSION, userMessage('the original question'), {
      turnId: 't1',
    });
    h.store.append(SESSION, assistantMessage('the first answer'), {
      turnId: 't1',
    });
  }

  it('replaces the message and re-runs from it', async () => {
    const h = harness();
    seeded(h);
    const client = h.connect({ sessionKey: SESSION });

    client.receive({
      type: 'user.edit',
      sessionKey: SESSION,
      seq: 1,
      content: 'a better question',
    });
    await flush();

    expect(h.store.messageCount(SESSION)).toBe(0);
    // A plain string, exactly as `user.message` produces for text with no
    // attachments — an edit takes the same path a first send does.
    expect(h.runner.turn(0).input.content).toBe('a better question');
  });

  it('keeps later turns when an earlier message is edited', async () => {
    const h = harness();
    seeded(h);
    h.store.append(SESSION, userMessage('a second question'), { turnId: 't2' });
    const client = h.connect({ sessionKey: SESSION });

    client.receive({
      type: 'user.edit',
      sessionKey: SESSION,
      seq: 3,
      content: 'rewritten',
    });
    await flush();

    // Everything before the edited message survives.
    expect(h.store.messages(SESSION).map((record) => record.seq)).toEqual([
      1, 2,
    ]);
  });

  it('refuses a seq that is not a message the user wrote', async () => {
    const h = harness();
    seeded(h);
    const client = h.connect({ sessionKey: SESSION });

    // seq 2 is the assistant's answer.
    client.receive({
      type: 'user.edit',
      sessionKey: SESSION,
      seq: 2,
      content: 'nope',
    });
    await flush();

    expect(client.of('error')[0]?.code).toBe('bad_request');
    expect(h.store.messageCount(SESSION)).toBe(2);
  });

  it('refuses an empty replacement', async () => {
    const h = harness();
    seeded(h);
    const client = h.connect({ sessionKey: SESSION });

    client.receive({
      type: 'user.edit',
      sessionKey: SESSION,
      seq: 1,
      content: '',
    });
    await flush();

    expect(client.of('error')[0]?.code).toBe('bad_request');
    expect(h.store.messageCount(SESSION)).toBe(2);
  });

  it('checks for a model before it deletes anything', async () => {
    const h = harness({ loop: () => null });
    seeded(h);
    const client = h.connect({ sessionKey: SESSION });

    client.receive({
      type: 'user.edit',
      sessionKey: SESSION,
      seq: 1,
      content: 'rewritten',
    });
    await flush();

    expect(client.of('error')[0]?.code).toBe('not_configured');
    expect(h.store.messageCount(SESSION)).toBe(2);
  });

  it('refuses while a turn is running', async () => {
    const h = harness();
    seeded(h);
    const client = h.connect({ sessionKey: SESSION });
    client.receive({
      type: 'user.message',
      sessionKey: SESSION,
      content: 'hello',
    });
    await flush();
    client.reset();

    client.receive({
      type: 'user.edit',
      sessionKey: SESSION,
      seq: 1,
      content: 'rewritten',
    });
    await flush();

    expect(client.of('error')[0]?.code).toBe('session_busy');
  });

  it('acks with the client id, so the optimistic bubble reconciles', async () => {
    const h = harness();
    seeded(h);
    const client = h.connect({ sessionKey: SESSION });

    client.receive({
      type: 'user.edit',
      sessionKey: SESSION,
      seq: 1,
      content: 'a better question',
      clientMessageId: 'c1',
    });
    await flush();

    expect(client.of('message.ack')[0]?.clientMessageId).toBe('c1');
  });
});

describe('SessionHub agent routing', () => {
  /** Records which agent each turn was resolved for. */
  function tracking(): {
    readonly asked: Array<string | undefined>;
    readonly loop: (agentId: string | undefined) => TurnRunner;
    readonly runner: ScriptedRunner;
  } {
    const asked: Array<string | undefined> = [];
    const runner = new ScriptedRunner();
    return {
      asked,
      runner,
      loop: (agentId) => {
        asked.push(agentId);
        return runner;
      },
    };
  }

  /** `agents.list` with the named ids enabled, as an operator would write them. */
  function configured(...ids: readonly string[]): Record<string, unknown> {
    return Object.fromEntries(ids.map((id) => [id, { label: id }]));
  }

  it('resolves the loop for the agent a frame names', async () => {
    const tracked = tracking();
    const h = harness({ loop: tracked.loop, agents: configured('reviewer') });
    const client = h.connect();

    await send(client, {
      type: 'user.message',
      sessionKey: SESSION,
      content: 'hello',
      agentId: 'reviewer',
    });

    expect(tracked.asked).toEqual(['reviewer']);
  });

  it('asks for the default when no frame names an agent', async () => {
    const tracked = tracking();
    const h = harness({ loop: tracked.loop });
    const client = h.connect();

    await send(client, {
      type: 'user.message',
      sessionKey: SESSION,
      content: 'hello',
    });

    // Named rather than left `undefined`: the hub has decided which agent runs
    // and says which, so the id it asks for and the id it reports on
    // `turn.start` cannot drift apart. `loopFor` treats the two identically.
    expect(tracked.asked).toEqual(['default']);
  });

  it('lets the stored session win over a frame that names another agent', async () => {
    // A history built under one agent's prompt, tools and permissions must not
    // silently continue under another's.
    const tracked = tracking();
    const h = harness({
      loop: tracked.loop,
      agents: configured('reviewer', 'writer'),
    });
    h.store.ensureSession(SESSION, { agentId: 'reviewer' });
    const client = h.connect();

    await send(client, {
      type: 'user.message',
      sessionKey: SESSION,
      content: 'hello',
      agentId: 'writer',
    });

    expect(tracked.asked).toEqual(['reviewer']);
  });

  it('runs on the default agent when the one a session names is gone', async () => {
    // A conversation must not stop working because the agent it was bound to
    // was deleted — an agent id is user-authored and can go at any moment.
    const tracked = tracking();
    const h = harness({ loop: tracked.loop });
    h.store.ensureSession(SESSION, { agentId: 'reviewer' });
    const client = h.connect();

    await send(client, {
      type: 'user.message',
      sessionKey: SESSION,
      content: 'hello',
    });

    expect(tracked.asked).toEqual(['default']);
    expect(client.of('notice')[0]).toMatchObject({ kind: 'agent_fallback' });
    expect(client.of('notice')[0]).toMatchObject({
      message: /no longer exists/,
    });

    // The turn happened: this is a notice, not a refusal. Driven to completion
    // rather than asserted mid-flight, so what is checked is where the turn
    // settled and not whether it had got there yet.
    await tracked.runner.turn(0).end();
    expect(client.of('turn.end')).toHaveLength(1);
  });

  it('says so differently when the agent is merely switched off', async () => {
    const h = harness({
      agents: { reviewer: { label: 'Reviewer', enabled: false } },
    });
    h.store.ensureSession(SESSION, { agentId: 'reviewer' });
    const client = h.connect();

    await send(client, {
      type: 'user.message',
      sessionKey: SESSION,
      content: 'hello',
    });

    expect(client.of('notice')[0]).toMatchObject({ message: /switched off/ });
  });

  it('does not raise the notice when the binding resolves', async () => {
    const h = harness({ agents: configured('reviewer') });
    h.store.ensureSession(SESSION, { agentId: 'reviewer' });
    const client = h.connect();

    await send(client, {
      type: 'user.message',
      sessionKey: SESSION,
      content: 'hello',
    });

    expect(client.of('notice')).toHaveLength(0);
  });

  it('raises the notice again on the next turn, because nothing was written', async () => {
    // The binding is deliberately left alone, so re-creating the agent restores
    // every conversation waiting for it. The cost is that the fallback is
    // re-decided each turn — so a notice fired once would describe a state the
    // operator could no longer see.
    const h = harness();
    h.store.ensureSession(SESSION, { agentId: 'reviewer' });
    const client = h.connect();

    // Each turn is finished before the next is sent: a second message arriving
    // mid-turn is queued, and one turn cannot raise two notices.
    await send(client, {
      type: 'user.message',
      sessionKey: SESSION,
      content: 'one',
    });
    await h.runner.turn(0).end();
    await send(client, {
      type: 'user.message',
      sessionKey: SESSION,
      content: 'two',
    });
    await h.runner.turn(1).end();

    expect(client.of('notice')).toHaveLength(2);
    // And the session still says what it was bound to.
    expect(h.store.getSession(SESSION)?.agentId).toBe('reviewer');
  });

  it('lets an explicit pick beat a stored binding that no longer resolves', async () => {
    // The stored-wins rule protects a conversation from continuing under
    // settings it was not built with. A deleted agent offers no such settings,
    // so outranking the operator's pick would only drop them onto `default`
    // while they watched themselves choose something else.
    const tracked = tracking();
    const h = harness({ loop: tracked.loop, agents: configured('writer') });
    h.store.ensureSession(SESSION, { agentId: 'reviewer' });
    const client = h.connect();

    await send(client, {
      type: 'user.message',
      sessionKey: SESSION,
      content: 'hello',
      agentId: 'writer',
    });

    expect(tracked.asked).toEqual(['writer']);
    expect(client.of('notice')).toHaveLength(0);
  });

  it('still fails the turn for an agent that exists and cannot be built', async () => {
    // The backstop survives: a missing agent is a stale reference, but settings
    // that were never going to work are a real fault and stay loud.
    const runner = new ScriptedRunner();
    const h = harness({
      agents: configured('boxed'),
      loop: (agentId) => {
        if (agentId === 'boxed') {
          throw new GhostError('config', 'names no toolbox');
        }
        return runner;
      },
    });
    const client = h.connect();

    await send(client, {
      type: 'user.message',
      sessionKey: SESSION,
      content: 'hello',
      agentId: 'boxed',
    });

    expect(client.of('error')[0]).toMatchObject({ code: 'config_invalid' });
    expect(runner.turns).toHaveLength(0);

    // The socket is fine: the next turn reaches a runner as usual.
    await send(client, {
      type: 'user.message',
      sessionKey: SESSION,
      content: 'hi',
    });
    expect(runner.turns).toHaveLength(1);
  });

  it('takes the agent a session.new names as the connection default', async () => {
    // The field used to be read off the frame and dropped, so `connection.agentId`
    // could only ever be set at connect time. The web client resends it on every
    // message, which is what hid it; a channel does not.
    const tracked = tracking();
    const h = harness({ loop: tracked.loop, agents: configured('writer') });
    const client = h.connect();

    await send(client, {
      type: 'session.new',
      sessionKey: 'fresh',
      agentId: 'writer',
    });
    await send(client, {
      type: 'user.message',
      sessionKey: 'fresh',
      content: 'hello',
    });

    expect(tracked.asked).toEqual(['writer']);
  });
});

describe('announcing a workspace move', () => {
  it('re-emits the status with the workspace the store now holds', async () => {
    // The route writes, then says so in one verb. The hub is not handed the new
    // id — it re-reads the row — so the two cannot disagree about what landed.
    const h = harness();
    const client = h.connect();
    await send(client, {
      type: 'user.message',
      sessionKey: SESSION,
      content: 'hello',
    });
    await h.runner.turn(0).end();

    h.store.updateSession(SESSION, { workspaceId: 'research' });
    h.hub.sessionMoved(SESSION);

    expect(client.of('session.status').at(-1)).toMatchObject({
      workspaceId: 'research',
    });
  });

  it('says nothing for a session nobody has open', () => {
    // `sessions.get`, not `session`: a PATCH for a conversation with no hub
    // state must not bring any into existence for it.
    const h = harness();
    expect(() => {
      h.hub.sessionMoved('never-opened');
    }).not.toThrow();
  });

  it('does not bump seq for a session with no client attached', async () => {
    // The `broadcast` contract: a counter moved for nobody leaves a later
    // reconnect resuming at a `lastSeq` that accounts for a frame it was never
    // sent, which `replay` then reports as an incomplete gap.
    //
    // Read through the `connected` frame's `lastSeq`, which is where a
    // reconnecting client resumes from — the number the hazard is actually
    // about.
    const h = harness();
    const client = h.connect();
    await send(client, {
      type: 'user.message',
      sessionKey: SESSION,
      content: 'hello',
    });
    await h.runner.turn(0).end();
    client.close();

    const probe = h.connect();
    const before = probe.of('connected')[0]?.lastSeq;
    probe.close();

    h.hub.sessionMoved(SESSION);

    const reopened = h.connect();
    expect(reopened.of('connected')[0]?.lastSeq).toBe(before);
  });
});
