/**
 * The empty conversation.
 *
 * Not a marketing panel and not a tour. What a first-time reader of a
 * self-hosted agent needs to know is which model is about to answer them and
 * what it is allowed to do to their machine — the second of which is the thing
 * every hosted assistant leaves out, and the thing this one exists to make
 * explicit. The prompts below it are a way to start typing, not a feature list.
 */

import { useQuery } from '@tanstack/react-query';
import type { JSX } from 'react';

import { api } from '@/lib/api.js';
import { queryKeys } from '@/lib/query.js';
import { Badge } from '@/components/ui/badge.js';
import { Skull } from '@/components/skull.js';

const PROMPTS: readonly string[] = [
  'Summarise the files in this workspace.',
  'Read package.json and tell me what this project is.',
  'Run the test suite and explain the first failure.',
];

export function Welcome({ onPick }: { readonly onPick: (prompt: string) => void }): JSX.Element {
  const status = useQuery({
    queryKey: queryKeys.status,
    queryFn: ({ signal }) => api.status(signal),
  });

  return (
    <div className="stack welcome">
      <Skull className="welcome__mark" aria-hidden="true" />

      <div className="stack welcome__heading">
        <h1 className="welcome__title">Ready when you are.</h1>
        {status.isSuccess && (
          <p className="cluster welcome__agent">
            <Badge tone="neutral">{status.data.provider}</Badge>
            <span className="welcome__model">{status.data.model}</span>
          </p>
        )}
      </div>

      <p className="welcome__note">
        The agent reads and writes inside its workspace, and asks before it runs a command or
        reaches the network. Every tool call shows up in the transcript with its arguments and its
        output.
      </p>

      <ul className="stack welcome__prompts">
        {PROMPTS.map((prompt) => (
          <li key={prompt}>
            <button
              type="button"
              onClick={() => {
                onPick(prompt);
              }}
              className="welcome__prompt"
            >
              {prompt}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
