/**
 * The transcript: what the socket's events mean, as a shape React can render.
 *
 * This file is pure — no store, no React, no clock. `applyServerMessage` takes
 * a transcript and one frame and returns the next transcript, and
 * `fromStoredMessages` turns a REST or replay history into the same shape. The
 * store in `turn.ts` is a thin holder over both, which is what lets the
 * interesting behaviour — a delta landing on the right part, a tool result
 * finding its card, a reload rebuilding a half-finished turn — be tested
 * without mounting anything.
 *
 * The model is two levels deep and no deeper:
 *
 *  - A **transcript** is a flat list of items in arrival order: what the user
 *    said, what a turn produced, a mid-turn steer, a notice that belongs to no
 *    turn.
 *  - A **turn** is a list of parts, also in arrival order: text, reasoning, a
 *    tool call, a notice. Parts are ordered because they interleave — a model
 *    that writes a sentence, calls a tool, and writes another sentence must
 *    render in that order, and a shape with `text` and `tools[]` as separate
 *    fields cannot express it.
 *
 * Two rules are load-bearing:
 *
 *  - **A notice carrying a `callId` belongs inside that tool's card.**
 *    `prompt_injection` and `approval_denied` are statements *about a call*, and
 *    floating them to the bottom of the turn separates the warning from the
 *    output it is warning about.
 *  - **The nonce envelope is never rendered.** `tool.result` already carries the
 *    tool's own output, but stored history carries the wrapped form, so
 *    `fromStoredMessages` unwraps it. The delimiters are a defence aimed at the
 *    model; showing them to a user would be showing them the machinery.
 */

import type {
  Attachment,
  ContentPart,
  ErrorCode,
  NoticeKind,
  ServerMessage,
  StopReason,
  StoredMessage,
  ToolRisk,
  Usage,
} from '@ghostai/protocol';

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export interface UserItem {
  readonly kind: 'user';
  /**
   * Stable for the life of the item, and unique across the transcript.
   *
   * The client's id for a message this tab sent, the stored row id for one it
   * fetched — and deliberately *not* the turn id, which the ack also carries.
   * Every item in the transcript is a React key, and a user bubble that renamed
   * itself to the turn id would collide with the turn that turn id belongs to.
   */
  readonly id: string;
  readonly clientMessageId: string | undefined;
  /**
   * The turn this message started, once it is known.
   *
   * This is how an optimistic bubble is recognised as the *same message* the
   * REST history later returns under a different row id — `message.ack` carries
   * the turn id, and every stored message the turn produced carries it too. It
   * is the only key the two sources share, and without it a reload after
   * sending shows the message twice.
   */
  readonly turnId: string | undefined;
  /**
   * Storage's address for this message, once it has one.
   *
   * What Edit, Regenerate and Branch name. `undefined` on an optimistic bubble
   * that storage has not answered for yet, which is exactly when those actions
   * must stay disabled — and `turn.end` fills it in the moment the turn
   * finishes, so a message becomes editable without a refetch.
   */
  readonly seq: number | undefined;
  readonly text: string;
  readonly attachments: readonly Attachment[];
  /** True until the ack lands — the bubble that has not been accepted yet. */
  readonly pending: boolean;
}

export interface TextPart {
  readonly kind: 'text';
  readonly id: string;
  readonly text: string;
}

export interface ReasoningPart {
  readonly kind: 'reasoning';
  readonly id: string;
  readonly text: string;
}

export interface NoticePart {
  readonly kind: 'notice';
  readonly id: string;
  readonly notice: NoticeKind;
  readonly message: string;
}

/**
 * `awaiting-approval` is a status rather than a flag on `running`, because it is
 * the one state where nothing is happening and the user is the reason.
 */
export type ToolStatus = 'running' | 'awaiting-approval' | 'ok' | 'error';

export interface ToolApprovalState {
  readonly expiresAtMs: number;
  /**
   * Set once *this tab* answered. The card stops offering buttons immediately
   * rather than waiting for the round trip, and a second tab that answered
   * first simply sees the result arrive.
   */
  readonly answered: 'approved' | 'denied' | undefined;
}

