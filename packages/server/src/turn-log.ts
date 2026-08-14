/**
 * The turn that is running, kept whole.
 *
 * The replay ring beside this one answers "what did I miss since `seq`", and it
 * answers it for the session — bounded by a frame count, because that is the
 * right shape for a question about arbitrary history. It is the wrong shape for
 * the other question a reload asks, which is "what has this turn done so far":
 * a turn spends one frame per token, and a delegation spends one per token of
 * its subagent too, so any real answer overruns a frame budget in seconds. Past
 * the ring the server could only offer the stored tail, and storage cannot hold
 * a turn that has not ended — so the answer on screen after a refresh was the
 * remainder of the turn and nothing before it.
 *
 * This holds the running turn instead, from its `turn.start`, and nothing else.
 * Three decisions make that affordable:
 *
 *  - **Adjacent deltas of the same part are merged.** A hundred thousand tokens
 *    of answer is one entry holding one string, so the log is the size of the
 *    turn's *output*, not of its frame count. This is the whole reason a
 *    complete in-flight turn can be retained at all, and it is exactly what the
 *    client does with the same frames when it renders them.
 *  - **The budget is bytes.** Frames are free after merging; tool output is not.
 *    A turn that reads fifty large files is the shape that reaches the cap, and
 *    a turn that writes for ten minutes is not, which no frame count can tell
 *    apart.
 *  - **Over budget it drops everything and says so.** A half-log is worse than
 *    none: it looks like a turn that began in the middle. `complete` is false
 *    from then on, the hub falls back to the stored tail, and the memory goes
 *    back immediately rather than being held for an answer nobody can use.
 *
 * Only a session with an open turn holds one, so the ceiling on all of this is
 * the number of turns running at once, not the number of sessions in memory.
 */

import type { NestedAgentEvent, ServerMessage } from '@ghostwire/protocol';

import type { SequencedServerMessage } from './replay.js';

/**
 * The events that belong to a turn's own account of itself.
 *
 * An allowlist rather than "everything carrying a `turnId`", because two events
 * carry one without being part of the turn: `session.status` restates the
 * running turn on every attach, and a `notice` with no `turnId` is about the
 * session. Replaying either would raise a second toast for something the client
 * has already seen. `turn.end` is absent for a different reason — it closes the
 * log, and by the time it is emitted storage holds the turn.
 */
const RETAINED: ReadonlySet<ServerMessage['type']> = new Set([
  'turn.start',
  'assistant.delta',
  'reasoning.delta',
  'tool.call',
  'tool.progress',
  'tool.approvalRequest',
  'tool.result',
  'notice',
  'subagent.event',
]);

/**
 * Charged per entry on top of its payload, for the fields every frame carries.
 *
 * A round number rather than a measurement: the budget exists to stop a turn
 * holding an unreasonable amount of memory, and being out by a few bytes per
 * entry cannot change whether it does.
 */
const ENTRY_OVERHEAD = 64;

export class TurnLog {
  private readonly budget: number;
  private entries: SequencedServerMessage[] = [];
  private turn: string | undefined;
  private bytes = 0;
  /**
   * Whether this still holds every frame since `turn.start`.
   *
   * Separate from `entries.length > 0`, because an empty log is the honest state
   * of a turn that has emitted only its start — and a *dropped* log is empty
   * too. Only this tells the two apart.
   */
  private retaining = false;
  private lastKey: string | undefined;

  constructor(maxBytes: number) {
    this.budget = Math.max(0, Math.trunc(maxBytes));
  }

  /** The turn this is holding, or `undefined` between turns. */
  get openTurnId(): string | undefined {
    return this.turn;
  }

  /** True when the frames below are the whole of the open turn. */
  get complete(): boolean {
    return this.turn !== undefined && this.retaining;
  }

  get size(): number {
    return this.entries.length;
  }

  /** Approximately how much is being held, in bytes. */
  get retainedBytes(): number {
    return this.bytes;
  }

  /** The open turn's frames, in emission order. */
  frames(): readonly SequencedServerMessage[] {
    return this.entries;
  }

  push(message: SequencedServerMessage): void {
    if (message.type === 'turn.start') this.begin(message.turnId);
    if (this.turn === undefined) return;

    if (message.type === 'turn.end') {
      // Only the open turn's ending closes it. A `turn.end` for another turn is
      // not something this hub emits, but reacting to one would silently throw
      // away the log of the turn that is still running.
      if (message.turnId === this.turn) this.clear();
      return;
    }

    if (!this.retaining) return;
    if (!RETAINED.has(message.type)) return;
    if (turnIdOf(message) !== this.turn) return;

    this.append(message);
  }

