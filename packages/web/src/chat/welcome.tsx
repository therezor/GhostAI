/**
 * The empty conversation.
 *
 * Not a marketing panel and not a tour. What a first-time reader of a
 * self-hosted agent needs to know is which model is about to answer them and
 * what it is allowed to do to their machine — the second of which is the thing
 * every hosted assistant leaves out, and the thing this one exists to make
 * explicit.
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

export function Welcome(): JSX.Element {
  const { t } = useTranslation();
  const status = useQuery({
    queryKey: queryKeys.status,
    queryFn: ({ signal }) => api.status(signal),
  });

  return (
    <div className="stack welcome">
      <Skull className="welcome__mark" aria-hidden="true" />

      <div className="stack welcome__heading">
        <h1 className="welcome__title">{t('chat.ready')}</h1>
        {status.isSuccess && status.data.configured && (
          <p className="cluster welcome__agent">
            <Badge tone="neutral">{status.data.provider}</Badge>
            <span className="welcome__model">{status.data.model}</span>
          </p>
        )}
      </div>

      <p className="welcome__note">{t('chat.welcomeNote')}</p>

      <p className="welcome__hint">{t('chat.welcomeHint')}</p>
    </div>
  );
}