export interface ToolPart {
  readonly kind: 'tool';
  /** The `callId`. Unique per turn, and the key every later event pairs on. */
  readonly id: string;
  readonly name: string;
  readonly args: unknown;
  readonly risk: ToolRisk;
  readonly status: ToolStatus;
  /** Last figure from `tool.progress`; the card ticks past it locally. */
  readonly elapsedMs: number;
  readonly durationMs: number | undefined;
  /** The tool's own output, unwrapped. Undefined until the result arrives. */
  readonly content: string | undefined;
  readonly truncated: boolean;
  readonly approval: ToolApprovalState | undefined;
  /** Notices scoped to this call, rendered in the card. */
  readonly notices: readonly NoticePart[];
}

export type TurnPart = TextPart | ReasoningPart | NoticePart | ToolPart;

export interface TurnFailure {
  readonly code: ErrorCode;
  readonly message: string;
  readonly retryable: boolean;
}

export interface TurnItem {
  readonly kind: 'turn';
  /** The `turnId`. */
  readonly id: string;
  readonly model: string;
  readonly provider: string;
  readonly parts: readonly TurnPart[];
  readonly stopReason: StopReason | undefined;
  readonly usage: Usage | undefined;
  readonly iterations: number;
  /** Wall time for the whole turn — the divisor behind the tokens/s figure. */
  readonly elapsedMs: number | undefined;
  /**
   * The seqs this turn spans: the user message that started it, and the last
   * message it wrote. `firstSeq` is what Regenerate re-runs from and what
   * Branch forks at.
   */
  readonly firstSeq: number | undefined;
  readonly lastSeq: number | undefined;
  /** False while the turn is streaming — what drives the caret and the spinner. */
  readonly done: boolean;
  readonly failure: TurnFailure | undefined;
}

export interface SteerItem {
  readonly kind: 'steer';
  readonly id: string;
  readonly text: string;
}

/** A notice that named no turn — a connection-level report, not a turn's. */
export interface NoticeItem {
  readonly kind: 'notice';
  readonly id: string;
  readonly notice: NoticeKind;
  readonly message: string;
}

export type TranscriptItem = UserItem | TurnItem | SteerItem | NoticeItem;

export type Transcript = readonly TranscriptItem[];

export const EMPTY_TRANSCRIPT: Transcript = [];

// ---------------------------------------------------------------------------
// Building
// ---------------------------------------------------------------------------

/**
 * The bubble that appears the instant Send is pressed.
 *
 * Optimistic on purpose: the round trip to `message.ack` is short but not zero,
 * and a composer that clears while the transcript stays still for 80 ms reads as
 * a message that went nowhere. `pending` is what the ack clears.
 */
export function appendPendingUserMessage(
  items: Transcript,
  input: {
    readonly clientMessageId: string;
    readonly text: string;
    readonly attachments?: readonly Attachment[];
  },
): Transcript {
  return [
    ...items,
    {
      kind: 'user',
      id: input.clientMessageId,
      clientMessageId: input.clientMessageId,
      turnId: undefined,
      seq: undefined,
      text: input.text,
      attachments: input.attachments ?? [],
      pending: true,
    },
  ];
}

/**
 * One frame onto the transcript.
 *
 * Exhaustive over `ServerMessage`, so a protocol event added without a decision
 * here is a type error rather than a frame that silently does nothing. The
 * events that are not transcript events — `connected`, `pong`, `session.status`
 * — return the transcript unchanged; the store reads those for connection and
 * busy state.
 */
