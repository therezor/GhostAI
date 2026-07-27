/**
 * The socket, bound to the hub.
 *
 * There is almost nothing here, and that is the design working: `SessionHub` is
 * transport-agnostic — `connect({ send })`, `receive(frame)`, `close()` — so
 * binding it to a WebSocket is three event handlers. Everything a client can do
 * arrives as a frame the hub parses, and everything the server says goes out
 * through the one `send`. A channel binds the same three without a socket, and
 * gets the same queueing, the same replay and the same approval gate.
 *
 * The three decisions worth stating:
 *
 *  - **The upgrade is authenticated, by the same hook as every other route.**
 *    It is `auth: 'required'` in the manifest, so the auth matrix covers it —
 *    an unauthenticated socket is an anonymous, shell-capable agent, and it
 *    would not even show up in the route table it was missing from.
 *  - **A plain GET answers 426 rather than 404.** `{ websocket: true }` would
 *    hide the route from the generated document and answer a bare 404; a client
 *    that forgot the upgrade headers then reads it as "wrong URL" and looks for
 *    a path that does not exist.
 *  - **A socket that stops reading is closed, not buffered.** `send` throws
 *    once the outbound buffer passes the cap, which the hub reads as a dead
 *    connection and detaches; without it, one tab that stopped draining grows
 *    the process by the whole of a turn's output for as long as it stays open.
 */

import type { WebSocket } from '@fastify/websocket';
import { silentLogger, type Logger } from '@ghostai/core';
import type { ServerMessage } from '@ghostai/protocol';
import type { FastifyRequest } from 'fastify';

import { HttpError } from '../errors.js';
import { WsQuerySchema, type WsQuery } from '../queries.js';
import type { RouteDeps, RouteGroup } from './types.js';

type WsRouteId = 'ws.connect';

/**
 * How much may sit in one socket's outbound buffer before it is hung up.
 *
 * A turn's worth of deltas is tens of kilobytes; anything approaching this is a
 * client that is no longer reading, and holding its stream in memory helps
 * nobody — least of all the other tabs on the same session.
 */
export const MAX_BUFFERED_BYTES: number = 4 * 1024 * 1024;

export function wsRoutes(deps: RouteDeps): RouteGroup<WsRouteId> {
  const logger: Logger = deps.logger ?? silentLogger;

  return {
    'ws.connect': {
      summary: 'Upgrade to the GhostAI WebSocket protocol',
      schema: { querystring: WsQuerySchema },
      // Not an upgrade. Fastify has already run the auth hook and the query
      // schema by the time this is reached, so what is left really is only the
      // missing header.
      handler: () => {
        throw new HttpError(
          426,
          'bad_request',
          'invalid_input',
          'This endpoint speaks the GhostAI WebSocket protocol. Connect with an Upgrade request.',
        );
      },
      wsHandler: (socket: WebSocket, request: FastifyRequest) => {
        const query = request.query as WsQuery;

        const client = deps.hub.connect({
          send: (message: ServerMessage) => {
            // A throw here is the hub's signal to detach this connection. Both
            // branches are that signal: a socket that is closing, and one that
            // has stopped reading what it asked for.
            if (socket.readyState !== socket.OPEN) throw new Error('socket is not open');
            if (socket.bufferedAmount > MAX_BUFFERED_BYTES) {
              socket.close(1013, 'client is not reading');
              throw new Error('socket backpressure limit exceeded');
            }
            socket.send(JSON.stringify(message));
          },
          ...(query.session === undefined ? {} : { sessionKey: query.session }),
          channel: 'web',
        });

        // Raw frames: the hub decodes bytes, parses JSON and answers a bad
        // frame with an `error` event, so nothing here can throw on input a
        // client controls.
        socket.on('message', (data: unknown) => {
          client.receive(data);
        });
        socket.on('close', () => {
          client.close();
        });
        socket.on('error', (error: Error) => {
          logger.debug({ err: error, connectionId: client.id }, 'websocket errored');
          client.close();
        });
      },
    },
  };
}
