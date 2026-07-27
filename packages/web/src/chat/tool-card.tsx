/**
 * A tool call, as a card.
 *
 * What the card has to answer, in the order a reader asks it: what is being
 * run, how dangerous the system considers it, whether it is still going, and
 * what it produced. Everything else — the full arguments, the whole output — is
 * behind a disclosure, because a turn that made six calls should not be six
 * screens of JSON before the answer.
 *
 * Three decisions:
 *
 *  - **The elapsed counter ticks locally.** `tool.progress` arrives every 15
 *    seconds, which is a fine heartbeat and a terrible clock: a card that
 *    updates four times a minute looks frozen for the fourteen seconds in
 *    between, which is exactly the impression the heartbeat exists to prevent.
 *    The server's figure is the floor; the local timer fills the gaps.
 *  - **`exec` output gets a terminal, everything else gets a code block.** The
 *    distinction is real — `exec` output is interleaved stdout and stderr with
 *    ANSI-era conventions and meaningful trailing whitespace, and rendering it
 *    the way a file read is rendered loses the shape of it.
 *  - **The nonce envelope is never shown.** `tool.result` carries the tool's own
 *    output, and stored history is unwrapped in `transcript.ts`. The delimiters
 *    are a defence aimed at the model; showing them would be showing the reader
 *    the machinery instead of the answer.
 */

import {
  AlertCircle,
  CheckCircle2,
  ChevronRight,
  Loader2,
  Terminal,
  Wrench,
} from 'lucide-react';
import { useEffect, useId, useState, type JSX } from 'react';

import type { ApprovalScope, ToolRisk } from '@ghostai/protocol';

import { cn } from '@/lib/cn.js';
import { formatArgs, formatDuration, summariseArgs } from '@/lib/format.js';
import { Badge, type BadgeProps } from '@/components/ui/badge.js';
import type { ToolPart } from '@/state/transcript.js';
import { ApprovalPrompt } from './approval.js';
import { Notice } from './notice.js';

/**
 * How loud each risk band is.
 *
 * `exec` and `network` are the two an operator of a self-hosted agent actually
 * wants to see before they happen — which is also why they are the two whose
 * default policy is `ask` — so they get the two loudest tones.
 */
const RISK: Record<ToolRisk, { readonly label: string; readonly tone: BadgeProps['tone'] }> = {
  safe: { label: 'read', tone: 'neutral' },
  write: { label: 'write', tone: 'info' },
  exec: { label: 'exec', tone: 'danger' },
  network: { label: 'network', tone: 'warning' },
};

export interface ToolCardProps {
  readonly tool: ToolPart;
  readonly onApprove: (callId: string, approved: boolean, scope: ApprovalScope) => void;
}

