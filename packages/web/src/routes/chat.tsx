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

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { useEffect, type JSX } from 'react';

import { api } from '@/lib/api.js';
import {
  approveTool,
  editMessage,
  regenerateTurn,
  sendUserMessage,
  stopTurn,
} from '@/lib/connection.js';
import { queryKeys } from '@/lib/query.js';
import { useTurnStore } from '@/state/turn.js';
import { toast } from '@/components/ui/toast.js';
import { AgentPicker } from '@/agents/agent-picker.js';
import { useAgent } from '@/agents/agent-context.js';
import { Composer } from '@/chat/composer.js';
import type { MessageAction } from '@/chat/message.js';
import { ContextStrip } from '@/context/context-strip.js';
import { TranscriptView } from '@/chat/transcript-view.js';
import { Welcome } from '@/chat/welcome.js';

export function ChatRoute(): JSX.Element {
  const { session } = useSearch({ from: '/' });
  const navigate = useNavigate();
  // What the picker in the composer is showing. Carried on the message so a
  // conversation that has no row yet is created bound to it.
  const { agentId } = useAgent();

  const transcript = useTurnStore((state) => state.transcript);
  const busy = useTurnStore((state) => state.busy);
  const queueDepth = useTurnStore((state) => state.queueDepth);
  const connection = useTurnStore((state) => state.connection);
  const sessionKey = useTurnStore((state) => state.sessionKey);

  const queryClient = useQueryClient();

  /**
   * Branch is the one action that is a request rather than a frame.
   *
   * It creates a session and starts no turn, so it needs an answer — the key of
   * the fork, which is where the user is then taken. Regenerate and edit go
   * over the socket instead, because both *start a turn* and every turn belongs
   * to the hub's queue.
   */
  const branch = useMutation({
    mutationFn: ({ key, seq }: { key: string; seq: number }) => api.branchSession(key, seq),
    onSuccess: (fork) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.sessions() });
      void navigate({ to: '/', search: { session: fork.key } });
    },
    onError: (error: Error) => {
      toast.error('Could not branch the conversation', error.message);
    },
  });

  function runAction(action: MessageAction): void {
    switch (action.kind) {
      case 'edit':
        editMessage(action.seq, action.text);
        return;
      case 'regenerate':
        regenerateTurn(action.seq);
        return;
      case 'branch':
        if (sessionKey !== undefined) branch.mutate({ key: sessionKey, seq: action.seq });
        return;
    }
  }

  // Whether a turn can run at all. The shell reads this too, so on a working
  // install it is already in the cache and costs nothing here.
  const status = useQuery({
    queryKey: queryKeys.status,
    queryFn: ({ signal }) => api.status(signal),
  });

  // Only for a session the URL named. A key the *server* minted has no history
  // by definition, and asking for it is a 404 on every fresh tab.
  const history = useQuery({
    queryKey: queryKeys.messages(session ?? ''),
    queryFn: ({ signal }) => api.messages(session ?? '', signal),
    enabled: session !== undefined,
    // A conversation that has not been spoken in has no stored row, so this is
    // a 404 until the first turn lands — an expected answer rather than a
    // failure worth three exponential backoffs.
    retry: false,
  });

  useEffect(() => {
    const data = history.data;
    if (data === undefined) return;

    const state = useTurnStore.getState();
    // The one guard that is still needed: a fetch that resolves after the user
    // has already switched to another conversation would otherwise merge one
    // session's history into another's transcript.
    if (state.sessionKey !== session) return;
    state.mergeHistory(data.messages, data.subagentRuns);
  }, [history.data, session]);

  // The welcome screen is for a conversation that is genuinely empty, not for
  // one whose history is still in flight — showing it and then replacing it
  // with a transcript is a flash of the wrong screen on every reload.
  const empty = transcript.length === 0 && !history.isFetching;

  return (
    <div className="chat">
      {empty ? (
        <div className="transcript__viewport">
          <Welcome />
        </div>
      ) : (
        <TranscriptView
          transcript={transcript}
          busy={busy}
          sessionKey={sessionKey}
          onApprove={approveTool}
          onAction={runAction}
        />
      )}

      {/* Above the composer rather than inside it: the pointer is a link, and
          the composer is a leaf that is rendered outside a router by its own
          tests. The route is where a route knows how to be navigated to. */}
      {status.data?.configured === false && (
        <p role="status" className="chat__setup-notice">
          No model is configured yet.{' '}
          <Link to="/settings" search={{ panel: 'providers' }}>
            Add a provider
          </Link>{' '}
          to start a conversation.
        </p>
      )}

      <Composer
        // Which agent the next turn runs on. In the conversation rather than
        // the sidebar: choosing one is part of asking the question.
        lead={<AgentPicker {...(sessionKey === undefined ? {} : { sessionKey })} />}
        // The line under the box is the budget's now: it is the one thing there
        // that changes, and it used to share the row with a keyboard hint that
        // never did. See `composer.tsx`.
        meta={<ContextStrip sessionKey={sessionKey} />}
        busy={busy}
        queueDepth={queueDepth}
        connected={connection === 'open'}
        // Absent while the status query is in flight; treated as configured so
        // the composer does not flash a setup pointer on every page load of a
        // working install.
        configured={status.data?.configured ?? true}
        onStop={stopTurn}
        onSend={(text, attachments) => {
          sendUserMessage(text, attachments, agentId);
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
