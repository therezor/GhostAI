/**
 * The approval gate a connected client answers.
 *
 * Step 10 split the decision in two: the loop decides *whether to ask*, which
 * is a pure function of the tool's risk band and the deployment's policy, and
 * the gate decides *what the answer is* and how long it holds. This is the
 * second half for anything with a socket attached — the web UI, and every
 * channel that bridges through the hub.
 *
 * The whole of it is a map of parked promises. The loop yields
 * `tool.approvalRequest` as an ordinary event, the hub forwards it like every
 * other event, and the answer arrives later as an inbound `tool.approve` frame
 * naming the same `callId`. Nothing here sends anything, which is what keeps
 * the gate usable from a channel that renders an approval as two buttons in a
 * chat app rather than as a card in a browser.
 *
 * The decisions that are not obvious:
 *
 *  - **A remembered answer is keyed by tool name, not by arguments.** That is
 *    what `session` and `always` mean, and a memory keyed by arguments would be
 *    a cache nobody can predict. It is also why the UI has to say what it is
 *    asking for: approving `exec` for the session approves the *next* `exec`
 *    too, whatever it turns out to be.
 *  - **A refusal is remembered exactly like an approval.** "No, and stop
 *    asking" is a thing users mean, and a scope that only ever widened
 *    permission would be a scope that only works in one direction.
 *  - **The deadline is enforced here as well as in the loop.** The loop's copy
 *    stops the *turn* waiting; this one stops the *map* growing. A prompt whose
 *    tab was closed has nothing left to answer it, and an entry nobody will
 *    ever resolve is a leak the loop cannot see.
 *  - **Cancellation resolves, it does not reject.** The loop already stopped
 *    racing this promise when the signal fired; rejecting into a handler that
 *    may no longer be attached converts a cancelled turn into an unhandled
 *    rejection. A denial nobody reads is harmless.
 *
 * `always` is remembered for the lifetime of the process and no longer. A
 * durable "never ask me about this tool again" is a settings write, and the
 * settings route does not exist yet — a decision persisted through a path
 * nothing can revoke would be worse than one that expires with the server.
 */

import { silentLogger, systemClock, type Clock, type Logger } from '@ghostai/core';
import type { ApprovalDecision, ApprovalGate, ApprovalRequest } from '@ghostai/agent';
import type { ApprovalScope } from '@ghostai/protocol';

/** What a client answered, kept past the call that produced it. */
interface RememberedDecision {
  readonly approved: boolean;
  readonly scope: ApprovalScope;
}

interface PendingApproval {
  readonly request: ApprovalRequest;
  /** Settles the parked promise exactly once and unhooks the timer and signal. */
  readonly settle: (decision: ApprovalDecision) => void;
}

export interface HubApprovalGateOptions {
  readonly clock?: Clock;
  readonly logger?: Logger;
}

export class HubApprovalGate implements ApprovalGate {
  readonly #clock: Clock;
  readonly #logger: Logger;
  /** Parked promises, keyed by the tool call the client will name in its answer. */
  readonly #pending = new Map<string, PendingApproval>();
  /** `session` scope: session key → tool name → decision. */
  readonly #bySession = new Map<string, Map<string, RememberedDecision>>();
  /**
   * `always` scope: agent id → tool name → decision, across every session.
   *
   * Keyed by agent rather than by tool alone, and that is a security boundary
   * rather than bookkeeping. Two agents can be configured with deliberately
   * different tool sets and approval policies; a standing "always allow `exec`"
   * granted while using a permissive agent would otherwise pre-approve it for a
   * locked-down one, silently undoing the restriction an operator set up.
   * "Always" means for this agent, on every session, until the process ends.
   */
  readonly #always = new Map<string, Map<string, RememberedDecision>>();

  constructor(options: HubApprovalGateOptions = {}) {
    this.#clock = options.clock ?? systemClock;
    this.#logger = options.logger ?? silentLogger;
  }

