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
  info: 'text-info-fg',
  success: 'text-success-fg',
  warning: 'text-warning-fg',
  error: 'text-danger-fg',
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
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4 sm:p-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-medium">Notifications</h1>
        <span className="text-sm text-fg-3">
          {unreadCount === 0 ? 'All caught up' : `${String(unreadCount)} unread`}
        </span>
        <span className="flex-1" />
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

      {notifications.isPending && <p className="text-sm text-fg-3">Loading…</p>}
      {notifications.isError && (
        <p role="alert" className="text-sm text-danger-fg">
          Could not load notifications: {notifications.error.message}
        </p>
      )}

      {notifications.isSuccess &&
        (rows.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-lg border border-line bg-surface-1 p-8 text-center">
            <Bell className="size-5 text-fg-3" />
            <p className="text-sm text-fg-2">Nothing here yet.</p>
            <p className="text-xs text-fg-3">
              Automation runs and expired approvals report themselves here.
            </p>
          </div>
        ) : (
          <ul className="flex flex-col gap-2">
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
      className={cn(
        'flex items-start gap-3 rounded-lg border p-3',
        // Unread is raised and read is *transparent* — not a lower surface.
        // Two filled surfaces invert their emphasis between the themes: in
        // light, the greyer card is the one that stands out from a white page,
        // so the read row would draw the eye. A row with no fill recedes into
        // the background in both.
        unread ? 'border-line-strong bg-surface-2' : 'border-line bg-transparent',
      )}
    >
      <Icon className={cn('mt-0.5 size-4 shrink-0', LEVEL_CLASSES[notification.level])} />

      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-baseline gap-2">
          <span className={cn('text-sm', unread ? 'font-medium text-fg-1' : 'text-fg-2')}>
            {notification.title}
          </span>
          <time
            dateTime={new Date(notification.createdAtMs).toISOString()}
            className="text-2xs text-fg-3"
          >
            {formatRelativeTime(notification.createdAtMs, now)}
          </time>
        </div>

        {notification.body !== '' && (
          <p className="text-xs break-words text-fg-2">{notification.body}</p>
        )}

        <div className="flex flex-wrap items-center gap-2">
          {notification.sessionKey !== undefined && (
            <Link
              to="/"
              search={{ session: notification.sessionKey }}
              className="text-xs text-accent-fg underline underline-offset-2"
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
