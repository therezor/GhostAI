/**
 * The chat view.
 *
 * The route assembles three things and owns one decision. The three: the
 * transcript, the composer, and the history fetch. The decision is where a
 * conversation's past comes from, which is subtler than it looks because there
 * are two sources and neither can wait for the other.
 *
 *  - **Storage** holds every completed message, and is fetched over REST for
 *    whatever session the URL names.
 *  - **The replay ring** holds the events of a turn that has *not* completed,
 *    which storage by definition cannot — and is therefore the only thing that
 *    can put a half-written answer back on screen after a reload.
 *
 * They arrive in either order, so the fetch is merged in rather than assigned:
 * `mergeHistory` puts the stored conversation underneath whatever the socket
 * has already built, keyed on id. Replacing would discard the turn the user is
 * watching; appending would render the conversation twice.
 *
 * The socket itself is not here. It hangs off the shell, which is the router's
 * root and therefore the only component that survives navigating to Settings
 * and back — see `chat/use-connection.ts`.
 */

import { useQuery } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useEffect, useState, type JSX } from 'react';

import { api } from '@/lib/api.js';
import { approveTool, sendUserMessage, stopTurn } from '@/lib/connection.js';
import { queryKeys } from '@/lib/query.js';
import { useTurnStore } from '@/state/turn.js';
import { Composer } from '@/chat/composer.js';
import { TranscriptView } from '@/chat/transcript-view.js';
import { Welcome } from '@/chat/welcome.js';

export function ChatRoute(): JSX.Element {
  const { session } = useSearch({ from: '/' });
  const navigate = useNavigate();

  const transcript = useTurnStore((state) => state.transcript);
  const busy = useTurnStore((state) => state.busy);
  const queueDepth = useTurnStore((state) => state.queueDepth);
  const connection = useTurnStore((state) => state.connection);
  const sessionKey = useTurnStore((state) => state.sessionKey);

  // A prompt picked on the welcome screen, handed to the composer to be edited
  // rather than sent — the user chose a starting point, not a message.
  const [draft, setDraft] = useState<string | undefined>(undefined);

  // Only for a session the URL named. A key the *server* minted has no history
  // by definition, and asking for it is a 404 on every fresh tab.
  const history = useQuery({
    queryKey: queryKeys.messages(session ?? ''),
    queryFn: ({ signal }) => api.messages(session ?? '', signal),
    enabled: session !== undefined,
  });

  useEffect(() => {
    const data = history.data;
    if (data === undefined) return;

    const state = useTurnStore.getState();
    // The one guard that is still needed: a fetch that resolves after the user
    // has already switched to another conversation would otherwise merge one
    // session's history into another's transcript.
    if (state.sessionKey !== session) return;
    state.mergeHistory(data.messages);
  }, [history.data, session]);

  // The welcome screen is for a conversation that is genuinely empty, not for
  // one whose history is still in flight — showing it and then replacing it
  // with a transcript is a flash of the wrong screen on every reload.
  const empty = transcript.length === 0 && !history.isFetching;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {empty ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <Welcome onPick={setDraft} />
        </div>
      ) : (
        <TranscriptView transcript={transcript} busy={busy} onApprove={approveTool} />
      )}

      <Composer
        key={draft}
        initialText={draft}
        busy={busy}
        queueDepth={queueDepth}
        connected={connection === 'open'}
        onStop={stopTurn}
        onSend={(text, attachments) => {
          sendUserMessage(text, attachments);
          setDraft(undefined);
          // The URL catches up with the session the server named, so a reload
          // or a shared link lands on the same conversation. `replace`, because
          // sending a message is not a navigation the back button should undo.
          if (session === undefined && sessionKey !== undefined) {
            void navigate({ to: '/', search: { session: sessionKey }, replace: true });
          }
        }}
      />
    </div>
  );
}