export function applyServerMessage(items: Transcript, message: ServerMessage): Transcript {
  // A turn that has already finished never grows again. The case this exists
  // for is a reload: the client resumes from its cursor and the ring re-sends
  // the tail of a turn that was persisted in the meantime, so the same text
  // would arrive once from storage and once as deltas.
  if (growsATurn(message) && isFinished(items, message.turnId)) return items;

  switch (message.type) {
    case 'message.ack':
      return acknowledge(items, message.messageId, message.clientMessageId);

    case 'turn.start':
      // A `turn.start` for a turn already in the transcript is a replayed
      // frame, not a second turn — the ring re-sends by design, and appending
      // would leave an empty turn above the real one for every resume.
      return items.some((item) => item.kind === 'turn' && item.id === message.turnId)
        ? items
        : [
            ...items,
            {
              kind: 'turn',
              id: message.turnId,
              model: message.model,
              provider: message.provider,
              parts: [],
              stopReason: undefined,
              usage: undefined,
              iterations: 0,
              elapsedMs: undefined,
              firstSeq: undefined,
              lastSeq: undefined,
              done: false,
              failure: undefined,
            },
          ];

    case 'assistant.delta':
      return appendText(items, message.turnId, 'text', message.text);

    case 'reasoning.delta':
      return appendText(items, message.turnId, 'reasoning', message.text);

    case 'tool.call':
      return updateTurn(items, message.turnId, (turn) =>
        // A `tool.call` for a call already on the turn is a replayed frame, not
        // a second call: the ids are unique per turn and the ring re-sends.
        findTool(turn, message.callId) !== undefined
          ? turn
          : {
              ...turn,
              parts: [
                ...turn.parts,
                {
                  kind: 'tool',
                  id: message.callId,
                  name: message.name,
                  args: message.args,
                  risk: message.risk,
                  status: 'running',
                  elapsedMs: 0,
                  durationMs: undefined,
                  content: undefined,
                  truncated: false,
                  approval: undefined,
                  notices: [],
                },
              ],
            },
      );

    case 'tool.progress':
      return updateTool(items, message.turnId, message.callId, (tool) => ({
        ...tool,
        // Monotonic: a replayed heartbeat must not wind the counter back.
        elapsedMs: Math.max(tool.elapsedMs, message.elapsedMs),
      }));

    case 'tool.approvalRequest':
      return updateTool(items, message.turnId, message.callId, (tool) => ({
        ...tool,
        status: 'awaiting-approval',
        approval: { expiresAtMs: message.expiresAtMs, answered: undefined },
      }));

    case 'tool.result':
      return updateTool(items, message.turnId, message.callId, (tool) => ({
        ...tool,
        status: message.ok ? 'ok' : 'error',
        // The tool's own output. The stored copy is wrapped in the turn's nonce
        // envelope; this one deliberately is not.
        content: message.content,
        truncated: message.truncated,
        durationMs: message.durationMs,
        approval: undefined,
      }));

    case 'notice':
      return applyNotice(items, message);

    case 'turn.end': {
      const ended = updateTurn(items, message.turnId, (turn) => ({
        ...turn,
        done: true,
        stopReason: message.stopReason,
        usage: message.usage,
        iterations: message.iterations,
        elapsedMs: message.elapsedMs,
        firstSeq: message.firstSeq,
        lastSeq: message.lastSeq,
      }));

      // The second half of the job, and the reason `firstSeq` is on the wire at
      // all: the bubble this tab drew optimistically has no storage address, so
      // until the turn ends it cannot be edited, regenerated or branched. One
      // number here is what a refetch would otherwise have to supply — and a
      // refetch would also replace the live turn's tool timings with stored
      // rows that do not carry them.
      if (message.firstSeq === undefined) return ended;
      const seq = message.firstSeq;
      return ended.map((item) =>
        item.kind === 'user' && item.turnId === message.turnId && item.seq === undefined
          ? { ...item, seq }
          : item,
      );
    }

    case 'error':
      // A connection-scoped error is not a transcript entry — `connection.ts`
      // raises a toast for it. A turn-scoped one belongs on the turn it killed.
      return message.turnId === undefined
        ? items
        : updateTurn(items, message.turnId, (turn) => ({
            ...turn,
            done: true,
            failure: {
              code: message.code,
              message: message.message,
              retryable: message.retryable,
            },
          }));

    case 'steer':
      return [
        ...items,
        { kind: 'steer', id: `steer:${String(message.seq)}`, text: message.content },
      ];

    case 'session.reset':
      return EMPTY_TRANSCRIPT;

    case 'session.replay':
      // Two answers, and `complete` is which one this is. Covered by the ring:
      // the frames themselves follow, so there is nothing to rebuild. Past it:
      // the stored tail is the transcript, and the live frames resume on top.
      return message.complete ? items : fromStoredMessages(message.messages);

    case 'session.truncated':
      // The frame carries the surviving tail, so this is a rebuild rather than
      // a splice — and it is the same rebuild `session.replay` does past the
      // ring. A tab that did not initiate the regenerate corrects itself here.
      return fromStoredMessages(message.messages);

    case 'connected':
    case 'pong':
    case 'message.queued':
    case 'session.status':
    case 'notification':
    case 'transcribe.result':
    case 'tools.changed':
      return items;
  }
}

