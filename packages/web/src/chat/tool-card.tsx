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

import { AlertCircle, CheckCircle2, ChevronRight, Loader2, Terminal, Wrench } from 'lucide-react';
import { useEffect, useId, useState, type JSX } from 'react';
import { useTranslation } from 'react-i18next';

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
  const { t } = useTranslation();
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
      className={cn('tool-card', tool.status === 'awaiting-approval' && 'tool-card--awaiting')}
    >
      <h4 className="contents">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => {
            setOpen((value) => !value);
          }}
          className="tool-card__header"
        >
          <ChevronRight
            className={cn(
              'tool-card__chevron disclosure-chevron',
              open && 'disclosure-chevron--open',
            )}
          />
          <StatusIcon status={tool.status} />
          <span className="tool-card__name">{tool.name}</span>
          {/* Labelled, because a pill reading `exec` is cryptic on its own —
              and because the band and the tool are often the same word. */}
          <Badge tone={risk.tone} aria-label={`Risk: ${risk.label}`}>
            {risk.label}
          </Badge>

          {summary !== '' && <span className="tool-card__summary truncate">{summary}</span>}

          <span className="tool-card__timing">
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
        <div className="stack tool-card__notices">
          {tool.notices.map((notice) => (
            <Notice key={notice.id} kind={notice.notice} message={notice.message} />
          ))}
        </div>
      )}

      {/* Mounted only while open, rather than hidden. A conversation with
          thirty calls in it would otherwise carry thirty tool outputs — some of
          them tens of kilobytes — in the DOM to render nothing. */}
      {open && (
        <div id={bodyId} className="stack tool-card__body">
          {summary !== '' && (
            <Labelled label={t('tool.arguments')}>
              <pre className="tool-card__pre">{formatArgs(tool.args)}</pre>
            </Labelled>
          )}

          {tool.content !== undefined && (
            <Labelled label={tool.status === 'error' ? 'Error' : 'Output'}>
              <Output content={tool.content} terminal={tool.name === 'exec'} />
              {tool.truncated && <p className="tool-card__note">{t('tool.truncated')}</p>}
            </Labelled>
          )}

          {tool.content === undefined && tool.status === 'running' && (
            <p className="tool-card__running">{t('tool.running')}</p>
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
    <div className="stack tool-card__field">
      <span className="tool-card__label">{label}</span>
      {children}
    </div>
  );
}

/** `exec` output is a terminal; everything else is a code block. */
function Output({
  content,
  terminal,
}: {
  readonly content: string;
  readonly terminal: boolean;
}): JSX.Element {
  return (
    <pre
      className={cn('tool-card__pre tool-card__output', terminal && 'tool-card__output--terminal')}
    >
      {content === '' ? <span className="tool-card__empty">(no output)</span> : content}
    </pre>
  );
}

function StatusIcon({ status }: { readonly status: ToolPart['status'] }): JSX.Element {
  const { t } = useTranslation();
  switch (status) {
    case 'running':
      return (
        <Loader2
          className="tool-card__status tool-card__status--running"
          aria-label={t('tool.runningLabel')}
        />
      );
    case 'awaiting-approval':
      return (
        <Terminal
          className="tool-card__status tool-card__status--awaiting"
          aria-label={t('tool.needsApproval')}
        />
      );
    case 'ok':
      return (
        <CheckCircle2
          className="tool-card__status tool-card__status--ok"
          aria-label={t('tool.succeeded')}
        />
      );
    case 'error':
      return (
        <AlertCircle
          className="tool-card__status tool-card__status--error"
          aria-label={t('tool.failed')}
        />
      );
    default:
      return <Wrench className="tool-card__status" />;
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
