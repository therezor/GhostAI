/**
 * The sidebar: starting a conversation, picking one, and the rest of the app.
 *
 * It is one component used in two places — inline as the left column on a wide
 * screen, and inside a Dialog as a drawer on a narrow one. Rendering it twice
 * is what would go wrong: two copies of a list drift, and the drawer is the one
 * nobody opens while developing.
 *
 * **New session replaced a "Chat" nav link, and the link was not merely
 * redundant.** `<Link to="/">` drops `?session=`, but the chat route renders
 * from the turn store rather than from the URL and the socket only switches on
 * a defined key — so clicking it cleared neither the transcript nor the
 * attachment, and the first message put the old key straight back in the URL.
 * It stripped a query parameter and restored it.
 *
 * Starting one writes nothing. `newSession` mints a key, tells the hub to
 * attach to it, and leaves storage alone — the row is created by the agent loop
 * when the first message arrives. Creating it on the press would fill this list
 * with empty conversations belonging to people who changed their mind.
 */

import { Link, useNavigate, useRouterState } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FolderOpen, MoreHorizontal, Palette, Pencil, Plus, Settings, Trash2 } from 'lucide-react';
import { useState, type JSX, type ReactNode } from 'react';

import { cn } from '@/lib/cn.js';
import { api } from '@/lib/api.js';
import { newSession } from '@/lib/connection.js';
import { queryKeys } from '@/lib/query.js';
import { Button } from '@/components/ui/button.js';
import { Input, Label } from '@/components/ui/field.js';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu.js';
import { ScrollArea } from '@/components/ui/scroll-area.js';
import { toast } from '@/components/ui/toast.js';
import { useTurnStore } from '@/state/turn.js';
import { WorkspaceSwitcher } from '@/workspaces/workspace-switcher.js';
import { useWorkspace } from '@/workspaces/workspace-context.js';

interface NavItem {
  readonly to: string;
  readonly label: string;
  readonly icon: typeof FolderOpen;
}

const NAV: readonly NavItem[] = [
  { to: '/files', label: 'Files', icon: FolderOpen },
  { to: '/settings', label: 'Settings', icon: Settings },
  { to: '/tokens', label: 'Tokens', icon: Palette },
];

/**
 * What an untitled conversation is called.
 *
 * Never the raw key. A title is derived from the first message by the agent
 * loop, so the only rows without one are conversations nobody has spoken in —
 * and a uuid is not a name for those, it is an admission that nothing named
 * them.
 */
const UNTITLED = 'New conversation';

