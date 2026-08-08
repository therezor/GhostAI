/**
 * The socket, over a real socket.
 *
 * `fastify.inject()` cannot upgrade a connection, so this is the one route
 * whose test has to bind a port and speak WebSocket to it. What is being
 * checked is the binding rather than the hub — `hub.test.ts` owns queueing,
 * replay and fanout — so: that the upgrade is authenticated, that frames go
 * both ways, that a session named in the query is the session that runs, and
 * that a request without the upgrade headers gets an answer a human can read.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import type { ServerMessage } from '@ghostbot/protocol';

import { startTestServer, type TestServer } from '#testkit/server.js';

const running: TestServer[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  while (running.length > 0) await running.pop()?.close();
});

interface Connection {
  readonly socket: WebSocket;
  /** Every frame the server sent, parsed. */
  readonly frames: ServerMessage[];
  /** Resolves once a frame of this type arrives, or rejects after a second. */
  next(type: ServerMessage['type']): Promise<ServerMessage>;
  send(frame: unknown): void;
}

async function listening(
  options: Parameters<typeof startTestServer>[0] = {},
): Promise<{
  test: TestServer;
  url: string;
}> {
  const test = await startTestServer(options);
  running.push(test);
  const address = await test.server.listen({ host: '127.0.0.1', port: 0 });
  return { test, url: address.replace('http://', 'ws://') };
}

/** Opens a socket and collects what arrives on it. */
async function connect(
  url: string,
  headers: Record<string, string> = {},
): Promise<Connection> {
  const socket = new WebSocket(url, { headers });
  sockets.push(socket);
  const frames: ServerMessage[] = [];
  const waiters: Array<{
    type: string;
    resolve: (message: ServerMessage) => void;
  }> = [];

  socket.on('message', (data: Buffer) => {
    const message = JSON.parse(data.toString('utf8')) as ServerMessage;
    frames.push(message);
    const index = waiters.findIndex((waiter) => waiter.type === message.type);
    if (index >= 0) waiters.splice(index, 1)[0]?.resolve(message);
  });

  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });

  return {
    socket,
    frames,
    next: async (type) => {
      const seen = frames.find((frame) => frame.type === type);
      if (seen !== undefined) return seen;
      return await new Promise<ServerMessage>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`No ${type} frame arrived`));
        }, 2000);
        waiters.push({
          type,
          resolve: (message) => {
            clearTimeout(timer);
            resolve(message);
          },
        });
      });
    },
    send: (frame: unknown) => {
      socket.send(JSON.stringify(frame));
    },
  };
}

describe('GET /ws', () => {
  it('refuses an upgrade with no credential', async () => {
    const { url } = await listening();

    await expect(connect(`${url}/ws`)).rejects.toThrow(/401/);
  });

  it('greets an authenticated socket with the protocol version', async () => {
    const { test, url } = await listening();

    const connection = await connect(`${url}/ws`, test.headers);
    const greeting = await connection.next('connected');

    expect(greeting).toMatchObject({
      type: 'connected',
      protocolVersion: 2,
      lastSeq: 0,
    });
  });

  it('opens on the session the query names, and runs a turn on it', async () => {
    const { test, url } = await listening({ answer: 'the answer' });

    const connection = await connect(`${url}/ws?session=web:42`, test.headers);
    await connection.next('connected');
    connection.send({
      type: 'user.message',
      sessionKey: 'web:42',
      content: 'a question',
    });

    const delta = await connection.next('assistant.delta');
    await connection.next('turn.end');

    expect(delta).toMatchObject({
      type: 'assistant.delta',
      text: 'the answer',
    });
    expect(test.runner.inputs[0]).toMatchObject({
      sessionKey: 'web:42',
      content: 'a question',
    });
    // The origin every session list and every prompt reads.
    expect(test.runner.inputs[0]?.channel).toBe('web');
  });

  it('answers a malformed frame instead of dropping the connection', async () => {
    const { test, url } = await listening();

    const connection = await connect(`${url}/ws`, test.headers);
    await connection.next('connected');
    connection.socket.send('{not json');

    const error = await connection.next('error');
    expect(error).toMatchObject({ type: 'error', code: 'bad_request' });
    expect(connection.socket.readyState).toBe(WebSocket.OPEN);
  });

  it('rejects a query the schema refuses, before upgrading anything', async () => {
    const { test, url } = await listening();

    // 422, the same code every other route answers a failed schema with.
    await expect(connect(`${url}/ws?session=`, test.headers)).rejects.toThrow(
      /422/,
    );
  });

  it('tells an ordinary GET what the endpoint actually speaks', async () => {
    const { test } = await listening();

    const response = await test.server.app.inject({
      method: 'GET',
      url: '/ws',
      headers: test.headers,
    });

    expect(response.statusCode).toBe(426);
    expect(response.json()).toEqual({
      error: {
        code: 'bad_request',
        message: expect.stringContaining('WebSocket'),
      },
    });
  });

  it('detaches a socket that closed, leaving the session for the next tab', async () => {
    const { test, url } = await listening();

    const connection = await connect(`${url}/ws?session=web:1`, test.headers);
    await connection.next('connected');
    connection.socket.close();
    await new Promise((resolve) => setTimeout(resolve, 50));

    // The state survives the connection: that is what a replay buffer is for.
    expect(test.hub.sessionCount).toBe(1);
    expect(test.hub.busy('web:1')).toBe(false);
  });
});