/** Records this tab's answer, so the buttons go away before the round trip. */
export function markApprovalAnswered(
  items: Transcript,
  callId: string,
  answered: 'approved' | 'denied',
): Transcript {
  return items.map((item) => {
    if (item.kind !== 'turn') return item;
    const tool = findTool(item, callId);
    if (tool?.approval === undefined) return item;

    return {
      ...item,
      parts: item.parts.map((part) =>
        part === tool
          ? { ...tool, approval: { expiresAtMs: tool.approval?.expiresAtMs ?? 0, answered } }
          : part,
      ),
    };
  });
}

/**
 * Events that add to a turn's parts, as opposed to describing or closing it.
 *
 * `turn.end` is deliberately absent: replaying it onto a turn that is already
 * closed is idempotent, and refusing it would leave a turn open forever if the
 * only copy of its ending arrived on a replay.
 */
const GROWTH_EVENTS: ReadonlySet<string> = new Set([
  'assistant.delta',
  'reasoning.delta',
  'tool.call',
  'tool.progress',
  'tool.approvalRequest',
  'tool.result',
  'notice',
]);

function growsATurn(
  message: ServerMessage,
): message is Extract<ServerMessage, { turnId?: string }> & { turnId: string } {
  return (
    GROWTH_EVENTS.has(message.type) && 'turnId' in message && typeof message.turnId === 'string'
  );
}

function isFinished(items: Transcript, turnId: string): boolean {
  const turn = items.findLast((item) => item.kind === 'turn' && item.id === turnId);
  return turn?.kind === 'turn' && turn.done;
}

// ---------------------------------------------------------------------------
// Stored history
// ---------------------------------------------------------------------------

/**
 * The nonce envelope, as the agent writes it.
 *
 * Duplicated from `packages/security/src/nonce.ts` rather than imported: that
 * package is Node — `node:crypto`, the workspace jail, the vault — and pulling
 * it into a browser bundle for one delimiter would be a far worse trade than
 * restating the pattern. `transcript.test.ts` pins the exact shape.
 */
const TOOL_OUTPUT_ENVELOPE =
  /^<tool_output_([0-9a-f]{8,})\b[^>]*>\n([\s\S]*)\n<\/tool_output_\1>$/i;

/**
 * The tool's own output, out of the envelope the model saw it in.
 *
 * Content that is not an envelope is returned untouched — a tool message stored
 * before the wrapping existed, or one that failed before it was wrapped, is
 * still a tool message worth rendering.
 */
export function unwrapToolOutput(content: string): string {
  const match = TOOL_OUTPUT_ENVELOPE.exec(content);
  if (match?.[2] === undefined) return content;

  // `wrapToolOutput` escapes any delimiter the content itself contained, so
  // that a tool cannot appear to close the envelope early. Undoing it here is
  // what stops a backslash appearing in the rendered output.
  return match[2].replace(/<\\(\/?)tool_output_/gi, '<$1tool_output_');
}

/**
 * A fetched history under whatever the socket has already built on top of it.
 *
 * The two arrive in either order and neither can wait for the other: the REST
 * request and the WebSocket handshake are started in the same tick, and on a
 * reload the replay of an in-flight turn routinely beats the fetch of the
 * conversation it belongs to. Replacing the transcript would discard the turn
 * the user is watching; appending would render every completed message twice.
 *
 * So it is a merge, keyed on id: the stored history is the base, and anything
 * live that storage has not caught up with keeps its place after it.
 */
export function mergeStoredHistory(
  existing: Transcript,
  messages: readonly StoredMessage[],
): Transcript {
  const base = withLiveRiskBands(fromStoredMessages(messages), existing);

  const ids = new Set(base.map((item) => item.id));
  // The second key, and the one that does the real work: a message sent a
  // moment ago is in the transcript under the turn id the ack gave it and in
  // storage under a row id nothing on the client has ever seen. The turn id is
  // all they share.
  const turns = new Set(
    base.flatMap((item) =>
      item.kind === 'user' && item.turnId !== undefined ? [item.turnId] : [],
    ),
  );

  const merged: TranscriptItem[] = [...base];
  for (const item of existing) {
    if (ids.has(item.id)) continue;
    if (item.kind === 'user' && item.turnId !== undefined && turns.has(item.turnId)) continue;
    // Deduping against what has already been kept, not only against the base,
    // makes this idempotent — and the history query can resolve more than once.
    ids.add(item.id);
    if (item.kind === 'user' && item.turnId !== undefined) turns.add(item.turnId);
    merged.push(item);
  }

  return merged;
}

