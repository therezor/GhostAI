/**
 * The reasoning block.
 *
 * Collapsed by default and never in the answer's own typography. Reasoning is
 * the model thinking out loud — it contradicts itself, abandons approaches and
 * is explicitly not a commitment — and rendering it in the same voice as the
 * answer invites it to be read as one. Smaller, dimmer, behind a disclosure,
 * and available to anyone who wants to know how the answer was reached.
 *
 * It auto-expands while it is the only thing arriving, because a turn that
 * spends thirty seconds reasoning before its first token would otherwise show
 * an empty bubble and a spinner. The moment answer text starts, it collapses
 * again on its own.
 */

import { Brain, ChevronRight } from 'lucide-react';
import { useEffect, useId, useState, type JSX } from 'react';

import { cn } from '@/lib/cn.js';

export interface ReasoningBlockProps {
  readonly text: string;
  /** True while this is the newest thing on a turn that has produced no answer yet. */
  readonly live?: boolean;
}

export function ReasoningBlock({ text, live = false }: ReasoningBlockProps): JSX.Element {
  const [open, setOpen] = useState(live);
  const [pinned, setPinned] = useState(false);
  const bodyId = useId();

  // Follows `live` until the reader takes over. Without the pin, a click to
  // keep it open would be undone by the first answer token.
  useEffect(() => {
    if (!pinned) setOpen(live);
  }, [live, pinned]);

  return (
    <div className="rounded-md border border-line bg-surface-1">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => {
          setPinned(true);
          setOpen((value) => !value);
        }}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs text-fg-3 hover:bg-hover hover:text-fg-2"
      >
        <ChevronRight
          className={cn('size-3.5 shrink-0 transition-transform', open && 'rotate-90')}
        />
        <Brain className="size-3.5 shrink-0" />
        <span>Reasoning</span>
        {live && <span className="ml-auto animate-pulse">thinking…</span>}
      </button>

      <div
        id={bodyId}
        hidden={!open}
        // Plain text, not markdown: reasoning is a stream of consciousness that
        // frequently opens a fence it never closes, and a renderer that took it
        // seriously would swallow the rest of the block into a code element.
        className="border-t border-line px-3 py-2 text-sm whitespace-pre-wrap text-fg-3"
      >
        {text}
      </div>
    </div>
  );
}
