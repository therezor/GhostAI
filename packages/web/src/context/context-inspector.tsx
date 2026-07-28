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
import type { JSX } from 'react';

import { api, ApiError } from '@/lib/api.js';
import { formatTokens } from '@/lib/format.js';
import { queryKeys } from '@/lib/query.js';
import { cn } from '@/lib/cn.js';
import { Badge } from '@/components/ui/badge.js';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogHeading,
  DialogSubheading,
} from '@/components/ui/dialog.js';
import { summariseContext, type ContextSegment } from './breakdown.js';

/** Section → fill. Anything the server adds later lands on the neutral fill. */
const SEGMENT_FILLS: Readonly<Record<string, string>> = {
  systemPrompt: 'context-fill--system-prompt',
  tools: 'context-fill--tools',
  messages: 'context-fill--messages',
  other: 'context-fill--other',
};

const FALLBACK_FILL = 'context-fill--fallback';

/**
 * The full breakdown, opened from the strip under the composer.
 *
 * The trigger is not here any more. It used to be a `Gauge` button in the
 * header, which put the measurement about as far from the composer as the
 * layout allows — see `context-strip.tsx`, which is both the trigger and the
 * one-line version of this.
 */
export function ContextDialog({
  sessionKey,
  open,
  onOpenChange,
}: {
  readonly sessionKey: string | undefined;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}): JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="dialog--context">
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

export function ContextBody({ sessionKey }: { readonly sessionKey: string }): JSX.Element {
  const context = useQuery({
    queryKey: queryKeys.context(sessionKey),
    queryFn: ({ signal }) => api.context(sessionKey, signal),
    // No zero stale time any more, and the reason changed rather than the
    // requirement. This used to be fetched only when a button was pressed, so
    // re-measuring on every open was the only way to be current. The strip
    // under the composer is always mounted, and `queryKeys.context` sits under
    // the `['sessions']` prefix that `use-connection.ts` invalidates on every
    // `turn.end` — so the number is refreshed by the thing that changes it,
    // rather than by rebuilding the whole system prompt on a timer.
  });

  if (context.isPending) return <p className="page__note">Measuring…</p>;
  if (context.isError) {
    // A 404 here is not a failure. The socket mints a session key the moment a
    // tab connects, and the store does not hold a row for it until the first
    // message lands — so a fresh tab asks about a conversation that does not
    // exist yet, and answering that with a red error is answering the wrong
    // question.
    if (context.error instanceof ApiError && context.error.status === 404) {
      return (
        <p className="page__note">
          Nothing to measure yet — this conversation has not started. Send a message and the budget
          appears here.
        </p>
      );
    }

    return (
      <p role="alert" className="page__error">
        Could not read the context: {context.error.message}
      </p>
    );
  }

  const budget = summariseContext(context.data);
  // Past the window the segments are scaled to the bar so none is clipped; the
  // overflow is then said in words rather than drawn.
  const scale = budget.over && budget.usedPercent > 0 ? 100 / budget.usedPercent : 1;

  return (
    <div className="stack context">
      <div className="cluster context__headline">
        <span className="context__used">{formatTokens(budget.usedTokens)}</span>
        <span className="context__of">
          of {formatTokens(budget.windowTokens)} tokens · {budget.usedPercent.toFixed(0)}%
        </span>
        <span className="spacer" />
        {budget.over ? (
          <Badge tone="danger">over the window</Badge>
        ) : (
          <Badge tone="neutral">{formatTokens(budget.freeTokens)} free</Badge>
        )}
      </div>

      {/* The bar is decoration for the table below it, which carries the same
          numbers as text — so it is hidden from the accessibility tree rather
          than announced as a row of empty divs. */}
      <div aria-hidden="true" className="context__bar">
        {budget.segments.map((segment) => (
          <div
            key={segment.key}
            className={cn(SEGMENT_FILLS[segment.key] ?? FALLBACK_FILL)}
            style={{ width: `${String(segment.percent * scale)}%` }}
          />
        ))}
      </div>

      <table className="context__table">
        <caption className="sr-only">Token usage by section</caption>
        <thead>
          <tr>
            <th scope="col">Section</th>
            <th scope="col">Tokens</th>
            <th scope="col">Share</th>
          </tr>
        </thead>
        <tbody>
          {budget.segments.map((segment) => (
            <SegmentRow key={segment.key} segment={segment} />
          ))}
        </tbody>
      </table>

      <div className="cluster context__meta">
        <span>{context.data.messages.length} messages in the window</span>
        <span>{sessionKey}</span>
      </div>

      <details className="context__prompt">
        <summary>System prompt</summary>
        <pre>{context.data.systemPrompt}</pre>
      </details>
    </div>
  );
}

function SegmentRow({ segment }: { readonly segment: ContextSegment }): JSX.Element {
  return (
    <tr>
      <th scope="row">
        <span className="row">
          <span
            aria-hidden="true"
            className={cn('context__swatch', SEGMENT_FILLS[segment.key] ?? FALLBACK_FILL)}
          />
          {segment.label}
        </span>
      </th>
      <td className="context__tokens">{formatTokens(segment.tokens)}</td>
      <td className="context__share">{segment.percent.toFixed(1)}%</td>
    </tr>
  );
}
