/**
 * Everything mounted once, above the router.
 *
 * The order is not arbitrary: the login overlay is inside `QueryClientProvider`
 * because it *is* a query — `/api/auth/me` — and outside the router because it
 * covers whatever route is behind it rather than replacing it.
 */

import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import type { JSX, ReactNode } from 'react';
import { useState } from 'react';

import { createQueryClient } from '@/lib/query.js';
import { LoginOverlay } from '@/components/login-overlay.js';
import { Toaster } from '@/components/ui/toast.js';
import { TooltipProvider } from '@/components/ui/tooltip.js';
import { ThemeProvider } from '@/theme/theme-context.js';

export function Providers({
  children,
  client,
}: {
  readonly children: ReactNode;
  /** Supplied by tests; the app builds its own. */
  readonly client?: QueryClient;
}): JSX.Element {
  // `useState` rather than a module constant: a client created at import time
  // is shared by every test in a file, so one test's cache answers another's
  // request.
  const [queryClient] = useState(() => client ?? createQueryClient());

  return (
    <QueryClientProvider client={queryClient}>
      {/* One copy of the theme state for the whole tree. Two would mean the
          toggle repaints and the code blocks do not. */}
      <ThemeProvider>
        {/* One provider, one shared delay timer — so a row of icon buttons
            behaves like a control strip rather than eight separate waits. */}
        <TooltipProvider delayDuration={400} skipDelayDuration={300}>
          {children}
          <LoginOverlay />
          <Toaster />
        </TooltipProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