export function ToolCard({ tool, onApprove }: ToolCardProps): JSX.Element {
  // Open by default while a decision is needed: an approval prompt inside a
  // collapsed card is a turn that has silently stopped.
  const [open, setOpen] = useState(tool.status === 'awaiting-approval');
  const bodyId = useId();
  const elapsedMs = useElapsed(tool.status === 'running', tool.elapsedMs);
  const risk = RISK[tool.risk];

  const summary = summariseArgs(tool.args);

  return (
    <section
      // Named, which makes it a landmark: a screen-reader user navigating a
      // turn with six calls in it can move between them instead of reading
      // through them.
      aria-label={`Tool call: ${tool.name}`}
      className={cn(
        'overflow-hidden rounded-md border bg-surface-2',
        tool.status === 'awaiting-approval' ? 'border-warning-fg/40' : 'border-line',
      )}
    >
      <h4 className="contents">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => {
            setOpen((value) => !value);
          }}
          className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left hover:bg-hover"
        >
          <ChevronRight
            className={cn('size-3.5 shrink-0 text-fg-3 transition-transform', open && 'rotate-90')}
          />
          <StatusIcon status={tool.status} />
          <span className="font-mono text-sm text-fg-1">{tool.name}</span>
          {/* Labelled, because a pill reading `exec` is cryptic on its own —
              and because the band and the tool are often the same word. */}
          <Badge tone={risk.tone} aria-label={`Risk: ${risk.label}`}>
            {risk.label}
          </Badge>

          {summary !== '' && (
            <span className="min-w-0 truncate font-mono text-2xs text-fg-3">{summary}</span>
          )}

          <span className="ml-auto shrink-0 tabular-nums text-2xs text-fg-3">
            {tool.status === 'running' && formatDuration(elapsedMs)}
            {tool.status === 'awaiting-approval' && 'waiting for you'}
            {tool.durationMs !== undefined && formatDuration(tool.durationMs)}
          </span>
        </button>
      </h4>

      {tool.approval !== undefined && (
        <ApprovalPrompt
          toolName={tool.name}
          approval={tool.approval}
          onAnswer={(approved, scope) => {
            onApprove(tool.id, approved, scope);
          }}
        />
      )}

      {tool.notices.length > 0 && (
        <div className="flex flex-col gap-1.5 px-2.5 py-2">
          {tool.notices.map((notice) => (
            <Notice key={notice.id} kind={notice.notice} message={notice.message} />
          ))}
        </div>
      )}

      {/* Mounted only while open, rather than hidden. A conversation with
          thirty calls in it would otherwise carry thirty tool outputs — some of
          them tens of kilobytes — in the DOM to render nothing. */}
      {open && (
        <div id={bodyId} className="flex flex-col gap-2 border-t border-line p-2.5">
          {summary !== '' && (
            <Labelled label="Arguments">
              <pre className="overflow-x-auto rounded-xs bg-surface-1 p-2 font-mono text-2xs text-fg-2">
                {formatArgs(tool.args)}
              </pre>
            </Labelled>
          )}

          {tool.content !== undefined && (
            <Labelled label={tool.status === 'error' ? 'Error' : 'Output'}>
              <Output content={tool.content} terminal={tool.name === 'exec'} />
              {tool.truncated && (
                <p className="mt-1 text-2xs text-fg-3">
                  Output was truncated in the middle to fit the tool-output budget. The model saw
                  the same thing.
                </p>
              )}
            </Labelled>
          )}

          {tool.content === undefined && tool.status === 'running' && (
            <p className="text-xs text-fg-3">Running…</p>
          )}
        </div>
      )}
    </section>
  );
}

function Labelled({
  label,
  children,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
}): JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-2xs font-medium tracking-wide text-fg-3 uppercase">{label}</span>
      {children}
    </div>
  );
}

/**
 * `exec` output is a terminal; everything else is a code block.
 *
 * `whitespace-pre-wrap` rather than `pre`: a command that printed a 300-column
 * table should wrap rather than force the whole card to scroll sideways, and
 * `break-words` is what stops one unbroken token doing the same.
 */
function Output({
  content,
  terminal,
}: {
  readonly content: string;
  readonly terminal: boolean;
}): JSX.Element {
  return (
    <pre
      className={cn(
        'max-h-80 overflow-auto rounded-xs p-2 font-mono text-2xs whitespace-pre-wrap break-words',
        terminal ? 'bg-surface-0 text-fg-2' : 'bg-surface-1 text-fg-2',
      )}
    >
      {content === '' ? <span className="text-fg-3">(no output)</span> : content}
    </pre>
  );
}

function StatusIcon({ status }: { readonly status: ToolPart['status'] }): JSX.Element {
  switch (status) {
    case 'running':
      return <Loader2 className="size-3.5 shrink-0 animate-spin text-fg-3" aria-label="Running" />;
    case 'awaiting-approval':
      return <Terminal className="size-3.5 shrink-0 text-warning-fg" aria-label="Needs approval" />;
    case 'ok':
      return <CheckCircle2 className="size-3.5 shrink-0 text-success-fg" aria-label="Succeeded" />;
    case 'error':
      return <AlertCircle className="size-3.5 shrink-0 text-danger-fg" aria-label="Failed" />;
    default:
      return <Wrench className="size-3.5 shrink-0 text-fg-3" />;
  }
}

/**
 * Elapsed milliseconds, ticking while `active`.
 *
 * `floorMs` is the server's last heartbeat, and it wins whenever it is ahead —
 * a tab that was backgrounded had its timers throttled, and the server's figure
 * is the true one.
 */
function useElapsed(active: boolean, floorMs: number): number {
  const [startedAtMs] = useState(() => Date.now());
  const [nowMs, setNowMs] = useState(startedAtMs);

  useEffect(() => {
    if (!active) return undefined;
    const timer = setInterval(() => {
      setNowMs(Date.now());
    }, 1000);
    return () => {
      clearInterval(timer);
    };
  }, [active]);

  return Math.max(nowMs - startedAtMs, floorMs);
}
