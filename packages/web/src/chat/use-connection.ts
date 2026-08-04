/**
 * The socket's lifecycle, hung off the shell.
 *
 * The shell is the router's root component, so it never remounts — which is the
 * whole reason the socket lives there rather than in the chat route. Navigating
 * to Settings and back must not drop a turn in flight, and a socket opened by
 * the route would do exactly that.
 *
 * What this adds on top of `connection.ts` is the part that needs React: the
 * Query cache. Three server events invalidate fetched state, and none of them
 * can be discovered by polling — a turn ending changes the session list's
 * message counts, a notification changes the sidebar badge, and `tools.changed`
 * means an MCP server or a plugin moved under the settings panel's feet.
 */

import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';

import { queryKeys } from '@/lib/query.js';
import { useTurnStore } from '@/state/turn.js';
import {
  closeConnection,
  onServerMessage,
  openConnection,
  switchSession,
} from '@/lib/connection.js';
import { toast } from '@/components/ui/toast.js';
import { useWorkspace } from '@/workspaces/workspace-context.js';

export function useConnection(sessionKey: string | undefined): void {
  const queryClient = useQueryClient();
  const { adopt } = useWorkspace();

  // The server is the authority on which workspace a session is in, and it says
  // so on `connected` and on every `session.status`. Following it is what keeps
  // the switcher from claiming one workspace while the conversation on screen
  // runs in another — which is exactly what opening a link to someone else's
  // session would otherwise do.
  const reported = useTurnStore((state) => state.workspaceId);
  useEffect(() => {
    if (reported !== undefined) adopt(reported);
  }, [reported, adopt]);

  // The session the first render asked for, held in a ref so the effect below
  // can use it without listing it as a dependency — a change to `sessionKey` is
  // a `session.switch` on the socket that is already open, not a reason to
  // close one and dial another.
  const initial = useRef(sessionKey);

  // Once, for the life of the shell.
  useEffect(() => {
    openConnection(initial.current);
    return closeConnection;
  }, []);

  useEffect(() => {
    if (sessionKey !== undefined) switchSession(sessionKey);
  }, [sessionKey]);

  useEffect(
    () =>
      onServerMessage((message) => {
        switch (message.type) {
          case 'turn.end':
            // Unscoped: `['sessions']` is the prefix every workspace-scoped key
            // starts with, so one invalidation refreshes whichever is showing.
            void queryClient.invalidateQueries({
              queryKey: queryKeys.sessions(),
            });
            return;

          case 'notification':
            void queryClient.invalidateQueries({
              queryKey: queryKeys.notifications,
            });
            // The badge is the record; the toast is for the one that arrives
            // while the user is looking at something else.
            toast({
              title: message.title,
              description: message.body,
              role: message.level === 'error' ? 'danger' : message.level,
            });
            return;

          case 'session.truncated':
            // The one invalidation that is not a nicety: `mergeStoredHistory`
            // puts a fetched history *underneath* the live transcript, so a
            // cached response holding the deleted rows would resurrect them.
            void queryClient.invalidateQueries({
              queryKey: queryKeys.messages(message.sessionKey),
            });
            void queryClient.invalidateQueries({
              queryKey: queryKeys.sessions(),
            });
            return;

          case 'tools.changed':
            void queryClient.invalidateQueries({ queryKey: queryKeys.tools });
            // The same frame is what a server connecting or dropping produces,
            // so the Extensions row settles by itself rather than by polling.
            void queryClient.invalidateQueries({ queryKey: queryKeys.mcp });
            return;

          default:
            return;
        }
      }),
    [queryClient],
  );
}
