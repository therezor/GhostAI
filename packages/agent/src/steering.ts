/**
 * Mid-turn steering.
 *
 * A turn that calls tools can run for minutes, and for most of that time the
 * user is watching it do the wrong thing. Steering is the answer: what they
 * type lands in this queue, the loop drains it at the top of the next iteration
 * and appends it to history as a user message, and the model sees the
 * correction before its next decision.
 *
 * Two details make it work rather than merely exist:
 *
 *  - **Drained at the top of the iteration, not at the point of arrival.** The
 *    loop is inside a provider request or a tool call for nearly all of its
 *    wall-clock time, and neither can absorb a new message. The queue is what
 *    holds the gap.
 *  - **A steering message that arrives while the model is composing its final
 *    answer makes the loop `continue` rather than `break`.** Otherwise the turn
 *    ends, the queue is discarded, and the user's correction is answered by
 *    silence — the failure is invisible, because from the outside a completed
 *    turn looks like a completed turn.
 *
 * The queue is keyed by session because one loop serves every session on the
 * instance, and a correction typed into one conversation must not surface in
 * another.
 */

import { silentLogger, type Logger } from '@ghostai/core';

/**
 * Marks the message as an interruption rather than the next thing the user
 * said.
 *
 * Without it the model reads a mid-task user turn as a new request and
 * frequently abandons what it was doing; with it, the common case — "no, the
 * other directory" — is understood as a correction to the task in flight.
 */
export const STEERING_PREFIX = '[Steering — sent by the user while this task was running]';

/**
 * How many pending messages one session may hold.
 *
 * A bound rather than a courtesy: the queue fills from a socket and drains from
 * a loop that may be blocked in a slow tool, so without one a client that sends
 * faster than the loop iterates grows it without limit.
 */
export const MAX_PENDING_STEER = 16;

export interface SteeringMessage {
  readonly content: string;
  /** Wall-clock epoch milliseconds, from the caller's clock. */
  readonly receivedAtMs: number;
}

export interface SteeringQueueOptions {
  readonly maxPending?: number;
  readonly logger?: Logger;
}

export class SteeringQueue {
  readonly #queues = new Map<string, SteeringMessage[]>();
  readonly #maxPending: number;
  readonly #logger: Logger;

  constructor(options: SteeringQueueOptions = {}) {
    this.#maxPending = options.maxPending ?? MAX_PENDING_STEER;
    this.#logger = options.logger ?? silentLogger;
  }

  /**
   * Queues a message for the next iteration of `sessionKey`'s turn.
   *
   * Overflow drops the *oldest* pending message. The newest correction is the
   * one the user is waiting on; discarding it to preserve a stale one inverts
   * the point of steering.
   */
  push(sessionKey: string, content: string, receivedAtMs: number): void {
    const queue = this.#queues.get(sessionKey) ?? [];
    queue.push({ content, receivedAtMs });
    while (queue.length > this.#maxPending) {
      queue.shift();
      this.#logger.warn(
        { sessionKey, maxPending: this.#maxPending },
        'steering queue full, dropped oldest message',
      );
    }
    this.#queues.set(sessionKey, queue);
  }

  /** Whether anything is waiting. Checked before the loop decides to end a turn. */
  hasPending(sessionKey: string): boolean {
    return (this.#queues.get(sessionKey)?.length ?? 0) > 0;
  }

  /** Takes everything queued for the session and empties it. */
  drain(sessionKey: string): readonly SteeringMessage[] {
    const queue = this.#queues.get(sessionKey);
    if (queue === undefined || queue.length === 0) return [];
    this.#queues.delete(sessionKey);
    return queue;
  }

  /** Forgets a session's queue. The loop calls this when a turn ends. */
  clear(sessionKey: string): void {
    this.#queues.delete(sessionKey);
  }

  /** Sessions currently holding pending messages. */
  get size(): number {
    return this.#queues.size;
  }
}

/** The prefixed text as it enters history. */
export function steeringText(message: SteeringMessage): string {
  return `${STEERING_PREFIX}\n\n${message.content}`;
}
