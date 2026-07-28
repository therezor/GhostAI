/**
 * What a turn cost, behind the info button under it.
 *
 * Two sources, and the split is the point. A turn this tab watched happen
 * carries its own numbers on `turn.end`, so asking the server to repeat figures
 * the client just measured would be a round trip to learn what it already
 * knows. A turn from before the page loaded has no such event ever again —
 * which is exactly why the server persists `turn_stats` — so those are fetched
 * once per conversation and looked up by turn id.
 *
 * `tokensPerSecond` comes from `@ghostai/protocol` rather than being computed
 * here, because the terminal reports the same figure and two implementations of
 * one division eventually disagree about what to do with a zero.
 */

import { useQuery } from '@tanstack/react-query';
import { Info } from 'lucide-react';
import type { JSX } from 'react';

import { tokensPerSecond, type StopReason, type Usage } from '@ghostai/protocol';

import { api } from '@/lib/api.js';
import { formatDuration, formatTokens } from '@/lib/format.js';
import { queryKeys } from '@/lib/query.js';
import { Button } from '@/components/ui/button.js';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover.js';
import type { TurnItem } from '@/state/transcript.js';

export function TurnInfo({
  turn,
  sessionKey,
}: {
  readonly turn: TurnItem;
  readonly sessionKey: string | undefined;
}): JSX.Element {
  return (
    <Popover>
      {/* The `<Button>` is written out here rather than wrapped in a component
          of its own. `asChild` clones this element to inject `onClick`, the
          ref and `aria-expanded`, and a component that does not spread its
          props swallows every one of them — which is a trigger that renders
          perfectly and opens nothing. */}
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Turn details">
          <Info />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="popover--turn-info">
        <TurnInfoBody turn={turn} sessionKey={sessionKey} />
      </PopoverContent>
    </Popover>
  );
}

function TurnInfoBody({
  turn,
  sessionKey,
}: {
  readonly turn: TurnItem;
  readonly sessionKey: string | undefined;
}): JSX.Element {
  // Only for a turn the live stream did not describe. A conversation the user
  // is sitting in front of never reaches this.
  const stored = useQuery({
    queryKey: queryKeys.turns(sessionKey ?? ''),
    queryFn: ({ signal }) => api.turns(sessionKey ?? '', signal),
    enabled: sessionKey !== undefined && turn.usage === undefined,
    retry: false,
  });

  const row = stored.data?.turns.find((entry) => entry.turnId === turn.id);

  const usage: Usage | undefined = turn.usage ?? row?.usage;
  const model = turn.model === '' ? (row?.model ?? '') : turn.model;
  const provider = turn.provider === '' ? (row?.provider ?? '') : turn.provider;
  const iterations = turn.iterations > 0 ? turn.iterations : (row?.iterations ?? 0);
  const stopReason: StopReason | undefined = turn.stopReason ?? row?.stopReason;
  const elapsedMs =
    turn.elapsedMs ??
    (row === undefined ? undefined : Math.max(0, row.endedAtMs - row.startedAtMs));

  if (usage === undefined) {
    return <p className="turn-info__empty">No figures were recorded for this turn.</p>;
  }

  const rate = elapsedMs === undefined ? undefined : tokensPerSecond(usage, elapsedMs);

  return (
    <dl className="turn-info">
      <Row label="Model" value={model === '' ? '—' : model} />
      <Row label="Provider" value={provider === '' ? '—' : provider} />
      <Row label="In" value={formatTokens(usage.promptTokens)} />
      <Row label="Out" value={formatTokens(usage.completionTokens)} />
      {usage.cachedTokens !== undefined && (
        <Row label="Cached" value={formatTokens(usage.cachedTokens)} />
      )}
      {usage.reasoningTokens !== undefined && (
        <Row label="Reasoning" value={formatTokens(usage.reasoningTokens)} />
      )}
      {elapsedMs !== undefined && <Row label="Elapsed" value={formatDuration(elapsedMs)} />}
      {/* Absent rather than zero when there is nothing to divide: a turn that
          produced no tokens has no rate, and one measured at zero milliseconds
          was not measured. */}
      {rate !== undefined && <Row label="Rate" value={`${rate.toFixed(1)} tok/s`} />}
      <Row label="Steps" value={String(iterations)} />
      {stopReason !== undefined && <Row label="Stopped" value={stopReason.replace('_', ' ')} />}
    </dl>
  );
}

function Row({ label, value }: { readonly label: string; readonly value: string }): JSX.Element {
  return (
    <div className="turn-info__row">
      <dt className="turn-info__label">{label}</dt>
      <dd className="turn-info__value">{value}</dd>
    </div>
  );
}
