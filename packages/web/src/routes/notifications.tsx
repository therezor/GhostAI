/**
 * The notification centre.
 *
 * Notifications are what the server says while nobody is looking — an
 * automation run that finished, an approval that expired, a channel that
 * dropped — so this panel is read-and-dismiss and has no way to create one. The
 * server has no route for that either, deliberately: a `POST /api/notifications`
 * would exist solely to let a client fabricate the server's own reports.
 *
 * "Read" is a timestamp rather than a flag, because the question a badge asks is
 * *when* did this stop being new. Marking one read writes the returned row into
 * the cache rather than refetching the list — the route answers with the updated
 * row for exactly that reason, so one item reconciles without replacing every
 * other row object on a list someone is in the middle of scrolling.
 *
 * A notification carrying a session key is a link into that conversation. That
 * is the whole point of the field: "the job you scheduled produced this" is only
 * useful if the answer is one press away.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { AlertTriangle, Bell, CheckCheck, CircleAlert, Info, Trash2 } from 'lucide-react';
import type { JSX } from 'react';

import type { Notification, NotificationListResponse } from '@ghostai/protocol';

import { cn } from '@/lib/cn.js';
import { api } from '@/lib/api.js';
import { formatRelativeTime } from '@/lib/format.js';
import { queryKeys } from '@/lib/query.js';
import { Button } from '@/components/ui/button.js';
import { toast } from '@/components/ui/toast.js';

const LEVEL_ICONS = {
  info: Info,
  success: CheckCheck,
  warning: AlertTriangle,
  error: CircleAlert,
} as const;

const LEVEL_CLASSES = {
  info: 'notification__icon--info',
  success: 'notification__icon--success',
  warning: 'notification__icon--warning',
  error: 'notification__icon--error',
} as const;

export function NotificationsRoute(): JSX.Element {
  const queryClient = useQueryClient();

  const notifications = useQuery({
    queryKey: queryKeys.notifications,
    queryFn: ({ signal }) => api.notifications(signal),
  });

  const markRead = useMutation({
    mutationFn: (id: string) => api.readNotification(id),
    onSuccess: (updated) => {
      queryClient.setQueryData(
        queryKeys.notifications,
        (current: NotificationListResponse | undefined) =>
          current === undefined ? current : replaceRow(current, updated),
      );
    },
    onError: (error: Error) => {
      toast.error('Could not mark it read', error.message);
    },
  });

  const markAllRead = useMutation({
    mutationFn: () => api.readAllNotifications(),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.notifications });
    },
    onError: (error: Error) => {
      toast.error('Could not mark them read', error.message);
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.deleteNotification(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.notifications });
    },
    onError: (error: Error) => {
      toast.error('Could not delete it', error.message);
    },
  });

  const unreadCount = notifications.data?.unreadCount ?? 0;
  const rows = notifications.data?.notifications ?? [];
  // One instant for the whole list: two rows measured against two `Date.now()`
  // calls can disagree about which is older.
  const now = Date.now();

  return (
    <div className="stack page page--reading">
      <div className="cluster page__header">
        <h1 className="page__title">Notifications</h1>
        <span className="page__note">
          {unreadCount === 0 ? 'All caught up' : `${String(unreadCount)} unread`}
        </span>
        <span className="spacer" />
        <Button
          variant="secondary"
          disabled={unreadCount === 0 || markAllRead.isPending}
          onClick={() => {
            markAllRead.mutate();
          }}
        >
          <CheckCheck />
          Mark all read
        </Button>
      </div>

      {notifications.isPending && <p className="page__note">Loading…</p>}
      {notifications.isError && (
        <p role="alert" className="page__error">
          Could not load notifications: {notifications.error.message}
        </p>
      )}

      {notifications.isSuccess &&
        (rows.length === 0 ? (
          <div className="stack page__empty">
            <Bell />
            <p className="page__empty-title">Nothing here yet.</p>
            <p className="page__empty-note">
              Automation runs and expired approvals report themselves here.
            </p>
          </div>
        ) : (
          <ul className="stack notification-list">
            {rows.map((row) => (
              <li key={row.id}>
                <NotificationRow
                  notification={row}
                  now={now}
                  onRead={() => {
                    markRead.mutate(row.id);
                  }}
                  onDelete={() => {
                    remove.mutate(row.id);
                  }}
                />
              </li>
            ))}
          </ul>
        ))}
    </div>
  );
}

function NotificationRow({
  notification,
  now,
  onRead,
  onDelete,
}: {
  readonly notification: Notification;
  readonly now: number;
  readonly onRead: () => void;
  readonly onDelete: () => void;
}): JSX.Element {
  const unread = notification.readAtMs === undefined;
  const Icon = LEVEL_ICONS[notification.level];

  return (
    <article
      aria-label={notification.title}
      className={cn('notification', unread && 'notification--unread')}
    >
      <Icon className={cn('notification__icon', LEVEL_CLASSES[notification.level])} />

      <div className="stack notification__body">
        <div className="cluster notification__head">
          <span className="notification__title">{notification.title}</span>
          <time
            dateTime={new Date(notification.createdAtMs).toISOString()}
            className="notification__time"
          >
            {formatRelativeTime(notification.createdAtMs, now)}
          </time>
        </div>

        {notification.body !== '' && <p className="notification__text">{notification.body}</p>}

        <div className="cluster notification__actions">
          {notification.sessionKey !== undefined && (
            <Link
              to="/"
              search={{ session: notification.sessionKey }}
              className="notification__link"
            >
              Open the conversation
            </Link>
          )}
          {unread && (
            <Button variant="ghost" size="sm" onClick={onRead}>
              Mark read
            </Button>
          )}
        </div>
      </div>

      <Button
        variant="ghost"
        size="icon"
        aria-label={`Delete “${notification.title}”`}
        onClick={onDelete}
      >
        <Trash2 />
      </Button>
    </article>
  );
}

/** One row replaced, with the unread count recounted from what is now in hand. */
function replaceRow(
  current: NotificationListResponse,
  updated: Notification,
): NotificationListResponse {
  const notifications = current.notifications.map((row) => (row.id === updated.id ? updated : row));
  return {
    ...current,
    notifications,
    // Recounted rather than decremented: two tabs marking the same row read
    // would otherwise drive the badge below what is really unread.
    unreadCount: notifications.filter((row) => row.readAtMs === undefined).length,
  };
}
