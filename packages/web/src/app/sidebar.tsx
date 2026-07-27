/**
 * The sidebar: navigation, the session list, and who you are talking to.
 *
 * It is one component used in two places — inline as the left column on a wide
 * screen, and inside a Dialog as a drawer on a narrow one. Rendering it twice
 * is what would go wrong: two copies of a list drift, and the drawer is the one
 * nobody opens while developing.
 */

import { Link, useRouterState } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Bell, FolderOpen, MessageSquare, Palette, Settings } from 'lucide-react';
import type { JSX, ReactNode } from 'react';

import { cn } from '@/lib/cn.js';
import { api } from '@/lib/api.js';
import { queryKeys } from '@/lib/query.js';
import { Badge } from '@/components/ui/badge.js';
import { ScrollArea } from '@/components/ui/scroll-area.js';

interface NavItem {
  readonly to: string;
  readonly label: string;
  readonly icon: typeof MessageSquare;
}

const NAV: readonly NavItem[] = [
  { to: '/', label: 'Chat', icon: MessageSquare },
  { to: '/files', label: 'Files', icon: FolderOpen },
  { to: '/notifications', label: 'Notifications', icon: Bell },
  { to: '/settings', label: 'Settings', icon: Settings },
  { to: '/tokens', label: 'Tokens', icon: Palette },
];

export function Sidebar({ onNavigate }: { readonly onNavigate?: () => void }): JSX.Element {
  const pathname = useRouterState({ select: (state) => state.location.pathname });

  const sessions = useQuery({
    queryKey: queryKeys.sessions,
    queryFn: ({ signal }) => api.sessions(signal),
  });

  const unread = useQuery({
    queryKey: queryKeys.notifications,
    queryFn: ({ signal }) => api.notifications(signal),
  });

  const unreadCount = unread.data?.unreadCount ?? 0;

  return (
    <div className="flex h-full flex-col gap-4 p-3">
      <nav aria-label="Sections" className="flex flex-col gap-0.5">
        {NAV.map(({ to, label, icon: Icon }) => (
          <Link
            key={to}
            to={to}
            onClick={onNavigate}
            className={cn(
              'flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm',
              // `aria-current` is the accessible half of the same statement the
              // surface change makes visually.
              isActive(pathname, to)
                ? 'bg-surface-3 text-fg-1'
                : 'text-fg-2 hover:bg-hover hover:text-fg-1',
            )}
            {...(isActive(pathname, to) ? { 'aria-current': 'page' as const } : {})}
          >
            <Icon className="size-4 shrink-0" />
            <span className="flex-1 truncate">{label}</span>
            {to === '/notifications' && unreadCount > 0 && (
              <Badge tone="accent">{unreadCount}</Badge>
            )}
          </Link>
        ))}
      </nav>

      <Section title="Sessions">
        <ScrollArea className="max-h-64">
          <ul className="flex flex-col gap-0.5 pr-1">
            {(sessions.data?.sessions ?? []).map((session) => (
              <li key={session.key}>
                <Link
                  to="/"
                  search={{ session: session.key }}
                  onClick={onNavigate}
                  className="flex flex-col rounded-md px-2.5 py-1.5 text-sm text-fg-2 hover:bg-hover hover:text-fg-1"
                >
                  <span className="truncate">{session.title || session.key}</span>
                  <span className="text-2xs text-fg-3">
                    {session.messageCount} message{session.messageCount === 1 ? '' : 's'}
                  </span>
                </Link>
              </li>
            ))}

            {sessions.isSuccess && sessions.data.sessions.length === 0 && (
              <li className="px-2.5 py-1.5 text-xs text-fg-3">No conversations yet.</li>
            )}
            {sessions.isError && (
              <li className="px-2.5 py-1.5 text-xs text-danger-fg">Could not load sessions.</li>
            )}
          </ul>
        </ScrollArea>
      </Section>
    </div>
  );
}

/** `/` is only active when it is the whole path; everything else matches its prefix. */
function isActive(pathname: string, to: string): boolean {
  return to === '/' ? pathname === '/' : pathname.startsWith(to);
}

function Section({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <section className="flex min-h-0 flex-col gap-1">
      <h2 className="px-2.5 text-2xs font-medium tracking-wide text-fg-3 uppercase">{title}</h2>
      {children}
    </section>
  );
}
