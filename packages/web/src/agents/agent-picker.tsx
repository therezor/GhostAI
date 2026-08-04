/**
 * Which agent this conversation runs on, in the conversation.
 *
 * It sits in the composer's meta row rather than in the sidebar, because that
 * is where the decision is actually made: choosing an agent is part of asking
 * the question, not part of configuring the application. A picker three
 * columns away from the message box is one nobody touches.
 *
 * The control means two different things and says so, which is the whole of its
 * design:
 *
 *  - **Before the first message** there is no session row, so the choice is
 *    only a preference for the conversation about to start. It is kept in the
 *    agent context, which is also what `newSession` sends.
 *  - **After the first message** the binding lives on the session row, and
 *    changing it is a real edit — `PATCH /api/sessions/:key`. A frame naming an
 *    agent is ignored for a session that already exists, deliberately, so this
 *    is the only way to move one.
 *
 * The second case is worth a word of warning in the menu rather than a refusal.
 * Moving a conversation mid-way is a legitimate thing to want — start with a
 * cheap model, escalate — and the history is unchanged by it; what changes is
 * the prompt, tools and permissions the *next* turn runs under.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  BrainCircuit,
  ChevronDown,
  Settings2,
  TriangleAlert,
} from 'lucide-react';
import { useEffect, type JSX } from 'react';
import { useTranslation } from 'react-i18next';

import { DEFAULT_AGENT_ID } from '@ghostai/protocol';

import { Button } from '@/components/ui/button.js';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu.js';
import { api } from '@/lib/api.js';
import { queryKeys } from '@/lib/query.js';
import { toast } from '@/components/ui/toast.js';
import { useAgent } from './agent-context.js';

export function AgentPicker({
  sessionKey,
}: {
  readonly sessionKey?: string;
}): JSX.Element {
  const { t } = useTranslation();
  const { agentId: preferred, select, adopt } = useAgent();
  const queryClient = useQueryClient();

  const agents = useQuery({
    queryKey: queryKeys.agents,
    queryFn: ({ signal }) => api.agents(signal),
  });

  // A conversation nobody has spoken in has no row, so this 404s until the
  // first turn lands. That is the signal, not a failure: no row means the
  // choice is still only a preference.
  const stored = useQuery({
    queryKey: queryKeys.session(sessionKey ?? ''),
    queryFn: ({ signal }) => api.session(sessionKey ?? '', signal),
    enabled: sessionKey !== undefined,
    retry: false,
  });

  const bound = stored.data?.agentId;
  const current = bound ?? preferred;
  const rows = agents.data?.agents ?? [];
  const match = rows.find((row) => row.id === current);
  const label = match?.label ?? current;
  // Only once the listing has actually arrived. While it is in flight every id
  // looks missing, and a picker that flagged the agent on each cold load would
  // cry wolf until the query settled.
  const missing = agents.isSuccess && match === undefined;

  // A stale *preference* is corrected here, because this is the first place
  // that holds both the remembered id and the list to check it against — the
  // agent context is mounted above the data layer and has no listing.
  //
  // Only a preference, never a binding: moving a conversation is a real edit
  // and belongs to the operator. The remembered id is otherwise only ever fixed
  // in the browser that did the deleting, so every other tab and device keeps
  // sending a dead id indefinitely.
  useEffect(() => {
    if (!missing || bound !== undefined) return;
    select(DEFAULT_AGENT_ID);
  }, [missing, bound, select]);

  const move = useMutation({
    mutationFn: (agentId: string) =>
      api.moveSessionToAgent(sessionKey ?? '', agentId),
    onSuccess: (updated) => {
      queryClient.setQueryData(queryKeys.session(updated.key), updated);
      void queryClient.invalidateQueries({ queryKey: queryKeys.sessions() });
      // The switcher follows the conversation rather than claiming to have set
      // it — see `adopt` in the context.
      adopt(updated.agentId ?? DEFAULT_AGENT_ID);
    },
    onError: (error: Error) => {
      toast.error(t('agents.moveFailed'), error.message);
    },
  });

  const choose = (agentId: string): void => {
    if (agentId === current) return;
    if (bound === undefined) {
      // No row yet: this is the agent the conversation will be created with.
      select(agentId);
      return;
    }
    move.mutate(agentId);
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className={
            missing ? 'composer__picker is-missing' : 'composer__picker'
          }
          aria-label={
            missing
              ? t('agents.missingLabel', { id: current })
              : t('agents.pickerLabel', { label })
          }
        >
          {missing ? (
            <TriangleAlert aria-hidden="true" />
          ) : (
            <BrainCircuit aria-hidden="true" />
          )}
          <span className="truncate">{label}</span>
          <ChevronDown className="composer__picker-caret" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" side="top" className="floating--menu">
        {/* Said before the list rather than as an empty selection. The radio
            group below matches nothing when the bound agent is gone, and a menu
            with no item checked reads as a rendering bug rather than as a
            conversation pointing at an agent that no longer exists. */}
        {missing && (
          <DropdownMenuLabel className="composer__picker-notice" role="alert">
            {t('agents.missingNotice', { id: current })}
          </DropdownMenuLabel>
        )}

        <DropdownMenuLabel>
          {bound === undefined
            ? t('agents.forThisSession')
            : t('agents.moveThisSession')}
        </DropdownMenuLabel>

        <DropdownMenuRadioGroup value={current} onValueChange={choose}>
          {rows.map((agent) => (
            <DropdownMenuRadioItem key={agent.id} value={agent.id}>
              <span className="truncate">{agent.label}</span>
              {agent.model !== '' && (
                <span className="composer__picker-hint">{agent.model}</span>
              )}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>

        <DropdownMenuSeparator />

        <DropdownMenuItem asChild>
          <Link to="/agents">
            <Settings2 />
            {t('agents.manage')}
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
