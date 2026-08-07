/**
 * Which agent a conversation runs on, and how choosing one works.
 *
 * The policy, lifted out of `agent-picker.tsx` when `/agent` in the composer
 * became a second way to say the same thing. It is not the kind of rule that
 * survives being written twice: the two modes below differ by which door the
 * choice goes through, and a copy that got that wrong would look correct and
 * silently fail to move anything.
 *
 *  - **Before the first message** there is no session row, so the choice is only
 *    a preference for the conversation about to start. It lives in the agent
 *    context, which is also what `newSession` sends.
 *  - **After the first message** the binding lives on the row, and changing it
 *    is a real edit — `PATCH /api/sessions/:key`. A frame naming an agent is
 *    ignored for a session that already exists, deliberately, so this is the
 *    only way to move one.
 *
 * **`choose` rejects rather than reporting.** The two callers say it
 * differently — the picker raises a toast of its own, the command folds the
 * failure into the sentence it was already going to print — and a hook that
 * toasted would give one of them two.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

import { DEFAULT_AGENT_ID, type AgentSummary } from '@ghostai/protocol';

import { api } from '@/lib/api.js';
import { queryKeys } from '@/lib/query.js';
import { useAgent } from './agent-context.js';

export interface AgentChoice {
  /** Every configured agent. Empty while the listing is in flight. */
  readonly agents: readonly AgentSummary[];
  /** The id in force: the stored binding if there is one, else the preference. */
  readonly current: string;
  /** The stored binding, or `undefined` while this is still a preference. */
  readonly bound: string | undefined;
  /** The agent `current` names, if it is one that exists. */
  readonly match: AgentSummary | undefined;
  /** True once the listing has arrived and `current` is not in it. */
  readonly missing: boolean;
  /** Whether the conversation has a stored row yet. */
  readonly stored: boolean;
  readonly choose: (agentId: string) => Promise<void>;
}

export function useAgentChoice(sessionKey: string | undefined): AgentChoice {
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
  });

  return {
    agents: rows,
    current,
    bound,
    match,
    missing,
    stored: stored.data !== undefined,
    choose: async (agentId: string): Promise<void> => {
      if (agentId === current) return;
      if (bound === undefined) {
        // No row yet: this is the agent the conversation will be created with.
        select(agentId);
        return;
      }
      await move.mutateAsync(agentId);
    },
  };
}
