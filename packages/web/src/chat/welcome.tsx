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
import { Ghost } from 'lucide-react';
import type { JSX } from 'react';

import { api } from '@/lib/api.js';
import { queryKeys } from '@/lib/query.js';
import { Badge } from '@/components/ui/badge.js';

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
    <div className="mx-auto flex max-w-2xl flex-col items-center gap-5 px-4 py-16 text-center">
      <Ghost className="size-10 text-fg-3" aria-hidden="true" />

      <div className="flex flex-col items-center gap-1.5">
        <h1 className="text-xl font-medium">Ready when you are.</h1>
        {status.isSuccess && (
          <p className="flex flex-wrap items-center justify-center gap-1.5 text-sm text-fg-2">
            <Badge tone="neutral">{status.data.provider}</Badge>
            <span className="font-mono text-xs">{status.data.model}</span>
          </p>
        )}
      </div>

      <p className="max-w-prose text-sm text-fg-2">
        The agent reads and writes inside its workspace, and asks before it runs a command or
        reaches the network. Every tool call shows up in the transcript with its arguments and its
        output.
      </p>

      <ul className="flex w-full flex-col gap-2">
        {PROMPTS.map((prompt) => (
          <li key={prompt}>
            <button
              type="button"
              onClick={() => {
                onPick(prompt);
              }}
              className="w-full rounded-md border border-line bg-surface-2 px-3 py-2 text-left text-sm text-fg-2 hover:bg-hover hover:text-fg-1"
            >
              {prompt}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
