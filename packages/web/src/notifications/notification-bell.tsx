/**
 * The bell in the header, and the recent notifications behind it.
 *
 * It replaced the context inspector's trigger, which was the wrong thing in the
 * right place: what a turn is about to send belongs beside the composer that
 * will send it, and what the server said while nobody was looking belongs in
 * the corner the eye checks. The full list stays at `/notifications` — this is
 * a glance, and "See all" is the archive.
 *
 * **A dot, not a badge.** A count inside an icon-sized button is either
 * unreadable or bursts the control, and a bare "3" beside a bell tells a screen
 * reader nothing about what three means. The number goes in the accessible name
 * instead, where it is a sentence, and the dot does the visual job — which is
 * only ever "there is something here".
 *
 * Nothing subscribes: `use-connection.ts` already invalidates
 * `queryKeys.notifications` on every `notification` frame, so the dot is live
 * without a line of code here.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Bell } from 'lucide-react';
import { useState, type JSX } from 'react';

import type { Notification } from '@ghostai/protocol';

import { cn } from '@/lib/cn.js';
import { api } from '@/lib/api.js';
import { formatRelativeTime } from '@/lib/format.js';
import { queryKeys } from '@/lib/query.js';
import { Button } from '@/components/ui/button.js';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover.js';
import { toast } from '@/components/ui/toast.js';
import { LEVEL_CLASSES, LEVEL_ICONS } from '@/notifications/levels.js';

/**
 * How many rows the glance holds.
 *
 * Six is about a screen's worth beside a header without the popover becoming a
 * second page. Anything past it is what "See all" is for.
 */
const PREVIEW_ROWS = 6;

export function NotificationBell(): JSX.Element {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();

  const notifications = useQuery({
    queryKey: queryKeys.notifications,
    queryFn: ({ signal }) => api.notifications(signal),
  });

  const unreadCount = notifications.data?.unreadCount ?? 0;
  const rows = (notifications.data?.notifications ?? []).slice(0, PREVIEW_ROWS);
  // One instant for the whole list: two rows measured against two `Date.now()`
  // calls can disagree about which is older.
  const now = Date.now();

  const markAll = useMutation({
    mutationFn: () => api.readAllNotifications(),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.notifications });
    },
    onError: (error: Error) => {
      toast.error('Could not mark them read', error.message);
    },
  });

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="notification-bell"
          aria-label={
            unreadCount === 0 ? 'Notifications' : `Notifications, ${String(unreadCount)} unread`
          }
        >
          <Bell />
          {unreadCount > 0 && <span className="notification-bell__dot" aria-hidden="true" />}
        </Button>
      </PopoverTrigger>

      <PopoverContent align="end" className="stack popover--notifications">
        <div className="row notification-bell__header">
          <h2 className="notification-bell__title">Notifications</h2>
          <span className="spacer" />
          {unreadCount > 0 && (
            <Button
              variant="ghost"
              size="sm"
              disabled={markAll.isPending}
              onClick={() => {
                markAll.mutate();
              }}
            >
              Mark all read
            </Button>
          )}
        </div>

        <ul className="stack notification-bell__list">
          {rows.map((notification) => (
            <li key={notification.id}>
              <NotificationRow
                notification={notification}
                now={now}
                onOpen={() => {
                  setOpen(false);
                }}
              />
            </li>
          ))}

          {notifications.isSuccess && rows.length === 0 && (
            <li className="notification-bell__empty">Nothing here yet.</li>
          )}
          {notifications.isError && (
            <li className="notification-bell__empty">Could not load notifications.</li>
          )}
        </ul>

        <Link
          to="/notifications"
          className="notification-bell__footer"
          onClick={() => {
            setOpen(false);
          }}
        >
          See all
        </Link>
      </PopoverContent>
    </Popover>
  );
}

function NotificationRow({
  notification,
  now,
  onOpen,
}: {
  readonly notification: Notification;
  readonly now: number;
  readonly onOpen: () => void;
}): JSX.Element {
  const Icon = LEVEL_ICONS[notification.level];

  const body = (
    <>
      <Icon className={cn('notification__icon', LEVEL_CLASSES[notification.level])} />
      <span className="notification-mini__text">
        <span className="notification-mini__title truncate">{notification.title}</span>
        <span className="notification-mini__time">
          {formatRelativeTime(notification.createdAtMs, now)}
        </span>
      </span>
    </>
  );

  // A notification that names a conversation is a link into it — that is the
  // whole point of the field. One that names none is not a link pretending to
  // be one.
  if (notification.sessionKey === undefined) {
    return <span className="notification-mini">{body}</span>;
  }

  return (
    <Link
      to="/"
      search={{ session: notification.sessionKey }}
      className="notification-mini notification-mini--link"
      onClick={onOpen}
    >
      {body}
    </Link>
  );
}
