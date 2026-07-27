/**
 * One transcript item.
 *
 * The user's side is a bubble; the agent's side is not. That asymmetry is
 * deliberate and it is what the layout is for: a user message is short, bounded
 * and belongs to a person, so a right-aligned bubble reads correctly. An answer
 * is long, contains code blocks and tables, and is the page's actual content —
 * putting it in a bubble would give it a container that fights every wide thing
 * inside it and a width nobody wants to read at.
 *
 * A turn renders its parts in arrival order, which is the whole reason
 * `transcript.ts` keeps them as a list: text, then a tool card, then more text
 * is a shape a `{ text, tools[] }` object cannot express, and reordering it
 * would make the answer describe a call that appears below it.
 */

import { AlertCircle } from 'lucide-react';
import type { JSX } from 'react';

import type { ApprovalScope } from '@ghostai/protocol';

import { cn } from '@/lib/cn.js';
import { Badge } from '@/components/ui/badge.js';
import type { TranscriptItem, TurnItem, UserItem } from '@/state/transcript.js';
import { Markdown } from './markdown/markdown.js';
import { Notice } from './notice.js';
import { ReasoningBlock } from './reasoning.js';
import { ToolCard } from './tool-card.js';

export interface MessageProps {
  readonly item: TranscriptItem;
  /** True for the newest turn while the session is busy. */
  readonly streaming: boolean;
  readonly onApprove: (callId: string, approved: boolean, scope: ApprovalScope) => void;
}

export function Message({ item, streaming, onApprove }: MessageProps): JSX.Element {
  switch (item.kind) {
    case 'user':
      return <UserMessage item={item} />;
    case 'turn':
      return <TurnMessage turn={item} streaming={streaming} onApprove={onApprove} />;
    case 'steer':
      return (
        <p className="self-center rounded-full bg-surface-2 px-3 py-1 text-xs text-fg-3">
          Steered mid-turn: {item.text}
        </p>
      );
    case 'notice':
      return <Notice kind={item.notice} message={item.message} />;
  }
}

function UserMessage({ item }: { readonly item: UserItem }): JSX.Element {
  return (
    <div className="flex flex-col items-end gap-1 self-end">
      <div
        className={cn(
          'max-w-[85%] rounded-xl rounded-br-sm bg-surface-3 px-3 py-2 text-md whitespace-pre-wrap',
          // Not markdown: what the user typed is what the model receives, so
          // rendering their asterisks as emphasis would show them a different
          // message from the one they sent.
          item.pending && 'text-fg-2',
        )}
      >
        {item.text}
      </div>

      {item.attachments.length > 0 && (
        <ul className="flex flex-wrap justify-end gap-1">
          {item.attachments.map((attachment) => (
            <li key={attachment.url}>
              <Badge tone="neutral">{attachment.name ?? attachment.type}</Badge>
            </li>
          ))}
        </ul>
      )}

      {item.pending && (
        <span className="text-2xs text-fg-3" role="status">
          Sending…
        </span>
      )}
    </div>
  );
}

function TurnMessage({
  turn,
  streaming,
  onApprove,
}: {
  readonly turn: TurnItem;
  readonly streaming: boolean;
  readonly onApprove: MessageProps['onApprove'];
}): JSX.Element {
  const lastPart = turn.parts.at(-1);
  const hasAnswer = turn.parts.some((part) => part.kind === 'text');

  return (
    <article className="flex min-w-0 flex-col gap-3">
      {turn.parts.map((part) => {
        const live = streaming && !turn.done && part === lastPart;

        switch (part.kind) {
          case 'text':
            return (
              <Markdown
                key={part.id}
                text={part.text}
                // Only the trailing part of an unfinished turn is still growing.
                streaming={live}
              />
            );

          case 'reasoning':
            return <ReasoningBlock key={part.id} text={part.text} live={live && !hasAnswer} />;

          case 'tool':
            return <ToolCard key={part.id} tool={part} onApprove={onApprove} />;

          case 'notice':
            return <Notice key={part.id} kind={part.notice} message={part.message} />;
        }
      })}

      {streaming && !turn.done && turn.parts.length === 0 && (
        <p className="text-sm text-fg-3" role="status">
          <span className="animate-pulse">Thinking…</span>
        </p>
      )}

      {turn.failure !== undefined && (
        <p className="flex items-start gap-2 rounded-md border border-danger-fg/40 bg-danger-soft px-2.5 py-1.5 text-xs text-danger-fg">
          <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
          <span className="min-w-0 text-fg-2">
            {turn.failure.message}
            {turn.failure.retryable && ' Sending the message again may work.'}
          </span>
        </p>
      )}

      <TurnFooter turn={turn} />
    </article>
  );
}

/**
 * The stop reason, and only when it is not `complete`.
 *
 * A footer on every finished turn saying "complete" is a line of noise on every
 * message. The three that are worth a sentence are the ones where the answer
 * stops short of what was asked, and the user is otherwise left to infer it
 * from an answer that simply ends.
 */
const STOP_REASONS: Record<string, string> = {
  aborted: 'Stopped.',
  max_iterations: 'Stopped after reaching the iteration limit for one turn.',
  wall_timeout: 'Stopped after reaching the time limit for one turn.',
  error: 'The turn ended with an error.',
};

function TurnFooter({ turn }: { readonly turn: TurnItem }): JSX.Element | null {
  if (!turn.done) return null;

  const reason = turn.stopReason === undefined ? undefined : STOP_REASONS[turn.stopReason];
  const usage = turn.usage;
  if (reason === undefined && usage === undefined) return null;

  return (
    <footer className="flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-fg-3">
      {reason !== undefined && <span className="text-warning-fg">{reason}</span>}
      {usage !== undefined && (
        <span className="tabular-nums">
          {usage.promptTokens.toLocaleString()} in · {usage.completionTokens.toLocaleString()} out
          {usage.cachedTokens !== undefined &&
            usage.cachedTokens > 0 &&
            ` · ${usage.cachedTokens.toLocaleString()} cached`}
        </span>
      )}
      {turn.iterations > 1 && <span>{turn.iterations} iterations</span>}
      {turn.model !== '' && <span className="truncate">{turn.model}</span>}
    </footer>
  );
}