export function Sidebar({ onNavigate }: { readonly onNavigate?: () => void }): JSX.Element {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const { workspaceId } = useWorkspace();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  // The session the socket is actually on, not the one the URL names. The two
  // differ for one render after starting a conversation — the route navigates
  // *after* sending — and the row should highlight on the click.
  const attached = useTurnStore((state) => state.sessionKey);

  const [renaming, setRenaming] = useState<string | undefined>(undefined);

  function startChat(): void {
    // Nothing is written yet: the row appears in the list below when the first
    // message lands, so pressing this and changing your mind leaves no trace.
    // See `newSession` for why the key is minted client-side.
    const key = newSession(workspaceId);
    onNavigate?.();
    void navigate({ to: '/', search: { session: key } });
  }

  // Scoped to the workspace: a session list mixing three workspaces' worth of
  // conversations, with no way to tell which is which, is a list nobody can
  // navigate. The switcher sits directly above it for the same reason.
  const sessions = useQuery({
    queryKey: queryKeys.sessions(workspaceId),
    queryFn: ({ signal }) => api.sessions(workspaceId, signal),
  });

  const rows = sessions.data?.sessions ?? [];

  /**
   * Whether the conversation on screen is one that has not been saved yet.
   *
   * A session exists on the socket the moment it is started and in this list
   * only once something has been said in it, so there is a window where the
   * chat route is showing a real conversation that no row represents. That
   * window is what the New session row marks — otherwise nothing in the column
   * is highlighted and the sidebar claims you are nowhere.
   *
   * Guarded on `isSuccess`, or the row lights up for one render on every load
   * while the list is still in flight.
   */
  const inNewSession =
    pathname === '/' &&
    sessions.isSuccess &&
    (attached === undefined || !rows.some((session) => session.key === attached));

  function refreshSessions(): void {
    void queryClient.invalidateQueries({ queryKey: queryKeys.sessions() });
  }

  const rename = useMutation({
    mutationFn: ({ key, title }: { key: string; title: string }) => api.renameSession(key, title),
    onSuccess: () => {
      setRenaming(undefined);
      refreshSessions();
    },
    onError: () => {
      toast.error('Could not rename the conversation');
    },
  });

  const remove = useMutation({
    mutationFn: (key: string) => api.deleteSession(key),
    onSuccess: (_result, key) => {
      refreshSessions();
      // Only when the deleted conversation is the one on screen. Navigating
      // away from a different session would move someone who was reading it.
      if (key === attached) void navigate({ to: '/', search: {} });
    },
    onError: () => {
      toast.error('Could not delete the conversation');
    },
  });

  return (
    <div className="stack sidebar">
      <div className="sidebar__scope">
        {/* Labelled the same way the session list is, by the same component: it
            is a named group in this column, and the label is what makes the
            control below it self-describing rather than an icon and a word. */}
        <Section title="Workspace">
          <WorkspaceSwitcher
            rowClassName="sidebar__link"
            {...(onNavigate === undefined ? {} : { onNavigate })}
          />
        </Section>
      </div>

      <nav aria-label="Sections" className="stack sidebar__nav">
        {/* A row in this list rather than a button above it. It goes to the
            same place the rows below it go — a screen — and giving it a
            different shape said it was a different *kind* of thing, which it
            is not. A `<button>` because there is no address to link to until
            it has been pressed. */}
        <button
          type="button"
          className={cn('sidebar__link', inNewSession && 'sidebar__link--active')}
          {...(inNewSession ? { 'aria-current': 'page' as const } : {})}
          onClick={startChat}
        >
          <Plus />
          <span className="sidebar__link-label truncate">New session</span>
        </button>

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
          </Link>
        ))}
      </nav>

      <Section title="Sessions">
        <ScrollArea className="sidebar__sessions">
          <ul className="stack sidebar__session-list">
            {rows.map((session) => {
              const title = session.title === '' ? UNTITLED : session.title;
              const current = session.key === attached;

              if (renaming === session.key) {
                return (
                  <li key={session.key}>
                    <form
                      className="sidebar__rename"
                      onSubmit={(event) => {
                        event.preventDefault();
                        const value = new FormData(event.currentTarget).get('title');
                        if (typeof value === 'string' && value.trim() !== '') {
                          rename.mutate({ key: session.key, title: value.trim() });
                        }
                      }}
                    >
                      <Label htmlFor={`rename-${session.key}`} className="sr-only">
                        New name for {title}
                      </Label>
                      <Input
                        id={`rename-${session.key}`}
                        name="title"
                        defaultValue={session.title}
                        autoFocus
                        onKeyDown={(event) => {
                          if (event.key === 'Escape') setRenaming(undefined);
                        }}
                      />
                      <Button type="submit" size="sm" disabled={rename.isPending}>
                        Save
                      </Button>
                    </form>
                  </li>
                );
              }

              return (
                <li key={session.key} className="sidebar__session-row">
                  <Link
                    to="/"
                    search={{ session: session.key }}
                    onClick={onNavigate}
                    className={cn('sidebar__session', current && 'sidebar__session--active')}
                    {...(current ? { 'aria-current': 'page' as const } : {})}
                  >
                    <span className="truncate">{title}</span>
                  </Link>

                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="sidebar__session-actions"
                        aria-label={`Actions for ${title}`}
                      >
                        <MoreHorizontal />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="floating--menu">
                      <DropdownMenuItem
                        onSelect={() => {
                          setRenaming(session.key);
                        }}
                      >
                        <Pencil />
                        Rename
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onSelect={() => {
                          remove.mutate(session.key);
                        }}
                      >
                        <Trash2 />
                        Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </li>
              );
            })}

            {sessions.isSuccess && rows.length === 0 && (
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
