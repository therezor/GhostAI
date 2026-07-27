/**
 * The two-column shell: sidebar, and everything else.
 *
 * Below `md` the left column is not narrowed, it is removed — and reached
 * through a Dialog instead. A sidebar squeezed to 4rem is a sidebar whose
 * labels are gone and whose targets are too small, which is worse on a phone
 * than a button that opens the real thing.
 *
 * The header carries what the agent is doing rather than a logo: the resolved
 * model, the socket's state, and the theme control.
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
import { Badge } from '@/components/ui/badge.js';
import { Button } from '@/components/ui/button.js';
import { Dialog, DialogContent, DialogHeading, DialogTrigger } from '@/components/ui/dialog.js';
import { ThemeToggle } from '@/components/theme-toggle.js';
import { Sidebar } from './sidebar.js';

export function Shell({ children }: { readonly children: ReactNode }): JSX.Element {
  const [drawerOpen, setDrawerOpen] = useState(false);

  // `strict: false` because the shell is above every route and only one of them
  // has a `session` parameter — on the others the answer is legitimately
  // `undefined`, which is a request to keep the socket where it is.
  const search: { session?: string } = useSearch({ strict: false });
  useConnection(search.session);

  return (
    <div className="flex h-dvh flex-col bg-surface-0 text-fg-1">
      <Header onOpenDrawer={setDrawerOpen} drawerOpen={drawerOpen} />

      <div className="flex min-h-0 flex-1">
        <aside
          aria-label="Sidebar"
          className="hidden w-64 shrink-0 overflow-y-auto border-r border-line bg-surface-1 md:block"
        >
          <Sidebar />
        </aside>

        {/* `min-w-0`, or a long unbroken token in a code block makes the whole
            column scroll sideways instead of the block itself. */}
        <main className="min-w-0 flex-1 overflow-y-auto">{children}</main>
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

  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line bg-surface-1 px-3">
      <Dialog open={drawerOpen} onOpenChange={onOpenDrawer}>
        <DialogTrigger asChild>
          <Button variant="ghost" size="icon" className="md:hidden" aria-label="Open menu">
            <Menu />
          </Button>
        </DialogTrigger>
        <DialogContent className="top-0 left-0 h-dvh w-72 max-w-[85vw] translate-none rounded-none rounded-r-xl">
          <DialogHeading className="sr-only">Navigation</DialogHeading>
          <Sidebar
            onNavigate={() => {
              onOpenDrawer(false);
            }}
          />
        </DialogContent>
      </Dialog>

      <span className="font-medium">GhostAI</span>

      {status.isSuccess && (
        <span className="hidden truncate text-xs text-fg-3 sm:inline">
          {status.data.provider} · {status.data.model}
        </span>
      )}

      <div className="flex-1" />

      <ConnectionBadge connection={connection} />
      <ThemeToggle />
    </header>
  );
}

const CONNECTION_LABELS = {
  connecting: { label: 'Connecting', tone: 'warning' },
  open: { label: 'Connected', tone: 'success' },
  reconnecting: { label: 'Reconnecting', tone: 'warning' },
  closed: { label: 'Offline', tone: 'neutral' },
} as const;

/**
 * Live-region, because it is the one piece of the header that changes without
 * anyone acting: a socket that dropped has to announce itself to a user who is
 * not looking at the top-right corner.
 */
function ConnectionBadge({
  connection,
}: {
  readonly connection: keyof typeof CONNECTION_LABELS;
}): JSX.Element {
  const { label, tone } = CONNECTION_LABELS[connection];

  return (
    <span role="status" aria-live="polite">
      <Badge tone={tone}>{label}</Badge>
    </span>
  );
}
