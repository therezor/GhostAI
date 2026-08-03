/**
 * Which agent runs a turn.
 *
 * A rule rather than a lookup, and it lived inside the WebSocket hub — sixty
 * lines of domain policy in a file whose other job is framing and queueing.
 * Here it is a pure function of three inputs, so the rule can be read, and
 * tested, without a socket, a store or a session.
 */

/**
 * Picks the agent a turn runs on.
 *
 * The **stored session wins**, exactly as its workspace does. A history built
 * under one agent's prompt, tools and permissions must not silently continue
 * under another's, so a frame naming an agent can only ever decide the binding
 * of a session that does not exist yet. Moving an existing one is an explicit
 * `PATCH /api/sessions/:key`.
 *
 * `AgentLoop.ensureSession` applies the same rule to the prompt one layer down.
 * This is the same decision made earlier, because *which loop* runs the turn
 * has to agree with what that loop then puts in the prompt.
 *
 * One exception, and only one: a stored id that **no longer resolves** loses to
 * a frame that names an agent which does. The rule above protects a
 * conversation from being continued under settings it was not built with, and
 * an agent that has been deleted offers no such settings to protect — so the
 * only thing outranking the operator's explicit pick would achieve is dropping
 * them onto `default` while they watched themselves choose something else.
 *
 * When neither resolves, the stored id is returned so the notice that follows
 * names what the conversation actually claims rather than whatever the last
 * frame happened to carry.
 */
export function agentForTurn(options: {
  /** The id on the session row, if it has one. */
  readonly stored: string | undefined;
  /** The id the incoming frame named, if it named one. */
  readonly requested: string | undefined;
  /** Whether an id still names a configured agent. */
  readonly resolves: (agentId: string) => boolean;
}): string | undefined {
  const { stored, requested, resolves } = options;
  if (stored === undefined || stored === '') return requested;
  if (resolves(stored)) return stored;
  if (requested !== undefined && resolves(requested)) return requested;
  return stored;
}
