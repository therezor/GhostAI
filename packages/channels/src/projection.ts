/**
 * A turn, as a chat app has to render it.
 *
 * The hub speaks the same event stream to every consumer: deltas, tool calls,
 * notices, a `turn.end`. A browser renders all of it. A chat channel cannot —
 * it has one message shape, no card layout, and a rate limit — so something has
 * to decide which events become text and which are dropped. That decision is
 * here, once, rather than in each channel, because a channel that reimplements
 * it gets the two dangerous cases wrong: an approval request that nobody
 * renders makes the turn hang until it expires, and a stop reason that nobody
 * renders makes a truncated answer look like a complete one.
 *
 * The rules:
 *
 *  - **The server never keeps the answer for the client's benefit — except
 *    here.** A channel has no accumulator: it posts a message. So this holds
 *    the deltas for the length of a turn and emits one `reply` at `turn.end`.
 *    That is a per-session buffer bounded by one turn's output, which is the
 *    one place the protocol's "the client accumulates" rule cannot apply.
 *  - **`progress` carries the answer so far; `reply` carries the whole
 *    answer.** They overlap on purpose — a transport that edits in place wants
 *    exactly that — which is why a channel opts into `progress` by declaring it
 *    in `accepts`, and why the default is not to send it.
 *  - **Reasoning deltas are never projected.** A model's scratchpad arriving
 *    unasked in someone's chat app is a different product decision than showing
 *    it in a collapsible block a browser can collapse.
 *  - **A non-`complete` turn always says so.** A partial answer that reads as a
 *    final one is the failure this exists to prevent; `stopReason: 'error'` is
 *    the single exception, because the hub already broadcast the `error` event
 *    that explains it and saying it twice is not saying it better.
 */

import type { OutboundKind } from '@ghostai/core';
import type { ServerMessage, StopReason, ToolRisk } from '@ghostai/protocol';

/** One message the projection wants sent, before the manager addresses it. */
export interface OutboundDraft {
  readonly kind: OutboundKind;
  readonly text: string;
  /** Present for everything scoped to a turn, so a channel can group edits. */
  readonly turnId?: string;
  /**
   * Structured detail for a transport that can render more than a line of text.
   *
   * The text is always the whole message: a channel that ignores this renders
   * exactly what it rendered before, which is what lets an approval grow
   * buttons on Telegram without changing what the loopback channel says. The
   * manager copies it onto `OutboundMessage.metadata`.
   */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/**
 * `metadata.approval` on the draft an approval request produces.
 *
 * `args` is deliberately absent. It is `z.unknown()` — model-authored and
 * unbounded — and a channel that pasted it into a chat would be forwarding
 * whatever the model wrote to the one person whose judgement is the last check
 * on it. What a decision actually needs is the tool and its risk band; a
 * channel that wants a preview reads `tool.call` and caps it itself.
 */
export interface ApprovalDraftDetail {
  readonly callId: string;
  readonly name: string;
  readonly risk: ToolRisk;
  readonly expiresAtMs: number;
}

export interface TurnProjectionOptions {
  /** `channels.sendProgress`: the answer so far, at each tool boundary. */
  readonly sendProgress?: boolean;
  /** `channels.sendToolHints`: which tool is running, and which one failed. */
  readonly sendToolHints?: boolean;
}

/** What to say about a turn that did not simply finish. */
function stopNotice(
  stopReason: StopReason,
  hasAnswer: boolean,
): string | undefined {
  switch (stopReason) {
    case 'complete':
      // Rare, and worth a word: a turn whose whole output was tool calls looks
      // from a chat app exactly like a bot that ignored the message.
      return hasAnswer ? undefined : 'The turn finished without an answer.';
    case 'aborted':
      return 'Stopped.';
    case 'max_iterations':
      return 'Stopped: the turn reached its tool-iteration limit.';
    case 'wall_timeout':
      return 'Stopped: the turn reached its time limit.';
    case 'error':
      // The hub broadcast an `error` event before this; that one carries what
      // actually went wrong, and this one would only carry that it did.
      return undefined;
  }
}

/**
 * One session's live turn.
 *
 * Held by the manager per hub connection, which is per `(channel, session)`.
 * Nothing here is shared between sessions, so a slow channel cannot make one
 * session's accumulator show up in another's reply.
 */
export class TurnProjection {
  private readonly sendProgress: boolean;
  private readonly sendToolHints: boolean;
  /** The answer as it stands. Reset at each `turn.start`. */
  private answerText = '';
  private turnId: string | undefined;
  /** `callId` → tool name, so a failed result can be named. */
  private readonly tools = new Map<string, string>();

  constructor(options: TurnProjectionOptions = {}) {
    this.sendProgress = options.sendProgress ?? true;
    this.sendToolHints = options.sendToolHints ?? false;
  }

  /** The text accumulated for the running turn. Exposed for assertions. */
  get answer(): string {
    return this.answerText;
  }

