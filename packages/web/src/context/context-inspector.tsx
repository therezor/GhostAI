/**
 * The context inspector.
 *
 * This is the panel that makes the token budget legible instead of a mystery.
 * "Why did the model forget what I said ten turns ago" has one honest answer —
 * the window filled and the oldest turns fell out of it — and without this the
 * only way to see that coming is to notice it after it happens.
 *
 * The bar is of the *window*, not of what is used, so the empty space to the
 * right is the headroom left. The one case where that breaks down is a budget
 * already over the window: the segments would run off the end and the last one
 * would be silently clipped, so past 100% they are scaled to the bar and the
 * overflow is stated in words instead. A chart that quietly truncates the
 * segment that caused the problem is worse than no chart.
 *
 * `GET /api/sessions/:key/context` is not cheap — it rebuilds the system prompt
 * and re-estimates the whole window — so it is fetched when the dialog opens
 * rather than kept warm behind a button nobody has pressed.
 */

import { useQuery } from '@tanstack/react-query';
import { Gauge } from 'lucide-react';
import { useState, type JSX } from 'react';

import { api, ApiError } from '@/lib/api.js';
import { formatTokens } from '@/lib/format.js';
import { queryKeys } from '@/lib/query.js';
import { cn } from '@/lib/cn.js';
import { Badge } from '@/components/ui/badge.js';
import { Button } from '@/components/ui/button.js';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogHeading,
  DialogSubheading,
  DialogTrigger,
} from '@/components/ui/dialog.js';
import { summariseContext, type ContextSegment } from './breakdown.js';

/** Section → fill. Anything the server adds later lands on the neutral fill. */
const SEGMENT_FILLS: Readonly<Record<string, string>> = {
  systemPrompt: 'bg-info',
  tools: 'bg-accent',
  messages: 'bg-success',
  other: 'bg-warning',
};

const FALLBACK_FILL = 'bg-line-strong';

export function ContextInspector({
  sessionKey,
}: {
  readonly sessionKey: string | undefined;
}): JSX.Element {
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Inspect context"
          // Nothing to inspect before a conversation exists, and asking for the
          // context of a session the server has never minted is a 404.
          disabled={sessionKey === undefined}
        >
          <Gauge />
        </Button>
      </DialogTrigger>

      <DialogContent className="w-[min(44rem,calc(100vw-2rem))]">
        <DialogHeader>
          <DialogHeading>Context</DialogHeading>
          <DialogSubheading>
            What a turn on this conversation would send to the model right now.
          </DialogSubheading>
        </DialogHeader>

        {open && sessionKey !== undefined && <ContextBody sessionKey={sessionKey} />}
      </DialogContent>
    </Dialog>
  );
}

function ContextBody({ sessionKey }: { readonly sessionKey: string }): JSX.Element {
  const context = useQuery({
    queryKey: queryKeys.context(sessionKey),
    queryFn: ({ signal }) => api.context(sessionKey, signal),
    // Every open re-measures. The whole value of the panel is that the number
    // is current, and a cached one from four turns ago is worse than a spinner.
    staleTime: 0,
    gcTime: 0,
  });

  if (context.isPending) return <p className="text-sm text-fg-3">Measuring…</p>;
  if (context.isError) {
    // A 404 here is not a failure. The socket mints a session key the moment a
    // tab connects, and the store does not hold a row for it until the first
    // message lands — so a fresh tab asks about a conversation that does not
    // exist yet, and answering that with a red error is answering the wrong
    // question.
    if (context.error instanceof ApiError && context.error.status === 404) {
      return (
        <p className="text-sm text-fg-3">
          Nothing to measure yet — this conversation has not started. Send a message and the budget
          appears here.
        </p>
      );
    }

    return (
      <p role="alert" className="text-sm text-danger-fg">
        Could not read the context: {context.error.message}
      </p>
    );
  }

  const budget = summariseContext(context.data);
  // Past the window the segments are scaled to the bar so none is clipped; the
  // overflow is then said in words rather than drawn.
  const scale = budget.over && budget.usedPercent > 0 ? 100 / budget.usedPercent : 1;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="text-2xl font-medium text-fg-1">{formatTokens(budget.usedTokens)}</span>
        <span className="text-sm text-fg-3">
          of {formatTokens(budget.windowTokens)} tokens · {budget.usedPercent.toFixed(0)}%
        </span>
        <span className="flex-1" />
        {budget.over ? (
          <Badge tone="danger">over the window</Badge>
        ) : (
          <Badge tone="neutral">{formatTokens(budget.freeTokens)} free</Badge>
        )}
      </div>

      {/* The bar is decoration for the table below it, which carries the same
          numbers as text — so it is hidden from the accessibility tree rather
          than announced as a row of empty divs. */}
      <div aria-hidden="true" className="flex h-3 w-full overflow-hidden rounded-sm bg-surface-3">
        {budget.segments.map((segment) => (
          <div
            key={segment.key}
            className={cn(SEGMENT_FILLS[segment.key] ?? FALLBACK_FILL)}
            style={{ width: `${String(segment.percent * scale)}%` }}
          />
        ))}
      </div>

      <table className="w-full border-collapse text-sm">
        <caption className="sr-only">Token usage by section</caption>
        <thead>
          <tr className="text-left text-2xs tracking-wide text-fg-3 uppercase">
            <th scope="col" className="pb-1 font-medium">
              Section
            </th>
            <th scope="col" className="pb-1 text-right font-medium">
              Tokens
            </th>
            <th scope="col" className="pb-1 text-right font-medium">
              Share
            </th>
          </tr>
        </thead>
        <tbody>
          {budget.segments.map((segment) => (
            <SegmentRow key={segment.key} segment={segment} />
          ))}
        </tbody>
      </table>

      <div className="flex flex-wrap gap-4 text-xs text-fg-3">
        <span>{context.data.messages.length} messages in the window</span>
        <span>{sessionKey}</span>
      </div>

      <details className="rounded-md border border-line bg-surface-1">
        <summary className="cursor-default px-3 py-2 text-sm text-fg-2">System prompt</summary>
        <pre className="max-h-64 overflow-auto border-t border-line px-3 py-2 font-mono text-xs whitespace-pre-wrap text-fg-2">
          {context.data.systemPrompt}
        </pre>
      </details>
    </div>
  );
}

function SegmentRow({ segment }: { readonly segment: ContextSegment }): JSX.Element {
  return (
    <tr className="border-t border-line">
      <th scope="row" className="py-1.5 text-left font-normal text-fg-2">
        <span className="flex items-center gap-2">
          <span
            aria-hidden="true"
            className={cn(
              'inline-block size-2 rounded-xs',
              SEGMENT_FILLS[segment.key] ?? FALLBACK_FILL,
            )}
          />
          {segment.label}
        </span>
      </th>
      <td className="py-1.5 text-right font-mono text-xs text-fg-1">
        {formatTokens(segment.tokens)}
      </td>
      <td className="py-1.5 text-right text-xs text-fg-3">{segment.percent.toFixed(1)}%</td>
    </tr>
  );
}
