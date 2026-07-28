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
    <div className="stack sidebar">
      <nav aria-label="Sections" className="stack sidebar__nav">
        {NAV.map(({ to, label, icon: Icon }) => (
          <Link
            key={to}
            to={to}
            onClick={onNavigate}
            // `aria-current` is the accessible half of the same statement the
            // surface change makes visually.
            className={cn('sidebar__link', isActive(pathname, to) && 'sidebar__link--active')}
            {...(isActive(pathname, to) ? { 'aria-current': 'page' as const } : {})}
          >
            <Icon />
            <span className="sidebar__link-label truncate">{label}</span>
            {to === '/notifications' && unreadCount > 0 && (
              <Badge tone="accent">{unreadCount}</Badge>
            )}
          </Link>
        ))}
      </nav>

      <Section title="Sessions">
        <ScrollArea className="sidebar__sessions">
          <ul className="stack sidebar__session-list">
            {(sessions.data?.sessions ?? []).map((session) => (
              <li key={session.key}>
                <Link
                  to="/"
                  search={{ session: session.key }}
                  onClick={onNavigate}
                  className="sidebar__session"
                >
                  <span className="truncate">{session.title || session.key}</span>
                  <span className="sidebar__session-count">
                    {session.messageCount} message{session.messageCount === 1 ? '' : 's'}
                  </span>
                </Link>
              </li>
            ))}

            {sessions.isSuccess && sessions.data.sessions.length === 0 && (
              <li className="sidebar__note">No conversations yet.</li>
            )}
            {sessions.isError && (
              <li className="sidebar__note sidebar__note--error">Could not load sessions.</li>
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
    <section className="stack sidebar__section">
      <h2 className="sidebar__section-title">{title}</h2>
      {children}
    </section>
  );
}