/**
 * Puts back the one thing storage cannot remember.
 *
 * A stored tool call has no risk band: the band was a property of the registry
 * at call time, and the row holds the model's arguments and the result. So
 * `fromStoredMessages` fills in `safe`, which is the honest answer for a
 * conversation loaded fresh — and the wrong one for a call this tab watched
 * happen. Without this, an `exec` the user was asked to approve is relabelled
 * `read` the instant its turn lands in the database, which is the badge
 * changing its mind about how dangerous something was after the fact.
 *
 * Keyed on the call id, which the socket and the row genuinely share — unlike
 * the message id, which is why `mergeStoredHistory` needs a second key at all.
 */
function withLiveRiskBands(base: Transcript, existing: Transcript): Transcript {
  const bands = new Map<string, ToolRisk>();
  for (const item of existing) {
    if (item.kind !== 'turn') continue;
    for (const part of item.parts) {
      if (part.kind === 'tool') bands.set(part.id, part.risk);
    }
  }
  if (bands.size === 0) return base;

  return base.map((item) => {
    if (item.kind !== 'turn') return item;
    return {
      ...item,
      parts: item.parts.map((part) => {
        if (part.kind !== 'tool') return part;
        const risk = bands.get(part.id);
        return risk === undefined ? part : { ...part, risk };
      }),
    };
  });
}

/**
 * A stored history as a transcript.
 *
 * The grouping key is `turnId`: one user message and everything the turn
 * produced, however many provider iterations it took. A stored message with no
 * `turnId` — written before turns were grouped, or by a channel that did not
 * set one — falls back to its own id, which renders it as a turn of one.
 */
export function fromStoredMessages(messages: readonly StoredMessage[]): Transcript {
  const items: TranscriptItem[] = [];

  // The seqs each turn spans, keyed the same way `openTurn` keys the turn
  // itself. Collected up front because a turn's first seq belongs to the *user*
  // message that started it, which the loop below has already passed by the
  // time it opens the turn.
  const spans = new Map<string, { first: number; last: number }>();
  for (const stored of messages) {
    const key = stored.turnId ?? stored.id;
    const span = spans.get(key);
    spans.set(
      key,
      span === undefined
        ? { first: stored.seq, last: stored.seq }
        : { first: Math.min(span.first, stored.seq), last: Math.max(span.last, stored.seq) },
    );
  }

  for (const stored of messages) {
    const { message } = stored;

    switch (message.role) {
      // Never rendered. It is the agent's instructions, not the conversation.
      case 'system':
        continue;

      case 'user':
        items.push({
          kind: 'user',
          id: stored.id,
          clientMessageId: undefined,
          turnId: stored.turnId,
          seq: stored.seq,
          text: textOf(message.content),
          attachments: attachmentsOf(message.content),
          pending: false,
        });
        continue;

      case 'assistant': {
        const turn = openTurn(items, stored.turnId ?? stored.id);
        const parts: TurnPart[] = [...turn.parts];

        if (message.reasoning !== undefined && message.reasoning !== '') {
          parts.push({
            kind: 'reasoning',
            id: `${turn.id}#${String(parts.length)}`,
            text: message.reasoning,
          });
        }

        const text = textOf(message.content);
        if (text !== '') {
          parts.push({ kind: 'text', id: `${turn.id}#${String(parts.length)}`, text });
        }

        for (const call of message.toolCalls) {
          parts.push({
            kind: 'tool',
            id: call.id,
            name: call.name,
            // The stored form is the verbatim string the model emitted, which
            // is not always JSON. The card renders whichever it turns out to be.
            args: parseArgs(call.argumentsJson),
            // Stored history does not carry the risk band — it was a property of
            // the registry at call time. `safe` is the honest answer, and the
            // result beside it is what the reader is actually looking at.
            risk: 'safe',
            status: 'running',
            elapsedMs: 0,
            durationMs: undefined,
            content: undefined,
            truncated: false,
            approval: undefined,
            notices: [],
          });
        }

        replaceLast(items, { ...turn, parts, done: true });
        continue;
      }

      case 'tool': {
        // The result pairs with the call by id, wherever that call ended up:
        // `findLegalStart` guarantees the assistant turn that made it is in the
        // same history, but not that it is in the last item.
        const index = items.findLastIndex(
          (item) => item.kind === 'turn' && findTool(item, message.toolCallId) !== undefined,
        );
        const turn = items[index];
        if (turn?.kind !== 'turn') continue;

        items[index] = {
          ...turn,
          parts: turn.parts.map((part) =>
            part.kind === 'tool' && part.id === message.toolCallId
              ? {
                  ...part,
                  status: message.isError ? 'error' : 'ok',
                  content: unwrapToolOutput(message.content),
                  truncated: message.truncated,
                }
              : part,
          ),
        };
        continue;
      }
    }
  }

  return items.map((item) =>
    item.kind === 'turn'
      ? { ...item, firstSeq: spans.get(item.id)?.first, lastSeq: spans.get(item.id)?.last }
      : item,
  );
}

