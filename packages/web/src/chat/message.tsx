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
import { useState, type JSX } from 'react';

import type { ApprovalScope } from '@ghostai/protocol';

import { cn } from '@/lib/cn.js';
import { Badge } from '@/components/ui/badge.js';
import { Button } from '@/components/ui/button.js';
import { AutoGrowTextarea } from '@/components/auto-grow-textarea.js';
import type { TranscriptItem, TurnItem, UserItem } from '@/state/transcript.js';
import { Markdown } from './markdown/markdown.js';
import { MessageActions } from './message-actions.js';
import { Notice } from './notice.js';
import { ReasoningBlock } from './reasoning.js';
import { ToolCard } from './tool-card.js';
import { TurnInfo } from './turn-info.js';

/**
 * What the transcript asks the route to do, as one callback rather than four
 * props threaded through two components.
 *
 * Every variant names a `seq`, because every one of them addresses a point in
 * stored history — which is why the actions that need one are not offered until
 * the message has it.
 */
export type MessageAction =
  | { readonly kind: 'edit'; readonly seq: number; readonly text: string }
  | { readonly kind: 'regenerate'; readonly seq: number }
  | { readonly kind: 'branch'; readonly seq: number };

export interface MessageProps {
  readonly item: TranscriptItem;
  /** True for the newest turn while the session is busy. */
  readonly streaming: boolean;
  /** True while any turn is running — what disables everything destructive. */
  readonly busy: boolean;
  readonly sessionKey: string | undefined;
  readonly onApprove: (callId: string, approved: boolean, scope: ApprovalScope) => void;
  readonly onAction: (action: MessageAction) => void;
}

export function Message({
  item,
  streaming,
  busy,
  sessionKey,
  onApprove,
  onAction,
}: MessageProps): JSX.Element {
  switch (item.kind) {
    case 'user':
      return <UserMessage item={item} busy={busy} onAction={onAction} />;
    case 'turn':
      return (
        <TurnMessage
          turn={item}
          streaming={streaming}
          busy={busy}
          sessionKey={sessionKey}
          onApprove={onApprove}
          onAction={onAction}
        />
      );
    case 'steer':
      return <p className="steer">Steered mid-turn: {item.text}</p>;
    case 'notice':
      return <Notice kind={item.notice} message={item.message} />;
  }
}

function UserMessage({
  item,
  busy,
  onAction,
}: {
  readonly item: UserItem;
  readonly busy: boolean;
  readonly onAction: (action: MessageAction) => void;
}): JSX.Element {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.text);

  // Until storage has answered for this message there is nothing to address,
  // so the actions that name a `seq` are not offered rather than offered and
  // broken.
  const seq = item.seq;

  if (editing && seq !== undefined) {
    return (
      <div className="stack message-user">
        <form
          className="stack message-user__editor"
          onSubmit={(event) => {
            event.preventDefault();
            if (draft.trim() === '') return;
            setEditing(false);
            onAction({ kind: 'edit', seq, text: draft });
          }}
        >
          <AutoGrowTextarea
            aria-label="Edit message"
            value={draft}
            autoFocus
            onChange={(event) => {
              setDraft(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                setDraft(item.text);
                setEditing(false);
                return;
              }
              // Cmd/Ctrl+Enter saves; a bare Enter is a newline, because an
              // edit is usually of something long enough to have needed one.
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                if (draft.trim() === '') return;
                setEditing(false);
                onAction({ kind: 'edit', seq, text: draft });
              }
            }}
          />
          <div className="cluster message-user__editor-actions">
            <Button type="submit" size="sm" disabled={draft.trim() === ''}>
              Save
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setDraft(item.text);
                setEditing(false);
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      </div>
    );
  }

  return (
    <div className="stack message-user">
      <div className={cn('message-user__bubble', item.pending && 'message-user__bubble--pending')}>
        {item.text}
      </div>

      {item.attachments.length > 0 && (
        <ul className="cluster message-user__attachments">
          {item.attachments.map((attachment) => (
            <li key={attachment.url}>
              <Badge tone="neutral">{attachment.name ?? attachment.type}</Badge>
            </li>
          ))}
        </ul>
      )}

      {item.pending && (
        <span className="message-user__pending" role="status">
          Sending…
        </span>
      )}

      {!item.pending && (
        <div className="message-user__actions">
          <MessageActions
            text={item.text}
            busy={busy}
            {...(seq === undefined
              ? {}
              : {
                  onEdit: () => {
                    setDraft(item.text);
                    setEditing(true);
                  },
                  // Before the question: branching from something you said means
                  // asking it again down a different path.
                  onBranch: () => {
                    onAction({ kind: 'branch', seq: seq - 1 });
                  },
                })}
          />
        </div>
      )}
    </div>
  );
}

