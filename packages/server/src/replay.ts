/**
 * The per-session replay ring.
 *
 * A tab that refreshes mid-turn has to come back to the turn it left, not to a
 * blank transcript with a spinner nobody will ever clear. The server therefore
 * keeps the last `server.replayBufferSize` events it emitted for a session, and
 * a reconnecting client asks for everything after the last `seq` it rendered.
 *
 * Three properties are what make it usable, and each one is a decision:
 *
 *  - **It stores emitted events, not stored messages.** An in-flight turn has
 *    no persisted assistant message yet — its text exists only as deltas — so
 *    replaying from the session store would rebuild everything except the part
 *    the user is watching.
 *  - **It answers with a `complete` flag rather than a best guess.** Handing
 *    back a tail that starts at `lastSeq + 4` looks like a successful replay and
 *    silently loses three events. The gap is detectable here and nowhere else,
 *    so it is reported here.
 *  - **A client ahead of the buffer is a gap too.** After a restart the counter
 *    starts at zero again, and a client resuming at `seq 57` would otherwise be
 *    told it had missed nothing. Its history is gone; that is precisely the case
 *    `complete: false` exists for.
 *
 * A bounded array rather than a circular one with an index: the eviction is one
 * `splice` per push past the cap, against a JSON encode per message on the send
 * path. The difference is not measurable, and the index arithmetic is a place
 * for an off-by-one to hide.
 */

import type { ServerMessage } from '@ghostai/protocol';

/**
 * A server event that belongs to a session's replayable history.
 *
 * The complement of `UNSEQUENCED_SERVER_EVENTS` — `connected`, `pong` and
 * `error` are connection-level and carry no `seq`, so nothing can retain them
 * and nothing needs to.
 */
export type SequencedServerMessage = Extract<ServerMessage, { seq: number }>;

export interface ReplaySlice {
  /** Everything retained after `lastSeq`, in emission order. */
  readonly messages: readonly SequencedServerMessage[];
  /** False when the buffer could not account for every `seq` after `lastSeq`. */
  readonly complete: boolean;
}

export class ReplayBuffer {
  private readonly maxEntries: number;
  private readonly entries: SequencedServerMessage[] = [];
  /**
   * The highest `seq` ever pushed, tracked separately from the entries.
   *
   * A buffer sized zero retains nothing but still has to be able to say whether
   * a resuming client missed anything, and after enough pushes the entries no
   * longer remember where the sequence started.
   */
  private lastAppendedSeq = 0;

  constructor(capacity: number) {
    this.maxEntries = Math.max(0, Math.trunc(capacity));
  }

  get capacity(): number {
    return this.maxEntries;
  }

  get size(): number {
    return this.entries.length;
  }

  /** The highest `seq` emitted for this session, retained or not. */
  get lastSeq(): number {
    return this.lastAppendedSeq;
  }

  push(message: SequencedServerMessage): void {
    this.lastAppendedSeq = message.seq;
    if (this.maxEntries === 0) return;
    this.entries.push(message);
    const excess = this.entries.length - this.maxEntries;
    if (excess > 0) this.entries.splice(0, excess);
  }

  /**
   * What a client resuming at `lastSeq` still needs.
   *
   * `complete` answers one question — "is what follows the whole gap?" — and
   * the caller decides what to do about a `false`. It is not the same as
   * `messages.length > 0`: a client that has already seen everything gets an
   * empty, complete slice.
   */
  after(lastSeq: number): ReplaySlice {
    if (lastSeq >= this.lastAppendedSeq) {
      // Equal means nothing was missed. Greater means this client saw a
      // sequence this buffer never emitted — a restart, or a different server.
      return { messages: [], complete: lastSeq === this.lastAppendedSeq };
    }

    const messages = this.entries.filter((entry) => entry.seq > lastSeq);
    return { messages, complete: messages[0]?.seq === lastSeq + 1 };
  }

  clear(): void {
    this.entries.length = 0;
  }
}