  /**
   * Which session a `session`-scoped answer belongs to.
   *
   * The conversation, not the turn's own session — those differ when the turn
   * is a subagent's, because a subagent gets a session that exists for the
   * length of one delegation. Scoping to *that* would make "this session" mean
   * "once", which is not what the button says: the operator is looking at their
   * conversation when they press it, and the conversation is what they meant.
   *
   * It is also what makes `clearSession` on a conversation settle a prompt its
   * subagent parked, rather than leaving one behind for a session that has gone.
   */
  static #scopeOf(request: ApprovalRequest): string {
    return request.rootSessionKey ?? request.sessionKey;
  }

  /** Calls waiting on an answer. A leak assertion, and a status field. */
  get pendingCount(): number {
    return this.#pending.size;
  }

  async request(request: ApprovalRequest): Promise<ApprovalDecision> {
    const remembered = this.#recall(
      HubApprovalGate.#scopeOf(request),
      request.agentId,
      request.name,
    );
    if (remembered !== undefined) {
      this.#logger.debug(
        { sessionKey: request.sessionKey, tool: request.name, scope: remembered.scope },
        'approval answered from memory',
      );
      return remembered;
    }

    // A turn already cancelled has nobody left to show a prompt to. Parking one
    // would rely on the abort listener below firing for an event that already
    // happened, which it never does.
    if (request.signal.aborted) return { approved: false, reason: 'the turn was cancelled' };

    // A `callId` is the model's, so a collision is not impossible. The older
    // prompt is the one nothing will answer — its turn has moved on.
    this.#pending
      .get(request.callId)
      ?.settle({ approved: false, reason: 'superseded by another call with the same id' });

    return await new Promise<ApprovalDecision>((resolve) => {
      const onAbort = (): void => {
        settle({ approved: false, reason: 'the turn was cancelled' });
      };

      // Declared before the timer it clears and after the listener it removes:
      // neither is read until this runs, which is never before both exist.
      const settle = (decision: ApprovalDecision): void => {
        this.#clock.clearTimeout(timer);
        request.signal.removeEventListener('abort', onAbort);
        this.#pending.delete(request.callId);
        resolve(decision);
      };

      const timer = this.#clock.setTimeout(
        () => {
          this.#logger.warn(
            { sessionKey: request.sessionKey, tool: request.name, callId: request.callId },
            'approval request expired unanswered',
          );
          settle({ approved: false, reason: 'the approval request expired' });
        },
        // A deadline already past fires on the next tick rather than never: the
        // loop hands this a wall-clock instant, and a clock that has moved is
        // not a reason to wait forever.
        Math.max(0, request.expiresAtMs - this.#clock.now()),
      );

      request.signal.addEventListener('abort', onAbort, { once: true });
      this.#pending.set(request.callId, { request, settle });
    });
  }

  /**
   * Answers a parked request. Returns whether anything was waiting.
   *
   * A `false` is the normal two-tab race — the second answer arrives after the
   * first has already released the call — and is not an error. The caller logs
   * it and sends nothing back, because there is no client-visible difference
   * between "you were second" and "it worked".
   */
  resolve(callId: string, approved: boolean, scope: ApprovalScope): boolean {
    const pending = this.#pending.get(callId);
    if (pending === undefined) return false;

    this.#remember(
      HubApprovalGate.#scopeOf(pending.request),
      pending.request.agentId,
      pending.request.name,
      { approved, scope },
    );
    this.#logger.info(
      { sessionKey: pending.request.sessionKey, tool: pending.request.name, approved, scope },
      'approval answered',
    );
    pending.settle({ approved, scope });
    return true;
  }

  /**
   * Forgets a session: its remembered answers, and any prompt still parked.
   *
   * Called when the hub drops a session, which is the moment nothing can answer
   * for it any more. `always` survives — it was scoped to an agent, not to a
   * session.
   *
   * Matched against the *scope* rather than the request's own session, so a
   * prompt parked by a subagent of this conversation is settled too. It is the
   * same reasoning as the memory above: the operator watching that prompt was
   * watching this conversation, and closing it is what took the answer away.
   */
  clearSession(sessionKey: string): void {
    this.#bySession.delete(sessionKey);
    for (const pending of [...this.#pending.values()]) {
      if (HubApprovalGate.#scopeOf(pending.request) !== sessionKey) continue;
      pending.settle({ approved: false, reason: 'the session was closed' });
    }
  }

  #recall(sessionKey: string, agentId: string, tool: string): RememberedDecision | undefined {
    // The session's own answer wins over the standing one: it is the more
    // specific of the two, and the more recently given. A session is bound to
    // one agent, so the session-scoped map needs no agent dimension — and a
    // subagent's turn carries its own `agentId`, so the standing half stays
    // per-agent even though the session half is the conversation's.
    return this.#bySession.get(sessionKey)?.get(tool) ?? this.#always.get(agentId)?.get(tool);
  }

  #remember(sessionKey: string, agentId: string, tool: string, decision: RememberedDecision): void {
    if (decision.scope === 'once') return;
    if (decision.scope === 'always') {
      const agent = this.#always.get(agentId) ?? new Map<string, RememberedDecision>();
      agent.set(tool, decision);
      this.#always.set(agentId, agent);
      return;
    }
    const session = this.#bySession.get(sessionKey) ?? new Map<string, RememberedDecision>();
    session.set(tool, decision);
    this.#bySession.set(sessionKey, session);
  }
}
