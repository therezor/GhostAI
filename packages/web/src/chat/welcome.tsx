/**
 * The empty conversation.
 *
 * Not a marketing panel and not a tour. What a first-time reader of a
 * self-hosted agent needs to know is which model is about to answer them and
 * what it is allowed to do to their machine — the second of which is the thing
 * every hosted assistant leaves out, and the thing this one exists to make
 * explicit.
 *
 * **The model named here is the selected agent's, not the install's.** That
 * distinction is the whole value of the line: an agent may pin its own model, and
 * this screen used to read `/api/status` — so a conversation about to run on a
 * researcher's pinned model announced the default instead. A screen whose one job
 * is to say what will answer has to be right about it, or it is worse than blank.
 *
 * **The suggested prompts are gone.** Three canned openers is a feature list
 * wearing the clothes of a shortcut: nobody wants to summarise the files in
 * this workspace, and an operator who did would type it faster than they could
 * read three sentences to find it. They also cost the screen its shape, putting
 * a list of buttons between the one paragraph that matters and the box.
 *
 * What is here instead is the keyboard hint, which used to live under the
 * composer on every render for the life of the install. It is true forever and
 * worth reading once, so it belongs on the screen somebody sees before they
 * have sent anything — not in the line under the box, where it was crowding out
 * the context budget.
 */

import { useQuery } from '@tanstack/react-query';
import { Skull } from 'lucide-react';
import type { JSX } from 'react';
import { useTranslation } from 'react-i18next';

import { api } from '@/lib/api.js';
import { queryKeys } from '@/lib/query.js';
import { Badge } from '@/components/ui/badge.js';
import { useAgent } from '@/agents/agent-context.js';

export function Welcome(): JSX.Element {
  const { t } = useTranslation();
  const { agentId } = useAgent();

  // `/api/status` carries the *install's* model, which is the wrong answer
  // whenever the selected agent overrides it: a researcher pinned to one model
  // showed the default here, and the screen whose entire job is to say what is
  // about to answer said something else. `/api/agents` resolves each agent's
  // model after inheritance and after any process-wide `--model` pin, which is
  // the figure a turn will actually use.
  const agents = useQuery({
    queryKey: queryKeys.agents,
    queryFn: ({ signal }) => api.agents(signal),
  });
  const status = useQuery({
    queryKey: queryKeys.status,
    queryFn: ({ signal }) => api.status(signal),
  });

  const agent = agents.data?.agents.find((entry) => entry.id === agentId);
  // Falling back to the install's model rather than to nothing: an agent id held
  // in `localStorage` can name an agent that has since been deleted, and a blank
  // line reads as "no model configured" — which is a different and alarming
  // claim. The picker beside the composer is what corrects the stale id.
  const provider = agent?.provider ?? status.data?.provider ?? '';
  const model = agent?.model ?? status.data?.model ?? '';

  return (
    <div className="stack welcome">
      <Skull className="welcome__mark" aria-hidden="true" />

      <div className="stack welcome__heading">
        <h1 className="welcome__title">{t('chat.ready')}</h1>
        {status.data?.configured === true && model !== '' && (
          <p className="cluster welcome__agent">
            <Badge tone="neutral">{provider}</Badge>
            <span className="welcome__model">{model}</span>
          </p>
        )}
      </div>

      <p className="welcome__note">{t('chat.welcomeNote')}</p>

      <p className="welcome__hint">{t('chat.welcomeHint')}</p>
    </div>
  );
}