  /**
   * What this event should say on a chat transport. Usually nothing.
   *
   * Exhaustive over `ServerMessage` on purpose: a protocol event added without
   * a decision here is a type error rather than an event a channel silently
   * never sees.
   */
  project(message: ServerMessage): readonly OutboundDraft[] {
    switch (message.type) {
      case 'turn.start':
        this.answerText = '';
        this.turnId = message.turnId;
        this.tools.clear();
        return [];

      case 'assistant.delta':
        this.answerText += message.text;
        return [];

      case 'tool.call': {
        this.tools.set(message.callId, message.name);
        const drafts: OutboundDraft[] = [];
        if (this.sendToolHints) {
          drafts.push(this.draft('notice', `Running ${message.name}…`));
        }
        // At a tool boundary rather than per delta: the bus queue is bounded,
        // and a message per token would fill it with a copy of the answer for
        // every token in it.
        if (this.sendProgress && this.answerText !== '') {
          drafts.push(this.draft('progress', this.answerText));
        }
        return drafts;
      }

      case 'tool.result': {
        if (!this.sendToolHints || message.ok) return [];
        const name = this.tools.get(message.callId) ?? 'a tool';
        return [this.draft('notice', `${name} failed.`)];
      }

      case 'tool.approvalRequest': {
        // Ungated, unlike the hints. Whether this can be answered where it
        // lands depends on the transport, and either way the turn is now
        // stopped until somebody says yes — saying so is the difference
        // between a wait and a mystery.
        //
        // The text names no particular place to answer. It used to say "in the
        // web UI", which was true only while nothing else could, and would go
        // on being shown by every channel that ignores the detail below.
        const approval: ApprovalDraftDetail = {
          callId: message.callId,
          name: message.name,
          risk: message.risk,
          expiresAtMs: message.expiresAtMs,
        };
        return [
          {
            kind: 'notice',
            text:
              `${message.name} needs approval before it can run. ` +
              'It is denied automatically if nobody answers.',
            ...this.turn(message.turnId),
            metadata: { approval },
          },
        ];
      }

      case 'notice':
        return [this.draft('notice', message.message)];

      /**
       * A subagent's turn, reduced to its two ends.
       *
       * The nested stream is deliberately *not* projected. A chat transport has
       * one channel for everything, so forwarding a subagent's deltas would
       * interleave its working-out with the answer the caller is composing —
       * and `#answerText` is a single accumulator, so they would literally be
       * concatenated. Saying nothing is no better: a delegation can run for a
       * minute, and a silent minute reads as a hung bot.
       *
       * So: one line when it starts, one when it ends, and nothing in between.
       * Both are gated on `sendToolHints`, because that is already the flag for
       * "tell me what the agent is doing, not only what it concluded".
       */
      case 'subagent.event': {
        if (!this.sendToolHints) return [];
        const who = message.label === '' ? message.agentId : message.label;
        if (message.event.type === 'turn.start') {
          return [this.draft('notice', `Asking ${who}…`)];
        }
        if (message.event.type === 'turn.end') {
          return [this.draft('notice', `${who} finished.`)];
        }
        return [];
      }

      case 'message.queued':
        return [
          this.draft(
            'notice',
            `Queued behind ${String(message.queueDepth)} message${message.queueDepth === 1 ? '' : 's'}.`,
          ),
        ];

      case 'error':
        return [
          {
            kind: 'error',
            text: message.message,
            ...this.turn(message.turnId),
          },
        ];

      case 'turn.end': {
        const answer = this.answerText;
        const drafts: OutboundDraft[] = [];
        if (answer !== '') {
          drafts.push({ kind: 'reply', text: answer, turnId: message.turnId });
        }
        const notice = stopNotice(message.stopReason, answer !== '');
        if (notice !== undefined) {
          drafts.push({ kind: 'notice', text: notice, turnId: message.turnId });
        }
        this.answerText = '';
        this.turnId = undefined;
        this.tools.clear();
        return drafts;
      }

      // Everything a chat transport has no way to render, and nothing it loses
      // by not seeing: the reasoning stream, the connection handshake, and the
      // bookkeeping a browser uses to reconcile its own optimistic state.
      //
      // `session.truncated` belongs here for a reason worth stating: a
      // regenerate or edit driven from another client rewrites a transcript,
      // and a chat transport has none — the messages it already delivered are
      // in someone's message history, where nothing can recall them. The retry
      // simply arrives as another answer.
      case 'reasoning.delta':
      case 'tool.progress':
      case 'connected':
      case 'pong':
      case 'message.ack':
      case 'session.status':
      case 'session.reset':
      case 'session.replay':
      case 'session.truncated':
      case 'notification':
      case 'tools.changed':
      case 'steer':
        return [];
    }
  }

  private draft(kind: OutboundKind, text: string): OutboundDraft {
    return { kind, text, ...this.turn(undefined) };
  }

  /** The turn id from the event when it carries one, else the running turn's. */
  private turn(turnId: string | undefined): { turnId?: string } {
    const id = turnId ?? this.turnId;
    return id === undefined ? {} : { turnId: id };
  }
}