  /** Forgets the open turn — it ended, or the conversation moved under it. */
  clear(): void {
    this.turn = undefined;
    this.retaining = false;
    this.entries = [];
    this.bytes = 0;
    this.lastKey = undefined;
  }

  private begin(turnId: string): void {
    this.clear();
    this.turn = turnId;
    this.retaining = this.budget > 0;
  }

  private append(message: SequencedServerMessage): void {
    const key = mergeableKey(message);
    const previous = this.entries.at(-1);

    if (key !== undefined && key === this.lastKey && previous !== undefined) {
      const merged = concatDelta(previous, message);
      if (merged !== undefined) {
        this.entries[this.entries.length - 1] = merged;
        // The *later* seq, deliberately. A client's cursor is the highest seq it
        // has applied, so an entry that reported the first seq of the run it
        // merged would leave the cursor behind the frames it had rendered — and
        // the next resume would re-send text already on screen.
        this.charge(payloadSize(message));
        return;
      }
    }

    this.lastKey = key;
    this.entries.push(message);
    this.charge(payloadSize(message) + ENTRY_OVERHEAD);
  }

  private charge(bytes: number): void {
    this.bytes += bytes;
    if (this.bytes > this.budget) this.overflow();
  }

  /**
   * Past the budget: hold nothing, and stay honest about it for this turn.
   *
   * The entries go immediately rather than at the next `turn.start`, because the
   * reason to stop retaining is that the memory is wanted back.
   */
  private overflow(): void {
    this.retaining = false;
    this.entries = [];
    this.bytes = 0;
    this.lastKey = undefined;
  }
}

/**
 * What a run of deltas has to agree on to be one entry.
 *
 * The scope, not just the kind: a turn's own text and its subagent's are two
 * streams arriving interleaved, and merging across them would splice one into
 * the other. `parentSessionKey` + `parentCallId` names a delegation at any
 * depth, which is the same address the client uses to place the frames.
 *
 * `undefined` for anything that is not a delta, which never merges.
 */
function mergeableKey(message: SequencedServerMessage): string | undefined {
  if (
    message.type === 'assistant.delta' ||
    message.type === 'reasoning.delta'
  ) {
    return `turn:${message.type}`;
  }
  if (message.type !== 'subagent.event') return undefined;

  const inner = message.event;
  if (inner.type !== 'assistant.delta' && inner.type !== 'reasoning.delta') {
    return undefined;
  }
  return `sub:${message.parentSessionKey}:${message.parentCallId}:${inner.type}`;
}

/** Two adjacent deltas as one frame, or `undefined` if they are not both. */
function concatDelta(
  previous: SequencedServerMessage,
  next: SequencedServerMessage,
): SequencedServerMessage | undefined {
  if (
    (previous.type === 'assistant.delta' ||
      previous.type === 'reasoning.delta') &&
    (next.type === 'assistant.delta' || next.type === 'reasoning.delta')
  ) {
    return { ...previous, text: previous.text + next.text, seq: next.seq };
  }

  if (previous.type !== 'subagent.event' || next.type !== 'subagent.event') {
    return undefined;
  }
  const before = previous.event;
  const after = next.event;
  if (
    (before.type !== 'assistant.delta' && before.type !== 'reasoning.delta') ||
    (after.type !== 'assistant.delta' && after.type !== 'reasoning.delta')
  ) {
    return undefined;
  }
  return {
    ...previous,
    seq: next.seq,
    event: { ...before, text: before.text + after.text },
  };
}

function turnIdOf(message: SequencedServerMessage): string | undefined {
  return 'turnId' in message ? message.turnId : undefined;
}

/**
 * Roughly what one frame costs, without serialising it.
 *
 * Every case measures the one field that can be large and ignores the ids and
 * enums around it, which `ENTRY_OVERHEAD` covers instead. `JSON.stringify` is
 * reached only for a tool call's arguments — once per call, never per token —
 * because a `write_file` carries its whole file there and nothing else on the
 * frame reveals the size.
 */
function payloadSize(event: ServerMessage | NestedAgentEvent): number {
  switch (event.type) {
    case 'assistant.delta':
    case 'reasoning.delta':
      return event.text.length;
    case 'tool.result':
      return event.content.length;
    case 'tool.call':
    case 'tool.approvalRequest':
      return jsonSize(event.args);
    case 'notice':
      return event.message.length;
    case 'subagent.event':
      return payloadSize(event.event);
    default:
      return 0;
  }
}

function jsonSize(value: unknown): number {
  if (typeof value === 'string') return value.length;
  if (value === undefined || value === null) return 0;
  try {
    return JSON.stringify(value).length;
  } catch {
    // A value that cannot be serialised is not one this log can measure, and a
    // guess is better than a throw on the emit path.
    return 0;
  }
}
