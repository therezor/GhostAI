/**
 * The two-column shell: sidebar, and everything else.
 *
 * Below `md` the left column is not narrowed, it is removed — and reached
 * through a Dialog instead. A sidebar squeezed to 4rem is a sidebar whose
 * labels are gone and whose targets are too small, which is worse on a phone
 * than a button that opens the real thing.
 *
 * The header carries the wordmark and then, in the space a hosted product would
 * spend on navigation, what the agent is doing: the resolved model, the socket's
 * state, and the theme control.
 *
 * The WebSocket hangs here, and here specifically: this is the router's root
 * component, so it is the only one that survives every navigation. A socket
 * opened by the chat route would be closed and redialled by a trip to Settings,
 * which would drop the turn the user went to Settings to reconfigure.
 */

import { useQuery } from '@tanstack/react-query';
import { useSearch } from '@tanstack/react-router';
import { Menu } from 'lucide-react';
import { useState, type JSX, type ReactNode } from 'react';

import { api } from '@/lib/api.js';
import { queryKeys } from '@/lib/query.js';
import { useTurnStore } from '@/state/turn.js';
import { useConnection } from '@/chat/use-connection.js';
import { Button } from '@/components/ui/button.js';
import { Dialog, DialogContent, DialogHeading, DialogTrigger } from '@/components/ui/dialog.js';
import { ThemeSwitcher } from '@/components/theme-switcher.js';
import { Wordmark } from '@/components/wordmark.js';
import { ContextInspector } from '@/context/context-inspector.js';
import { Sidebar } from './sidebar.js';

export function Shell({ children }: { readonly children: ReactNode }): JSX.Element {
  const [drawerOpen, setDrawerOpen] = useState(false);

  // `strict: false` because the shell is above every route and only one of them
  // has a `session` parameter — on the others the answer is legitimately
  // `undefined`, which is a request to keep the socket where it is.
  const search: { session?: string } = useSearch({ strict: false });
  useConnection(search.session);

  return (
    <div className="shell">
      <Header onOpenDrawer={setDrawerOpen} drawerOpen={drawerOpen} />

      <div className="shell__body">
        <aside aria-label="Sidebar" className="shell__sidebar">
          <Sidebar />
        </aside>

        <main className="shell__main">{children}</main>
      </div>
    </div>
  );
}

function Header({
  drawerOpen,
  onOpenDrawer,
}: {
  readonly drawerOpen: boolean;
  readonly onOpenDrawer: (open: boolean) => void;
}): JSX.Element {
  const status = useQuery({
    queryKey: queryKeys.status,
    queryFn: ({ signal }) => api.status(signal),
  });

  const connection = useTurnStore((state) => state.connection);
  // The header, not the chat route: the inspector measures the session the
  // socket is on, and that outlives a trip to Settings and back.
  const sessionKey = useTurnStore((state) => state.sessionKey);

  return (
    <header className="app-header">
      <Dialog open={drawerOpen} onOpenChange={onOpenDrawer}>
        <DialogTrigger asChild>
          <Button variant="ghost" size="icon" className="shell__menu-button" aria-label="Open menu">
            <Menu />
          </Button>
        </DialogTrigger>
        <DialogContent className="dialog--drawer">
          <DialogHeading className="sr-only">Navigation</DialogHeading>
          <Sidebar
            onNavigate={() => {
              onOpenDrawer(false);
            }}
          />
        </DialogContent>
      </Dialog>

      <Wordmark className="app-header__brand" />

      {status.isSuccess && (
        <span className="app-header__agent truncate">
          {status.data.provider} · {status.data.model}
        </span>
      )}

      <div className="spacer" />

      <ConnectionBadge connection={connection} />
      <ContextInspector sessionKey={sessionKey} />
      <ThemeSwitcher />
    </header>
  );
}

const CONNECTION_LABELS = {
  connecting: 'Connecting',
  open: 'Connected',
  reconnecting: 'Reconnecting',
  closed: 'Offline',
} as const;

/**
 * A dot and a word, not a filled pill.
 *
 * It was a `warning`-toned badge, and on a screen with one accent that made the
 * loudest element in the header a *transient* one: a socket reconnecting for
 * two seconds outranked the product's own name and everything the agent had
 * said. Status is ambient information — it needs to be readable when looked
 * for, not to compete when it is not. The dot carries the colour, which is as
 * much colour as a four-state indicator needs.
 *
 * Live-region, because it is the one piece of the header that changes without
 * anyone acting: a socket that dropped has to announce itself to a user who is
 * not looking at the top-right corner.
 */
function ConnectionBadge({
  connection,
}: {
  readonly connection: keyof typeof CONNECTION_LABELS;
}): JSX.Element {
  return (
    <span role="status" aria-live="polite" className="conn" data-connection={connection}>
      <span className="conn__dot" aria-hidden="true" />
      <span className="conn__label">{CONNECTION_LABELS[connection]}</span>
    </span>
  );
}
