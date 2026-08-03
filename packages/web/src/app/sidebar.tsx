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
import { useQuery } from '@tanstack/react-query';
import {
  BrainCircuit,
  CalendarClock,
  FolderOpen,
  MessagesSquare,
  MoreHorizontal,
  Pencil,
  Plus,
  Settings,
  Trash2,
} from 'lucide-react';
import { useState, type JSX, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { SessionSummary } from '@ghostai/protocol';
import type { WebKey } from '@/i18n/keys.js';

import { cn } from '@/lib/cn.js';
import { api } from '@/lib/api.js';
import { newSession } from '@/lib/connection.js';
import { queryKeys } from '@/lib/query.js';
import { ConfirmDialog } from '@/components/crud/confirm-dialog.js';
import { Button } from '@/components/ui/button.js';
import { Input, Label } from '@/components/ui/field.js';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu.js';
import { ScrollArea } from '@/components/ui/scroll-area.js';
import { useTurnStore } from '@/state/turn.js';
import { WorkspaceSwitcher } from '@/workspaces/workspace-switcher.js';
import { useAgent } from '@/agents/agent-context.js';
import { useWorkspace } from '@/workspaces/workspace-context.js';
import { useDeleteSession, useRenameSession } from '@/sessions/use-sessions.js';

interface NavItem {
  readonly to: string;
  readonly label: WebKey;
  readonly icon: typeof FolderOpen;
}

/**
 * Two things this list deliberately does not carry.
 *
 * **No `/workspaces` row.** The switcher sits directly above it and carries
 * "Manage workspaces…" as its last item, which is the same destination one
 * control higher and in the place someone is already thinking about workspaces.
 * A nav row beside it was a second door into one room — and it named the *only*
 * thing in the column that the control above it already scopes.
 *
 * That argument was once made about `/sessions` too, and it was wrong for a
 * reason worth keeping: the list below is a *shortlist* of thirty, not the
 * room. The switcher genuinely holds every workspace, so a row beside it
 * duplicated it; the session list holds the newest fraction, so a row pointing
 * at the whole set is a different destination rather than a second door.
 *
 * **No `/tokens` row.** The style guide is a developer surface: its copy names
 * tokens and CSS values rather than addressing a user, which is why it is the
 * one file `untranslated.test.ts` exempts. The route stays — it is how the
 * design system is read, and `routes/tokens.test.tsx` holds it to resolving
 * every `var()` it renders — but a permanent row in an operator's sidebar
 * advertised it as a feature of the product.
 */
const NAV: readonly NavItem[] = [
  // First, and directly under New session: the two things you do with a session
  // are start one and find one, and they belong next to each other.
  //
  // This row *is* the way to the full list. It replaced a "All sessions" link in
  // the footer under the list below, which was the correct shape on paper — "and
  // the others" belongs after the thing it is the rest of — and the wrong one in
  // practice. That footer sat beneath a scroll area holding thirty rows, so on
  // any window short enough to scroll it was below the fold, and a door nobody
  // can see is not a door. A fixed row costs one line and is always in the same
  // place. See `sessions.heading` below, which now labels a shortlist rather
  // than introducing the only way in.
  { to: '/sessions', label: 'nav.sessions', icon: MessagesSquare },
  { to: '/agents', label: 'nav.agents', icon: BrainCircuit },
  { to: '/files', label: 'nav.files', icon: FolderOpen },
  // Before Settings, and a row of its own rather than a settings panel: the
  // jobs are a list an operator keeps, which is the same kind of thing as
  // Agents. The scheduler's own switches live on that page for the reason
  // `panels.test.ts` gives for agents — the settings a panel would hold *are*
  // the page's subject, and a nav row plus a panel is two doors into one room.
  { to: '/automation', label: 'nav.automation', icon: CalendarClock },
  { to: '/settings', label: 'nav.settings', icon: Settings },
];

/**
 * What an untitled conversation is called.
 *
 * Never the raw key. A title is derived from the first message by the agent
 * loop, so the only rows without one are conversations nobody has spoken in —
 * and a uuid is not a name for those, it is an admission that nothing named
 * them.
 */
const UNTITLED = 'sessions.untitled';

/**
 * How many conversations the column carries.
 *
 * It used to be whatever the server's default page was — fifty — which was not a
 * decision so much as the absence of one, and it read as the whole list while
 * being the newest fraction of it. Thirty is a number this column can *mean*:
 * enough that the conversation you were in yesterday is still here, few enough
 * that the See all link below is visibly the way to the rest rather than a
 * footnote. Everything past it lives on `/sessions`, which searches and pages.
 */
const SIDEBAR_SESSIONS = 30;

export function Sidebar({ onNavigate }: { readonly onNavigate?: () => void }): JSX.Element {
  const { t } = useTranslation();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const { workspaceId } = useWorkspace();
  const { agentId } = useAgent();
  const navigate = useNavigate();

  // The session the socket is actually on, not the one the URL names. The two
  // differ for one render after starting a conversation — the route navigates
  // *after* sending — and the row should highlight on the click.
  const attached = useTurnStore((state) => state.sessionKey);

  const [renaming, setRenaming] = useState<string | undefined>(undefined);
  const [pendingDelete, setPendingDelete] = useState<SessionSummary | undefined>(undefined);

  function startChat(): void {
    // Nothing is written yet: the row appears in the list below when the first
    // message lands, so pressing this and changing your mind leaves no trace.
    // See `newSession` for why the key is minted client-side.
    // The agent goes with it: a session is bound when it is created, and after
    // that the binding is the stored row's rather than the switcher's.
    const key = newSession(workspaceId, agentId);
    onNavigate?.();
    void navigate({ to: '/', search: { session: key } });
  }

  // Scoped to the workspace: a session list mixing three workspaces' worth of
  // conversations, with no way to tell which is which, is a list nobody can
  // navigate. The switcher sits directly above it for the same reason.
  const sessions = useQuery({
    queryKey: queryKeys.sessions(workspaceId),
    queryFn: ({ signal }) => api.sessions({ workspaceId, limit: SIDEBAR_SESSIONS, signal }),
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

  // Shared with the conversations page rather than written out here. Two
  // implementations of "rename a session" is two sets of toasts and two answers
  // to which queries a rename invalidates, and the second one is always the one
  // that gets it wrong.
  const rename = useRenameSession();
  const remove = useDeleteSession();

  return (
    <div className="stack sidebar">
      <div className="sidebar__scope">
        {/* Labelled the same way the session list is, by the same component: it
            is a named group in this column, and the label is what makes the
            control below it self-describing rather than an icon and a word. */}
        <Section title={t('sessions.workspaceHeading')}>
          <WorkspaceSwitcher
            rowClassName="sidebar__link"
            {...(onNavigate === undefined ? {} : { onNavigate })}
          />
        </Section>
      </div>

      <nav aria-label={t('shell.sections')} className="stack sidebar__nav">
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
          <span className="sidebar__link-label truncate">{t('sessions.newSession')}</span>
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
            <span className="sidebar__link-label truncate">{t(label)}</span>
          </Link>
        ))}
      </nav>

      <Section title={t('sessions.heading')}>
        <ScrollArea className="sidebar__sessions">
          <ul className="stack sidebar__session-list">
            {rows.map((session) => {
              const title = session.title === '' ? t(UNTITLED) : session.title;
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
                          // Closed on success rather than on submit: a rename
                          // that failed should leave the box open with what was
                          // typed in it.
                          rename.mutate(
                            { key: session.key, title: value.trim() },
                            {
                              onSuccess: () => {
                                setRenaming(undefined);
                              },
                            },
                          );
                        }
                      }}
                    >
                      <Label htmlFor={`rename-${session.key}`} className="sr-only">
                        {t('sessions.renameLabel', { title })}
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
                      <Button type="submit" size="sm" disabled={rename.pending}>
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
                        aria-label={t('sessions.actionsFor', { title })}
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
                        {t('sessions.rename')}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        className="menu__item--danger"
                        onSelect={() => {
                          setPendingDelete(session);
                        }}
                      >
                        <Trash2 />
                        {t('sessions.delete')}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </li>
              );
            })}

            {sessions.isSuccess && rows.length === 0 && (
              <li className="sidebar__note">{t('sessions.none')}</li>
            )}
            {sessions.isError && (
              <li className="sidebar__note sidebar__note--error">{t('sessions.loadFailed')}</li>
            )}
          </ul>
        </ScrollArea>
      </Section>

      <ConfirmDialog
        open={pendingDelete !== undefined}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(undefined);
        }}
        title={t('sessions.deleteTitle')}
        description={t('sessions.deleteHint', { title: titleOf(pendingDelete, t) })}
        confirmLabel={t('sessions.delete')}
        pending={remove.pending}
        onConfirm={() => {
          if (pendingDelete === undefined) return;
          const { key } = pendingDelete;
          remove.mutate(key, {
            onSuccess: () => {
              setPendingDelete(undefined);
              // Only when the deleted conversation is the one on screen.
              // Navigating away from a different session would move someone who
              // was reading it.
              if (key === attached) void navigate({ to: '/', search: {} });
            },
          });
        }}
      />
    </div>
  );
}

/** A conversation nobody has spoken in has no title of its own. See `UNTITLED`. */
function titleOf(session: SessionSummary | undefined, t: (key: WebKey) => string): string {
  if (session === undefined) return '';
  return session.title === '' ? t(UNTITLED) : session.title;
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
