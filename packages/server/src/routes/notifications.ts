/**
 * The notification list a UI shows, and the two ways an entry leaves it.
 *
 * Nothing here creates one. Notifications are raised by things that run without
 * anyone watching — an automation run finishing, an approval expiring — and the
 * route surface is deliberately read-and-dismiss: a `POST /api/notifications`
 * would be an endpoint whose only purpose is letting a client fabricate the
 * server's own reports.
 */

import {
  NotificationListResponseSchema,
  NotificationSchema,
  type Notification,
  type NotificationListResponse,
} from '@ghostai/protocol';
import type { FastifyReply } from 'fastify';

import {
  assertOnePagingMode,
  decodeNotificationCursor,
  encodeNotificationCursor,
  paginate,
} from '../cursor.js';
import { notFound } from '../errors.js';
import {
  IdParamsSchema,
  NotificationListQuerySchema,
  type IdParams,
  type NotificationListQuery,
} from '../queries.js';
import type { RouteDeps, RouteGroup } from './types.js';

type NotificationRouteId =
  | 'notifications.list'
  | 'notifications.read'
  | 'notifications.readAll'
  | 'notifications.delete'
  | 'notifications.deleteAll';

export function notificationRoutes(
  deps: RouteDeps,
): RouteGroup<NotificationRouteId> {
  const store = deps.notifications;

  return {
    'notifications.list': {
      summary: 'Notifications, newest first',
      schema: {
        querystring: NotificationListQuerySchema,
        response: { 200: NotificationListResponseSchema },
      },
      handler: (request): NotificationListResponse => {
        const query = request.query as NotificationListQuery;
        assertOnePagingMode(query);

        const unreadOnly = query.unread === true;
        const rows = store.list({
          limit: query.limit + 1,
          ...(unreadOnly ? { unreadOnly: true } : {}),
          ...(query.offset === undefined ? {} : { offset: query.offset }),
          ...(query.cursor === undefined
            ? {}
            : { after: decodeNotificationCursor(query.cursor) }),
        });

        const { page, next } = paginate(rows, query.limit, (last) =>
          encodeNotificationCursor({
            createdAtMs: last.createdAtMs,
            id: last.id,
          }),
        );
        return {
          notifications: page,
          // Always the total, never the count of what this page happened to
          // contain: the badge counts what is waiting, not what is on screen.
          unreadCount: store.unreadCount(),
          // A different number from `unreadCount` whenever the filter is off,
          // and the pager needs this one: how many rows it is paging through,
          // not how many of them are still unread.
          total: store.count({ unreadOnly }),
          ...next,
        };
      },
    },

    'notifications.read': {
      summary: 'Mark one notification read',
      schema: { params: IdParamsSchema, response: { 200: NotificationSchema } },
      handler: (request): Notification => {
        const { id } = request.params as IdParams;
        const updated = store.markRead(id);
        if (updated === undefined) throw notFound(`No notification "${id}"`);
        // The updated row rather than a 204, so a client can reconcile one item
        // instead of refetching a list it is in the middle of scrolling.
        return updated;
      },
    },

    'notifications.readAll': {
      summary: 'Mark every notification read',
      schema: {},
      handler: (request, reply): FastifyReply => {
        store.markAllRead();
        return reply.status(204).send();
      },
    },

    /**
     * Empties the list, read and unread alike.
     *
     * Its own route rather than a flag on the single delete: `DELETE /x/:id`
     * with an id that means "all of them" is an id a typo can produce. What is
     * *not* here is a confirmation — that belongs to the UI, which is where a
     * person is standing. The server's job is to do exactly what was asked.
     */
    'notifications.deleteAll': {
      summary: 'Delete every notification',
      schema: {},
      handler: (request, reply): FastifyReply => {
        store.deleteAll();
        // 204 like its siblings. The count went nowhere useful: a client that
        // just emptied the list refetches it, and a number it cannot act on is
        // a number it would have to invent a use for.
        return reply.status(204).send();
      },
    },

    'notifications.delete': {
      summary: 'Delete one notification',
      schema: { params: IdParamsSchema },
      handler: (request, reply): FastifyReply => {
        const { id } = request.params as IdParams;
        if (!store.delete(id)) throw notFound(`No notification "${id}"`);
        return reply.status(204).send();
      },
    },
  };
}