function TurnMessage({
  turn,
  streaming,
  busy,
  sessionKey,
  onApprove,
  onAction,
}: {
  readonly turn: TurnItem;
  readonly streaming: boolean;
  readonly busy: boolean;
  readonly sessionKey: string | undefined;
  readonly onApprove: MessageProps['onApprove'];
  readonly onAction: (action: MessageAction) => void;
}): JSX.Element {
  const lastPart = turn.parts.at(-1);
  const hasAnswer = turn.parts.some((part) => part.kind === 'text');

  return (
    <article className="stack turn">
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
        <p className="turn__thinking" role="status">
          <span className="thinking-dots" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>{' '}
          Thinking…
        </p>
      )}

      {turn.failure !== undefined && (
        <p className="turn__failure">
          <AlertCircle />
          <span>
            {turn.failure.message}
            {turn.failure.retryable && ' Sending the message again may work.'}
          </span>
        </p>
      )}

      <TurnFooter turn={turn} busy={busy} sessionKey={sessionKey} onAction={onAction} />
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

function TurnFooter({
  turn,
  busy,
  sessionKey,
  onAction,
}: {
  readonly turn: TurnItem;
  readonly busy: boolean;
  readonly sessionKey: string | undefined;
  readonly onAction: (action: MessageAction) => void;
}): JSX.Element | null {
  // The footer now always renders on a finished turn, because it carries the
  // action bar. It is still one footer rather than two — a row of buttons under
  // a row of metadata would be two things saying "this turn is over".
  if (!turn.done) return null;

  const reason = turn.stopReason === undefined ? undefined : STOP_REASONS[turn.stopReason];
  const usage = turn.usage;
  // Narrowed here rather than asserted inside the callbacks below: a `!` in a
  // closure is a claim the compiler cannot check at the point it runs.
  const { firstSeq, lastSeq } = turn;
  const text = turn.parts
    .filter((part) => part.kind === 'text')
    .map((part) => part.text)
    .join('\n\n');

  return (
    <footer className="turn__footer">
      {reason !== undefined && <span className="turn__stop-reason">{reason}</span>}
      {usage !== undefined && (
        <span className="turn__usage">
          {usage.promptTokens.toLocaleString()} in · {usage.completionTokens.toLocaleString()} out
          {usage.cachedTokens !== undefined &&
            usage.cachedTokens > 0 &&
            ` · ${usage.cachedTokens.toLocaleString()} cached`}
        </span>
      )}
      {turn.iterations > 1 && <span>{turn.iterations} iterations</span>}
      {turn.model !== '' && <span className="truncate">{turn.model}</span>}

      <span className="spacer" />

      <div className="turn__actions">
        <MessageActions
          text={text}
          busy={busy}
          info={<TurnInfo turn={turn} sessionKey={sessionKey} />}
          {...(firstSeq === undefined
            ? {}
            : {
                onRegenerate: () => {
                  onAction({ kind: 'regenerate', seq: firstSeq });
                },
              })}
          {...(lastSeq === undefined
            ? {}
            : {
                // After the answer: branching from a turn means continuing from
                // what it said, down a different path.
                onBranch: () => {
                  onAction({ kind: 'branch', seq: lastSeq });
                },
              })}
        />
      </div>
    </footer>
  );
}