/**
 * Drops every item after `seq`, for the moment between asking and being told.
 *
 * Purely a flicker guard. The `session.truncated` frame that follows a
 * regenerate or an edit is the truth and rebuilds the transcript from the
 * stored tail a few milliseconds later; without this, the answer being
 * discarded stays on screen until it does.
 *
 * Items with no seq — an optimistic bubble, a steer, a connection notice — are
 * kept only while they precede the cut, because an item that has no address
 * cannot be shown to be on the surviving side of one.
 */
export function truncateTranscriptAfter(items: Transcript, seq: number): Transcript {
  const kept: TranscriptItem[] = [];

  for (const item of items) {
    const address =
      item.kind === 'user' ? item.seq : item.kind === 'turn' ? item.firstSeq : undefined;
    if (address !== undefined && address > seq) break;
    kept.push(item);
  }

  return kept;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * The ack, which is also the reconciliation.
 *
 * Two sources describe the same sentence: the optimistic bubble this client
 * created, keyed on a `clientMessageId` only it has ever seen, and the stored
 * row the REST history returns, keyed on a row id only the server has ever
 * seen. `messageId` — the turn id — is the one value both carry, so this is
 * where they are joined.
 *
 * And it has to work in both orders, because both happen: the ack usually beats
 * the history fetch, and on a reload it does not. If storage has already
 * supplied the message, the optimistic bubble is dropped; otherwise it is
 * relabelled with the turn id so a fetch that lands later recognises it.
 */
function acknowledge(
  items: Transcript,
  messageId: string,
  clientMessageId: string | undefined,
): Transcript {
  const pending = items.findIndex(
    (item) => item.kind === 'user' && item.pending && item.clientMessageId === clientMessageId,
  );
  if (pending === -1) return items;

  const alreadyStored = items.some(
    (item, index) => index !== pending && item.kind === 'user' && item.turnId === messageId,
  );

  if (alreadyStored) return items.filter((_item, index) => index !== pending);

  const copy = [...items];
  const item = copy[pending];
  if (item?.kind !== 'user') return items;
  // The id is left alone: it is a React key, and the turn id already belongs to
  // the turn item this message started. Only the turn id and `pending` are news.
  copy[pending] = { ...item, turnId: messageId, pending: false };
  return copy;
}

function applyNotice(
  items: Transcript,
  message: Extract<ServerMessage, { type: 'notice' }>,
): Transcript {
  const id = `notice:${String(message.seq)}`;
  const notice: NoticePart = { kind: 'notice', id, notice: message.kind, message: message.message };

  if (message.turnId === undefined) {
    return [...items, { kind: 'notice', id, notice: message.kind, message: message.message }];
  }

  // A notice about a call goes in that call's card: a `prompt_injection`
  // warning rendered away from the output it describes is a warning about
  // nothing in particular.
  if (message.callId !== undefined) {
    return updateTool(items, message.turnId, message.callId, (tool) => ({
      ...tool,
      notices: [...tool.notices, notice],
    }));
  }

  return updateTurn(items, message.turnId, (turn) => ({
    ...turn,
    parts: [...turn.parts, { ...notice, id: `${turn.id}#${String(turn.parts.length)}` }],
  }));
}

/**
 * Appends a delta to the trailing part of its kind, or opens a new one.
 *
 * "Trailing" and not "any": a model that writes, calls a tool, then writes again
 * produces two text parts, and merging the second into the first would render
 * the tool card after text it came before.
 */
function appendText(
  items: Transcript,
  turnId: string,
  kind: 'text' | 'reasoning',
  text: string,
): Transcript {
  if (text === '') return items;

  return updateTurn(items, turnId, (turn) => {
    const last = turn.parts.at(-1);
    if (last?.kind === kind) {
      return {
        ...turn,
        parts: [...turn.parts.slice(0, -1), { ...last, text: last.text + text }],
      };
    }

    return {
      ...turn,
      parts: [...turn.parts, { kind, id: `${turn.id}#${String(turn.parts.length)}`, text }],
    };
  });
}

/**
 * Applies `update` to a turn, creating it if this is the first frame seen of it.
 *
 * The creation path is not defensive padding: a tab that connects mid-turn and
 * resumes from the ring receives deltas for a `turn.start` that fell outside the
 * buffer. Dropping them would render an empty turn.
 */
function updateTurn(
  items: Transcript,
  turnId: string,
  update: (turn: TurnItem) => TurnItem,
): Transcript {
  const index = items.findLastIndex((item) => item.kind === 'turn' && item.id === turnId);

  if (index === -1) {
    return [...items, update(orphanTurn(turnId))];
  }

  const turn = items[index];
  if (turn?.kind !== 'turn') return items;

  const next = update(turn);
  if (next === turn) return items;

  const copy = [...items];
  copy[index] = next;
  return copy;
}

function updateTool(
  items: Transcript,
  turnId: string,
  callId: string,
  update: (tool: ToolPart) => ToolPart,
): Transcript {
  return updateTurn(items, turnId, (turn) => {
    const tool = findTool(turn, callId);
    // A result for a call this client never saw. It happens on a resume that
    // landed between the call and the result, and an empty card is better than
    // an output with no name on it.
    const target =
      tool ??
      ({
        kind: 'tool',
        id: callId,
        name: 'tool',
        args: undefined,
        risk: 'safe',
        status: 'running',
        elapsedMs: 0,
        durationMs: undefined,
        content: undefined,
        truncated: false,
        approval: undefined,
        notices: [],
      } satisfies ToolPart);

    const next = update(target);
    return tool === undefined
      ? { ...turn, parts: [...turn.parts, next] }
      : { ...turn, parts: turn.parts.map((part) => (part === tool ? next : part)) };
  });
}

function findTool(turn: TurnItem, callId: string): ToolPart | undefined {
  for (const part of turn.parts) {
    if (part.kind === 'tool' && part.id === callId) return part;
  }
  return undefined;
}

function orphanTurn(turnId: string): TurnItem {
  return {
    kind: 'turn',
    id: turnId,
    model: '',
    provider: '',
    parts: [],
    stopReason: undefined,
    usage: undefined,
    iterations: 0,
    elapsedMs: undefined,
    firstSeq: undefined,
    lastSeq: undefined,
    done: false,
    failure: undefined,
  };
}

/** The turn being built, appended if the last item is not already it. */
function openTurn(items: TranscriptItem[], turnId: string): TurnItem {
  const last = items.at(-1);
  if (last?.kind === 'turn' && last.id === turnId) return last;

  const turn: TurnItem = { ...orphanTurn(turnId), done: true };
  items.push(turn);
  return turn;
}

function replaceLast(items: TranscriptItem[], item: TranscriptItem): void {
  items[items.length - 1] = item;
}

function textOf(content: readonly ContentPart[]): string {
  return content.map((part) => (part.type === 'text' ? part.text : '')).join('');
}

/**
 * Image parts become attachment chips.
 *
 * Only the `url` form: an inline base64 part is the same bytes the model got,
 * and re-embedding a megabyte of them in the transcript to draw a chip that
 * says "image" is a trade nobody wants.
 */
function attachmentsOf(content: readonly ContentPart[]): readonly Attachment[] {
  return content.flatMap((part) =>
    part.type === 'image' && part.url !== undefined ? [{ type: part.mimeType, url: part.url }] : [],
  );
}

/** Models emit malformed JSON often enough that this cannot be a `JSON.parse`. */
function parseArgs(argumentsJson: string): unknown {
  try {
    return JSON.parse(argumentsJson);
  } catch {
    return argumentsJson;
  }
}
